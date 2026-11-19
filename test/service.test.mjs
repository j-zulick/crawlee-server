import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
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

test('sitemap mode follows a sitemap index to child sitemaps without following page links', async t => {
  const children = new Map([
    ['/sitemap-a.xml', ['/pages/1', '/pages/2']],
    ['/sitemap-b.xml', ['/pages/3']],
  ]);
  const pages = [...children.values()].flat();
  const fetched = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    fetched.push(req.url);
    if (req.url === '/sitemap.xml' || children.has(req.url)) {
      const index = req.url === '/sitemap.xml';
      const tag = index ? 'sitemapindex' : 'urlset';
      const entry = index ? 'sitemap' : 'url';
      const paths = index ? [...children.keys()] : children.get(req.url);
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><${tag} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(p => `<${entry}><loc>http://${req.headers.host}${p}</loc></${entry}>`).join('')}</${tag}>`);
    }
    if (pages.includes(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><head><title>Page ${req.url}</title></head><body><a href="/not-in-sitemap">Other page</a></body></html>`);
    }
    res.writeHead(404); res.end();
  });
  t.after(() => server.close());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = await runCrawl({ start_urls: [base + '/'], mode: 'sitemap', max_pages: 10 }, policy);
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.records.map(r => r.url).sort(), pages.map(p => base + p).sort());
  assert.deepEqual(fetched.sort(), ['/sitemap.xml', ...children.keys(), ...pages].sort());
  assert.equal(out.stats.pages_fetched, pages.length);
  assert.equal(out.stats.stopped, null);
  assert.deepEqual(out.failures, []);
  assert.deepEqual(out.refused, []);
});

test('generic profile returns title, text and product fields', () => {
  const $ = load('<html><head><title>T</title><script type="application/ld+json">{"@type":"Product","name":"Widget","sku":"W1","offers":{"price":"19.99","priceCurrency":"GBP","availability":"https://schema.org/InStock"}}</script></head><body><main><p>Hello   world</p></main></body></html>');
  const r = extractGeneric($, 'https://shop.test/w');
  assert.equal(r.product.price, 19.99); assert.equal(r.product.currency, 'GBP'); assert.equal(r.product.availability, 'available');
  assert.equal(r.text, 'Hello world');
});

test('HTTP server: POST /v1/crawl rejects invalid requests before crawling', async t => {
  const token = 'x'.repeat(32);
  const crawl = t.mock.fn(async () => ({ status: 'ok' }));
  const srv = createServer({ env: { CRAWL_TOKEN: token }, crawl });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/v1/crawl`;
  const body = JSON.stringify({ start_urls: ['https://example.test/'] });
  const cases = [
    { name: 'missing bearer token', auth: null, status: 401, error: 'unauthorized' },
    { name: 'wrong bearer token', auth: 'Bearer wrong', status: 401, error: 'unauthorized' },
    { name: 'body over 64 KB', body: JSON.stringify({ padding: 'x'.repeat(64 * 1024) }), status: 413, error: 'body_too_large' },
    { name: 'non-JSON content type', type: 'text/plain', status: 415, error: 'json_required' },
    { name: 'invalid JSON', body: '{"start_urls":', status: 400, error: 'invalid_json' },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const headers = { 'content-type': c.type ?? 'application/json' };
      if (c.auth !== null) headers.authorization = c.auth ?? 'Bearer ' + token;
      const res = await fetch(url, { method: 'POST', headers, body: c.body ?? body });
      assert.equal(res.status, c.status);
      assert.deepEqual(await res.json(), { error: c.error });
      assert.equal(crawl.mock.callCount(), 0);
    });
  }
});

test('HTTP server: POST /v1/crawl returns 429 when the queue is full', { timeout: 10_000 }, async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const crawl = t.mock.fn(async () => { await gate; return { status: 'ok' }; });
  const srv = createServer({ env: { CRAWL_TOKEN: 'x'.repeat(32) }, crawl });
  const pending = [];
  t.after(async () => {
    release();
    await Promise.allSettled(pending);
    srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = () => fetch(url + '/v1/crawl', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'x'.repeat(32) },
    body: JSON.stringify({ start_urls: ['https://example.test/'] }),
    signal: AbortSignal.timeout(5_000),
  });
  // Hold one crawl open and fill the default two queued slots before sending another.
  for (let i = 0; i < 3; i++) pending.push(post());
  const deadline = Date.now() + 5_000;
  while (true) {
    const health = await fetch(url + '/healthz', { signal: AbortSignal.timeout(5_000) });
    const state = await health.json();
    if (state.running === 1 && state.queued === 2) break;
    assert.ok(Date.now() < deadline, 'one crawl should be running with two requests queued');
    await delay(10);
  }
  assert.equal(crawl.mock.callCount(), 1);
  const busy = await post();
  assert.equal(busy.status, 429);
  assert.deepEqual(await busy.json(), { error: 'busy', retry_after_s: 30 });
  assert.equal(crawl.mock.callCount(), 1);
  release();
  for (const res of await Promise.all(pending)) {
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  }
  assert.equal(crawl.mock.callCount(), 3);
});

test('HTTP server: auth, validation and crawl', async t => {
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
  const mixed = await post({ start_urls: [base + '/inventory', 'http://10.0.0.5/x'] });
  assert.equal(mixed.status, 400);
  const mixedBody = await mixed.json();
  assert.equal(mixedBody.error, 'url_refused');
  assert.deepEqual(mixedBody.refused, [{ url: 'http://10.0.0.5/x', reason: 'private_address' }]);
  const ok = await post({ start_urls: [base + '/inventory'], profile: 'vehicle', include_patterns: [base + "/inventory/*"] });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).stats.records, 3);
});

test('ssrf guard refuses a start URL that redirects to a loopback host', async t => {
  let trapHits = 0;
  const trap = http.createServer((req, res) => { trapHits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>internal</title><h1>secret</h1>'); });
  await new Promise(r => trap.listen(0, '127.0.0.1', r));
  const trapPort = trap.address().port;
  const redirector = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(302, { location: `http://localhost:${trapPort}/admin` }); res.end();
  });
  await new Promise(r => redirector.listen(0, '127.0.0.1', r));
  t.after(() => { redirector.close(); trap.close(); });
  const start = `http://127.0.0.1:${redirector.address().port}/`;
  const out = await runCrawl({ start_urls: [start], mode: 'page', max_pages: 5 }, policy);
  assert.equal(out.stats.records, 0, JSON.stringify(out));
  assert.deepEqual(out.records, []);
  const refusal = [...(out.refused || []), ...(out.failures || [])].find(x => /private_host|port_not_allowed|private_address/.test(x.reason || x.error || ''));
  t.diagnostic("trap hits: " + trapHits);
  assert.ok(refusal, 'expected a refusal: ' + JSON.stringify({ refused: out.refused, failures: out.failures }));
});

test('non-HTML responses are reported as clean failures, not extraction errors', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    const status = req.url === '/missing.json' ? 404 : 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: status === 404 ? 'not found' : null, ok: status === 200 }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const missing = await runCrawl({ start_urls: [base + '/missing.json'], mode: 'page', render: 'never' }, policy);
  assert.deepEqual(missing.failures, [{ url: base + '/missing.json', error: 'http_404' }]);
  const ok = await runCrawl({ start_urls: [base + '/data.json'], mode: 'page', render: 'never' }, policy);
  assert.deepEqual(ok.failures, [{ url: base + '/data.json', error: 'non_html' }]);
  assert.ok(![...missing.failures, ...ok.failures].some(f => /is not a function/.test(f.error)));
});
