import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { startFixture, makeVin } from './fixture-site.mjs';
import { runCrawl, crawlPolicy, validateRequest, BadRequest } from '../src/crawl.mjs';
import { createServer } from '../src/server.mjs';
import { checkUrl, isPrivateIp, UrlRefused } from '../src/ssrf.mjs';
import { parsePrice, parseMileage, vinChecksumValid, extractVehicle, extractGeneric } from '../src/extract.mjs';

const policy = crawlPolicy({ CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_MAX_SECONDS: '60' });

test('normalizers handle common formats', () => {
  assert.equal(parsePrice('$32,995'), 32995);
  assert.equal(parsePrice('32995 USD'), 32995);
  assert.equal(parsePrice('Call for price'), null);
  assert.equal(parseMileage('32.9k mi'), 32900);
  assert.equal(parseMileage({ value: 41000 }), 41000);
  assert.ok(vinChecksumValid(makeVin(3)));
  assert.equal(vinChecksumValid('1HGCM82633A00435X'), false);
});

test('ssrf guard refuses private, odd-port and non-http targets', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', '::ffff:10.0.0.1', 'fd00::1', '100.64.0.1']) assert.ok(isPrivateIp(ip), ip);
  assert.equal(isPrivateIp('93.184.216.34'), false);
  const reason = async (u, pol = {}, res) => { try { await checkUrl(u, pol, res); return 'ok'; } catch (e) { assert.ok(e instanceof UrlRefused); return e.reason; } };
  assert.equal(await reason('file:///etc/passwd'), 'scheme_not_allowed');
  assert.equal(await reason('http://169.254.169.254/latest'), 'private_address');
  assert.equal(await reason('http://localhost/'), 'private_host');
  assert.equal(await reason('https://example.com:8080/'), 'port_not_allowed');
  assert.equal(await reason('https://user:pw@example.com/'), 'credentials_in_url');
  assert.equal(await reason('https://rebind.test/', {}, async () => [{ address: '10.0.0.5' }]), 'private_address');
  assert.equal(await reason('https://public.test/', {}, async () => [{ address: '93.184.216.34' }]), 'ok');
});

test('request validation caps sizes', () => {
  assert.throws(() => validateRequest({}, policy), BadRequest);
  assert.throws(() => validateRequest({ start_urls: ['http://a'], max_pages: 10_000 }, policy), BadRequest);
  assert.throws(() => validateRequest({ start_urls: ['http://a'], profile: 'x' }, policy), BadRequest);
  assert.equal(validateRequest({ url: 'http://a' }, policy).max_pages, 50);
});

test('vehicle crawl of fixture: all markup styles, sold, call-for-price, duplicate, robots, off-site', async t => {
  const { server, inv, base } = await startFixture();
  t.after(() => server.close());
  const out = await runCrawl({ start_urls: [base + '/inventory'], mode: 'crawl', profile: 'vehicle', include_patterns: [base + "/inventory/*"], max_pages: 40, max_depth: 3 }, policy);
  assert.equal(out.stats.records, inv.length, JSON.stringify(out.stats));
  assert.equal(out.stats.duplicates, 1);
  assert.ok(!out.records.some(r => r.listing_url.includes('/private/')));
  let correct = 0, total = 0;
  for (const truth of inv) {
    const rec = out.records.find(r => r.listing_url.endsWith('/inventory/' + truth.id));
    assert.ok(rec, 'missing listing ' + truth.id);
    for (const f of ['vin', 'year', 'make', 'model', 'trim', 'price', 'mileage', 'exterior_color', 'status']) {
      total++; if (rec[f] === truth[f]) correct++; else t.diagnostic(`#${truth.id} ${truth.style} ${f}: got ${rec[f]} want ${truth[f]}`);
    }
  }
  const acc = correct / total; t.diagnostic(`field accuracy ${(acc * 100).toFixed(1)}% (${correct}/${total}) in ${out.stats.seconds}s`);
  assert.ok(acc >= 0.98, 'accuracy ' + acc);
  const cfp = out.records.find(r => r.listing_url.endsWith('/inventory/6'));
  assert.deepEqual(cfp.missing_required, ['price']);
  assert.ok(out.records.filter(r => r.vin).every(r => r.vin_checksum_valid));
  assert.equal(out.records.find(r => r.listing_url.endsWith('/inventory/1')).extractor.vin, 'jsonld');
  assert.equal(out.records.find(r => r.listing_url.endsWith('/inventory/2')).extractor.vin, 'microdata');
  assert.equal(out.records.find(r => r.listing_url.endsWith('/inventory/3')).extractor.vin, 'selector');
});

test('crawl stops at max_pages and reports the page limit', async t => {
  const { server, base } = await startFixture({ duplicate: false });
  t.after(() => server.close());
  const fetched = [];
  server.on('request', req => { if (req.url !== '/robots.txt') fetched.push(req.url); });
  const out = await runCrawl({ start_urls: [base + '/inventory'], max_pages: 3, concurrency: 1 }, policy);
  assert.equal(fetched.length, 3);
  assert.equal(out.stats.pages_fetched, 3);
  assert.equal(out.records.length, 3);
  assert.deepEqual(out.failures, []);
  assert.equal(out.stats.stopped, 'max_pages');
});

test('crawl stops at the time budget and reports it instead of the page limit', { timeout: 10_000 }, async t => {
  const { server, base } = await startFixture({ duplicate: false, delayMs: 250 });
  t.after(() => server.close());
  const fetched = [];
  server.on('request', req => { if (req.url !== '/robots.txt') fetched.push(req.url); });
  const shortPolicy = crawlPolicy({ CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_MAX_SECONDS: '0.1' });
  const out = await runCrawl({ start_urls: [base + '/inventory'], max_pages: 3, concurrency: 1 }, shortPolicy);
  // Stopping is graceful: a page already in flight may finish, but queued pages must not start.
  assert.ok(fetched.length <= 1, JSON.stringify(fetched));
  assert.ok(out.stats.pages_fetched <= 1, JSON.stringify(out.stats));
  assert.equal(out.records.length, out.stats.pages_fetched);
  assert.deepEqual(out.failures, []);
  assert.ok(out.stats.seconds >= shortPolicy.maxSeconds);
  assert.equal(out.stats.stopped, 'time_budget');
});

test('sitemap mode reaches every listing without following links', async t => {
  const { server, inv, base } = await startFixture({ duplicate: false });
  t.after(() => server.close());
  const out = await runCrawl({ start_urls: [base + '/'], mode: 'sitemap', profile: 'vehicle', max_pages: 50 }, policy);
  assert.equal(out.stats.records, inv.length);
  assert.equal(out.stats.stopped, null);
});

test('generic profile returns title, text and product fields', () => {
  const $ = load('<html><head><title>T</title><script type="application/ld+json">{"@type":"Product","name":"Widget","sku":"W1","offers":{"price":"19.99","priceCurrency":"GBP","availability":"https://schema.org/InStock"}}</script></head><body><main><p>Hello   world</p></main></body></html>');
  const r = extractGeneric($, 'https://shop.test/w');
  assert.equal(r.product.price, 19.99); assert.equal(r.product.currency, 'GBP'); assert.equal(r.product.availability, 'available');
  assert.equal(r.text, 'Hello world');
});

test('HTTP server: auth, validation, busy and crawl', async t => {
  const { server: fx, base } = await startFixture({ n: 3, duplicate: false });
  const env = { CRAWL_TOKEN: 'x'.repeat(32), CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1' };
  const srv = createServer({ env }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.close(); fx.close(); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (body, auth = 'Bearer ' + 'x'.repeat(32)) => fetch(url + '/v1/crawl', { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) });
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.equal((await post({}, 'Bearer wrong')).status, 401);
  assert.equal((await post({ start_urls: [] })).status, 400);
  const refused = await post({ start_urls: ['http://169.254.169.254/'] });
  assert.equal(refused.status, 400); assert.equal((await refused.json()).reason, 'private_address');
  const ok = await post({ start_urls: [base + '/inventory'], profile: 'vehicle', include_patterns: [base + "/inventory/*"] });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).stats.records, 3);
});
