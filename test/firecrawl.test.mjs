// Firecrawl integration, fully offline: a fixture site whose listings are JavaScript-only or blocked for plain HTTP,
// and a fake Firecrawl API that "renders" them. No real Firecrawl or internet needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { load } from 'cheerio';
import { inventory, page } from './fixture-site.mjs';
import { runCrawl, crawlPolicy, validateRequest, BadRequest } from '../src/crawl.mjs';
import { looksClientRendered, firecrawlPolicy } from '../src/firecrawl.mjs';

const KEY = 'fc-test-key-0123456789abcdef'; // gitleaks:allow (fake key for the fake Firecrawl server)
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

// Site: /spa (index with real links) -> /spa/item/N (empty app shell); /blocked (index) -> /blocked/item/N (403).
async function startSite(n = 6) {
  const inv = inventory(n);
  const shell = '<!doctype html><html><head><title>Loading…</title><script src="/app.js"></script></head><body><div id="root"></div><noscript>Please enable JavaScript.</noscript></body></html>';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'text/html' }); res.end(body); };
    if (u.pathname === '/robots.txt') return send(200, 'User-agent: *\nAllow: /\n');
    for (const kind of ['spa', 'blocked', 'static']) {
      if (u.pathname === '/' + kind) return send(200, `<!doctype html><html><head><title>${kind} inventory</title></head><body><h1>Inventory</h1><ul>${inv.map(v => `<li><a href="/${kind}/item/${v.id}">${v.year} ${v.make} ${v.model}</a></li>`).join('')}</ul></body></html>`);
      const m = u.pathname.match(new RegExp(`^/${kind}/item/(\\d+)$`));
      if (m) {
        const v = inv[+m[1] - 1]; if (!v) return send(404, 'no');
        if (kind === 'spa') return send(200, shell);
        if (kind === 'blocked') return send(403, '<h1>Access denied</h1>');
        return send(200, page(v));
      }
    }
    send(404, 'not found');
  });
  const base = await listen(server);
  return { server, inv, base };
}

// Fake Firecrawl: /v1/scrape returns the fully rendered listing for any item URL; /v1/map lists the site.
async function startFirecrawl(site, { fail = false, finalUrl = null, extraMapLinks = [] } = {}) {
  const calls = { scrape: [], map: [], unauthorized: 0 };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer ' + KEY) { calls.unauthorized++; return json(401, { success: false }); }
    const { url } = JSON.parse(body || '{}');
    if (fail) return json(500, { success: false, error: 'boom' });
    if (req.url === '/v1/scrape') {
      calls.scrape.push(url);
      const m = new URL(url).pathname.match(/\/item\/(\d+)$/);
      const v = m && site.inv[+m[1] - 1];
      if (!v) return json(200, { success: true, data: { rawHtml: '<html><body><p>nothing</p></body></html>', metadata: { url, statusCode: 404 } } });
      return json(200, { success: true, data: { rawHtml: page(v), metadata: { url: finalUrl || url, sourceURL: url, statusCode: 200 } } });
    }
    if (req.url === '/v1/map') {
      calls.map.push(url);
      return json(200, { success: true, links: [...site.inv.map(v => `${site.base}/spa/item/${v.id}`), `${site.base}/spa/item/1#reviews`, 'https://elsewhere.example/item/9', ...extraMapLinks] });
    }
    json(404, { success: false });
  });
  const base = await listen(server);
  return { server, calls, base };
}

const policyWith = (fcBase, extra = {}) => crawlPolicy({ CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_MAX_SECONDS: '60', ...(fcBase ? { FIRECRAWL_URL: fcBase, FIRECRAWL_API_KEY: KEY } : {}), ...extra });
const FIELDS = ['vin', 'year', 'make', 'model', 'trim', 'price', 'mileage', 'exterior_color', 'status'];
function accuracy(records, inv, prefix) {
  let ok = 0, total = 0;
  for (const truth of inv) {
    const rec = records.find(r => r.listing_url.endsWith(`${prefix}/item/${truth.id}`));
    for (const f of FIELDS) { total++; if (rec && rec[f] === truth[f]) ok++; }
  }
  return ok / total;
}

test('detects JavaScript-built pages', () => {
  assert.equal(looksClientRendered(load('<html><head><script src="a.js"></script></head><body><div id="root"></div></body></html>')), true);
  assert.equal(looksClientRendered(load('<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div>Hi</div></body></html>')), true);
  assert.equal(looksClientRendered(load(page(inventory(3)[2]))), false);
  for (const v of inventory(3)) assert.equal(looksClientRendered(load(page(v))), false, v.style + ' listing is server-rendered');
});

test('config: off without FIRECRAWL_URL; render=always and mode=map need it', () => {
  assert.equal(firecrawlPolicy({}), null);
  const p = policyWith(null);
  assert.equal(validateRequest({ url: 'http://a.test/' }, p).render, 'never');
  assert.throws(() => validateRequest({ url: 'http://a.test/', render: 'always' }, p), e => e instanceof BadRequest && e.message === 'firecrawl_not_configured');
  assert.throws(() => validateRequest({ url: 'http://a.test/', mode: 'map' }, p), e => e instanceof BadRequest && e.message === 'firecrawl_not_configured');
  assert.throws(() => validateRequest({ url: 'http://a.test/', render: 'sometimes' }, policyWith('http://127.0.0.1:9')), BadRequest);
  assert.throws(() => firecrawlPolicy({ FIRECRAWL_URL: 'ftp://x' }));
});

test('render=auto: JavaScript-only listings are fetched through Firecrawl and extracted', async t => {
  const site = await startSite(); const fc = await startFirecrawl(site);
  t.after(() => { site.server.close(); fc.server.close(); });
  const out = await runCrawl({ start_urls: [site.base + '/spa'], profile: 'vehicle', include_patterns: [site.base + '/spa/item/*'], max_pages: 20 }, policyWith(fc.base));
  assert.equal(out.stats.records, site.inv.length, JSON.stringify(out.firecrawl));
  assert.ok(out.records.every(r => r.fetched_via === 'firecrawl'));
  assert.equal(out.firecrawl.pages_rendered, site.inv.length);
  assert.equal(fc.calls.unauthorized, 0);
  assert.ok(accuracy(out.records, site.inv, '/spa') >= 0.98);
  assert.ok(!JSON.stringify(out).includes(KEY), 'API key must never appear in results');
});

test('render=never keeps Firecrawl out; JavaScript-only pages then yield nothing', async t => {
  const site = await startSite(3); const fc = await startFirecrawl(site);
  t.after(() => { site.server.close(); fc.server.close(); });
  const out = await runCrawl({ start_urls: [site.base + '/spa'], profile: 'vehicle', render: 'never', include_patterns: [site.base + '/spa/item/*'] }, policyWith(fc.base));
  assert.equal(out.stats.records, 0); assert.equal(fc.calls.scrape.length, 0);
});

test('static pages never cost a Firecrawl call', async t => {
  const site = await startSite(4); const fc = await startFirecrawl(site);
  t.after(() => { site.server.close(); fc.server.close(); });
  const out = await runCrawl({ start_urls: [site.base + '/static'], profile: 'vehicle', include_patterns: [site.base + '/static/item/*'] }, policyWith(fc.base));
  assert.equal(out.stats.records, 4); assert.ok(out.records.every(r => r.fetched_via === 'http'));
  assert.equal(fc.calls.scrape.length, 0);
});

test('pages blocked for plain HTTP are recovered through Firecrawl', async t => {
  const site = await startSite(4); const fc = await startFirecrawl(site);
  t.after(() => { site.server.close(); fc.server.close(); });
  const out = await runCrawl({ start_urls: [site.base + '/blocked'], profile: 'vehicle', include_patterns: [site.base + '/blocked/item/*'] }, policyWith(fc.base));
  assert.equal(out.stats.records, 4, JSON.stringify({ f: out.failures, fc: out.firecrawl }));
  assert.equal(out.firecrawl.http_failures_recovered, 4);
  assert.equal(out.failures.length, 0);
});

test('Firecrawl outage: structured failures, no crash, no key leak', async t => {
  const site = await startSite(3); const fc = await startFirecrawl(site, { fail: true });
  t.after(() => { site.server.close(); fc.server.close(); });
  const out = await runCrawl({ start_urls: [site.base + '/blocked'], profile: 'vehicle', include_patterns: [site.base + '/blocked/item/*'] }, policyWith(fc.base));
  assert.equal(out.stats.records, 0);
  assert.equal(out.failures.length, 3);
  assert.ok(out.firecrawl.failures.length >= 3 && out.firecrawl.failures.every(f => f.outcome === 'http_500'));
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test('a rendered page that ends up on a private or off-site address is refused', async t => {
  const site = await startSite(2); const fc = await startFirecrawl(site, { finalUrl: 'http://169.254.169.254/latest/' });
  t.after(() => { site.server.close(); fc.server.close(); });
  const out = await runCrawl({ start_urls: [site.base + '/spa'], profile: 'vehicle', include_patterns: [site.base + '/spa/item/*'] }, policyWith(fc.base));
  assert.equal(out.stats.records, 0);
  assert.ok(out.refused.some(r => r.reason === 'private_address'), JSON.stringify(out.refused));
});

test('mode=map seeds the crawl from Firecrawl /v1/map, same site only', async t => {
  const site = await startSite(5); const fc = await startFirecrawl(site);
  t.after(() => { site.server.close(); fc.server.close(); });
  const out = await runCrawl({ start_urls: [site.base + '/spa'], mode: 'map', profile: 'vehicle', include_patterns: [site.base + '/spa/item/*'], exclude_patterns: [site.base + '/spa/item/5'] }, policyWith(fc.base));
  assert.equal(fc.calls.map.length, 1);
  assert.equal(out.stats.records, 4, JSON.stringify(out.firecrawl));
  assert.ok(!out.records.some(r => r.listing_url.endsWith('/item/5')));
  assert.ok(out.firecrawl.map_urls_found >= 5);
});

test('per-crawl render budget is enforced', async t => {
  const site = await startSite(6); const fc = await startFirecrawl(site);
  t.after(() => { site.server.close(); fc.server.close(); });
  const out = await runCrawl({ start_urls: [site.base + '/spa'], profile: 'vehicle', include_patterns: [site.base + '/spa/item/*'], concurrency: 1 }, policyWith(fc.base, { FIRECRAWL_MAX_RENDERS: '2' }));
  assert.equal(fc.calls.scrape.length, 2);
  assert.equal(out.stats.records, 2);
  assert.equal(out.firecrawl.render_budget_skips, 4);
});
