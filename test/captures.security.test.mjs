// Tamper and cross-client security tests for captures (2.2.0). They exist to fail loudly if the hash check, the metadata
// MAC or the ownership check is weakened. Offline; synthetic pages and the fixture site only; temp dirs removed after.
//
// 2.2.0 has one shared token, so a second "client" is a second server (a different token) over the same capture
// directory: its client_id differs, which is exactly what per-client tokens will give in 2.4.0.
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, truncate, unlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { runCrawl, crawlPolicy } from '../src/crawl.mjs';
import { storeFor, sha256Hex, clientIdFromToken, captureMacKey } from '../src/capture.mjs';
import { startFixture } from './fixture-site.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const PAGE = Buffer.from('<html><title>synthetic one</title><p>0123456789</p></html>');
const PAGE2 = Buffer.from('<html><title>synthetic two</title><p>abcdefghij</p></html>');
const UNKNOWN = { status: 404, body: { error: 'capture_not_found' } };

// A server per client over one shared capture directory.
async function setup(t, tokens = [A]) {
  const dir = await mkdtemp(join(tmpdir(), 'capture-sec-'));
  const clients = [];
  for (const token of tokens) {
    const env = { CRAWL_TOKEN: token, CRAWL_CAPTURE_DIR: dir, CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_MAX_SECONDS: '60' };
    const srv = createServer({ env, crawl: runCrawl });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    t.after(() => srv.close());
    const base = `http://127.0.0.1:${srv.address().port}`;
    const store = storeFor({ ...crawlPolicy(env).capture, macKey: captureMacKey(token) });
    clients.push({
      token, base, store,
      get: (path, tok = token) => fetch(base + path, { headers: tok ? { authorization: 'Bearer ' + tok } : {} }),
      put: async (bytes = PAGE) => (await store.write(bytes, { url: 'http://page.test/a', requested_url: 'http://page.test/a', fetched_at: new Date().toISOString(), http_status: 200, content_type: 'text/html', fetch_method: 'http', rendered: false, recovered: false, client_id: clientIdFromToken(token), crawl_id: 'crawl_1' })).meta,
      crawl: async url => (await fetch(base + '/v1/crawl', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ start_urls: [url], mode: 'page', capture: true }) })).json(),
    });
  }
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, clients };
}
const bodyPath = (dir, m) => join(dir, m.capture_id + '.body');
const metaPath = (dir, m) => join(dir, m.capture_id + '.json');

// Reads a capture and asserts it failed as capture_corrupt with no stored bytes anywhere in the response.
async function assertCorrupt(c, id, marker) {
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    const r = await c.get('/v1/captures/' + id);
    const text = await r.text();
    assert.equal(r.status, 500);
    assert.deepEqual(JSON.parse(text), { error: 'capture_corrupt' });
    assert.equal(text.includes(marker), false);
    assert.equal(r.headers.get('x-capture-sha256'), null);
  } finally { console.error = orig; }
  assert.deepEqual(logged, ['capture_corrupt ' + id]);
}

// ---- Tamper ----

test('tamper: changing one byte of a stored body gives 500 capture_corrupt and no body', async t => {
  const { dir, clients: [c] } = await setup(t);
  const m = await c.put();
  assert.equal((await c.get('/v1/captures/' + m.capture_id)).status, 200);
  const b = await readFile(bodyPath(dir, m)); b[b.length - 8] ^= 0x01;
  await writeFile(bodyPath(dir, m), b);
  await assertCorrupt(c, m.capture_id, 'synthetic');
});

test('tamper: a truncated body gives 500 capture_corrupt', async t => {
  const { dir, clients: [c] } = await setup(t);
  const m = await c.put();
  await truncate(bodyPath(dir, m), PAGE.length - 1);
  await assertCorrupt(c, m.capture_id, 'synthetic');
  await truncate(bodyPath(dir, m), 0);
  await assertCorrupt(c, m.capture_id, 'synthetic');
});

test('tamper: replacing the body AND editing the stored sha256 is caught by the metadata MAC', async t => {
  const { dir, clients: [c] } = await setup(t);
  const m = await c.put();
  const evil = Buffer.from('<html>forged</html>');
  await writeFile(bodyPath(dir, m), evil);
  const meta = JSON.parse(await readFile(metaPath(dir, m), 'utf8'));
  await writeFile(metaPath(dir, m), JSON.stringify({ ...meta, sha256: sha256Hex(evil), size_bytes: evil.length }));
  await assertCorrupt(c, m.capture_id, 'forged');
  // /meta must not vouch for the edited hash either.
  const mr = await c.get(`/v1/captures/${m.capture_id}/meta`);
  assert.equal(mr.status, 500);
  assert.deepEqual(await mr.json(), { error: 'capture_corrupt' });
});

test('tamper: editing any other metadata field (url, fetched_at) or dropping the mac gives capture_corrupt', async t => {
  const { dir, clients: [c] } = await setup(t);
  for (const edit of [m => ({ ...m, url: 'http://elsewhere.test/' }), m => ({ ...m, fetched_at: '2001-01-01T00:00:00.000Z' }), ({ mac, ...rest }) => rest, m => ({ ...m, mac: '0'.repeat(64) }), m => ({ ...m, mac: 5 })]) {
    const m = await c.put();
    await writeFile(metaPath(dir, m), JSON.stringify(edit(JSON.parse(await readFile(metaPath(dir, m), 'utf8')))));
    assert.equal((await c.get(`/v1/captures/${m.capture_id}/meta`)).status, 500);
    assert.equal((await c.get('/v1/captures/' + m.capture_id)).status, 500);
  }
});

test('tamper: a body deleted but metadata kept gives 404 capture_not_found (the unknown-id answer)', async t => {
  const { dir, clients: [c] } = await setup(t);
  const m = await c.put();
  await unlink(bodyPath(dir, m));
  const r = await c.get('/v1/captures/' + m.capture_id);
  assert.deepEqual({ status: r.status, body: await r.json() }, UNKNOWN);
});

test('tamper: swapping two captures\' bodies on disk makes both reads fail', async t => {
  const { dir, clients: [c] } = await setup(t);
  const m1 = await c.put(PAGE); const m2 = await c.put(PAGE2);
  const [b1, b2] = [await readFile(bodyPath(dir, m1)), await readFile(bodyPath(dir, m2))];
  await writeFile(bodyPath(dir, m1), b2); await writeFile(bodyPath(dir, m2), b1);
  await assertCorrupt(c, m1.capture_id, 'synthetic');
  await assertCorrupt(c, m2.capture_id, 'synthetic');
});

test('tamper: copying one capture\'s metadata over another id does not make it readable', async t => {
  const { dir, clients: [c] } = await setup(t);
  const m1 = await c.put(PAGE); const m2 = await c.put(PAGE2);
  await writeFile(metaPath(dir, m2), await readFile(metaPath(dir, m1)));
  const r = await c.get('/v1/captures/' + m2.capture_id);
  assert.deepEqual({ status: r.status, body: await r.json() }, UNKNOWN);
});

test('tamper: ownership edited on disk (client_id changed to another client) still fails the MAC', async t => {
  const { dir, clients: [a, b] } = await setup(t, [A, B]);
  const m = await a.put();
  const meta = JSON.parse(await readFile(metaPath(dir, m), 'utf8'));
  await writeFile(metaPath(dir, m), JSON.stringify({ ...meta, client_id: clientIdFromToken(B) }));
  const r = await b.get('/v1/captures/' + m.capture_id);
  assert.equal(r.status, 500);
  assert.equal(r.headers.get('x-capture-sha256'), null);
  assert.deepEqual(await r.json(), { error: 'capture_corrupt' });
});

// ---- Cross-client ----

test('cross-client: another client gets the unknown-id 404 on the body and /meta, identical to a never-used id', async t => {
  const { clients: [a, b] } = await setup(t, [A, B]);
  const m = await a.put();
  assert.equal((await a.get('/v1/captures/' + m.capture_id)).status, 200);
  const snap = async r => ({ status: r.status, body: await r.text(), type: r.headers.get('content-type'), len: r.headers.get('content-length'), extra: [...r.headers.keys()].filter(k => k.startsWith('x-capture')) });
  for (const suffix of ['', '/meta']) {
    const foreign = await snap(await b.get(`/v1/captures/${m.capture_id}${suffix}`));
    const unknown = await snap(await b.get(`/v1/captures/${'0'.repeat(48)}${suffix}`));
    assert.deepEqual(foreign, unknown);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.includes(m.capture_id), false);
    assert.equal(foreign.body.includes('synthetic'), false);
  }
});

test('cross-client: there is no listing endpoint; listing and enumeration attempts get 404', async t => {
  const { clients: [a, b] } = await setup(t, [A, B]);
  const m = await a.put();
  for (const p of ['/v1/captures', '/v1/captures/', '/v1/captures?client=all', '/v1/captures/list', '/captures', '/v1/crawls']) {
    const r = await b.get(p);
    // /v1/captures/ is routed to the capture reader and rejects the empty id; everything else is plain 404.
    assert.ok([404, 400].includes(r.status), p);
    assert.ok(!(await r.text()).includes(m.capture_id), p);
  }
  for (const p of ['/v1/captures', '/captures', '/v1/captures?client=all', '/v1/crawls']) assert.equal((await b.get(p)).status, 404, p);
});

test('cross-client: two clients crawl the same URL, get distinct capture_ids, and cannot read each other\'s', async t => {
  const f = await startFixture({ duplicate: false }); t.after(() => f.server.close());
  const { clients: [a, b] } = await setup(t, [A, B]);
  const url = f.base + '/inventory/1';
  const [ra, rb] = [await a.crawl(url), await b.crawl(url)];
  const [ida, idb] = [ra.records[0].capture_id, rb.records[0].capture_id];
  assert.match(ida, /^[0-9a-f]{48}$/); assert.match(idb, /^[0-9a-f]{48}$/);
  assert.notEqual(ida, idb);
  assert.equal(ra.records[0].sha256, rb.records[0].sha256);   // same page, same bytes
  for (const [reader, own, other] of [[a, ida, idb], [b, idb, ida]]) {
    assert.equal((await reader.get('/v1/captures/' + own)).status, 200);
    assert.equal((await reader.get(`/v1/captures/${own}/meta`)).status, 200);
    for (const s of ['', '/meta']) assert.equal((await reader.get(`/v1/captures/${other}${s}`)).status, 404);
  }
});

test('auth: no token, wrong token and an almost-correct token (last character changed) all get 401', async t => {
  const { clients: [c] } = await setup(t);
  const m = await c.put();
  const almost = c.token.slice(0, -1) + (c.token.endsWith('z') ? 'y' : 'z');
  assert.equal(almost.length, c.token.length);
  for (const p of [`/v1/captures/${m.capture_id}`, `/v1/captures/${m.capture_id}/meta`, '/v1/captures/' + '0'.repeat(48)]) {
    for (const tok of [null, almost, 'wrong']) {
      const r = await c.get(p, tok);
      assert.equal(r.status, 401, `${p} ${tok}`);
      assert.deepEqual(await r.json(), { error: 'unauthorized' });
    }
  }
  // Other schemes and a token with trailing junk are not accepted either.
  for (const h of ['Basic ' + c.token, c.token, 'Bearer ' + c.token + ' x', 'bearer ' + c.token]) {
    assert.equal((await fetch(c.base + `/v1/captures/${m.capture_id}`, { headers: { authorization: h } })).status, 401, h);
  }
  const crawl = await fetch(c.base + '/v1/crawl', { method: 'POST', headers: { authorization: 'Bearer ' + almost, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(crawl.status, 401);
});

// ---- General ----

test('path traversal: encoded and raw traversal ids never read outside the capture directory', async t => {
  const { dir, clients: [c] } = await setup(t);
  const m = await c.put();
  // A secret sitting next to the capture dir with a capture-like name must stay unreachable.
  const outside = join(dir, '..', 'capture-sec-outside');
  await writeFile(outside + '.json', JSON.stringify({ secret: 'outside-marker' })); await writeFile(outside + '.body', 'outside-marker');
  t.after(() => Promise.all([rm(outside + '.json', { force: true }), rm(outside + '.body', { force: true })]));
  const raw = path => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: new URL(c.base).port, path, headers: { authorization: 'Bearer ' + c.token } }, r => { let s = ''; r.on('data', d => { s += d; }); r.on('end', () => resolve({ status: r.statusCode, text: s })); }).on('error', reject));
  const attempts = [
    '/v1/captures/../capture-sec-outside', '/v1/captures/..%2fcapture-sec-outside', '/v1/captures/%2e%2e/capture-sec-outside/meta',
    `/v1/captures/${m.capture_id}/../${m.capture_id}`, `/v1/captures/${m.capture_id}%2f..%2f${m.capture_id}`, `/v1/captures/${m.capture_id}.body`, `/v1/captures/${m.capture_id}.json/meta`,
    `/v1/captures/${m.capture_id}%00`, `/v1/captures/${m.capture_id}%00.json`, '/v1/captures/..%5c..%5cetc%5cpasswd', '/v1/captures/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/v1/captures/....//....//etc/passwd', '/v1/captures//etc/passwd', '/v1/captures/' + '%252e'.repeat(10),
  ];
  for (const p of attempts) {
    const r = await raw(p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.equal(r.text.includes('outside-marker'), false, p);
    assert.equal(r.text.includes('synthetic'), false, p);
  }
  assert.equal((await readdir(dir)).length, 2);   // nothing created or removed by the attempts
});

test('captured page content never appears in logs or /healthz', async t => {
  const f = await startFixture({ duplicate: false }); t.after(() => f.server.close());
  const { clients: [c] } = await setup(t);
  const out = [];
  const spy = (stream) => { const w = stream.write; stream.write = function (chunk, ...rest) { out.push(String(chunk)); return w.call(this, chunk, ...rest); }; return () => { stream.write = w; }; };
  const undo = [spy(process.stdout), spy(process.stderr)];
  let crawled; let health; let corrupt;
  try {
    crawled = await c.crawl(f.base + '/inventory/1');
    const id = crawled.records[0].capture_id;
    health = await (await fetch(c.base + '/healthz')).text();
    await c.get('/v1/captures/' + id); await c.get(`/v1/captures/${id}/meta`);
    await writeFile(join(c.store.cfg.dir, id + '.body'), 'Ridgeline Motors tampered');   // forces the capture_corrupt log line
    corrupt = await c.get('/v1/captures/' + id);
  } finally { undo.forEach(u => u()); }
  assert.equal(corrupt.status, 500);
  const body = (await (await fetch(f.base + '/inventory/1')).text());
  const logs = out.join('');
  for (const needle of ['Ridgeline Motors', '<title>', '<html', body.slice(0, 60)]) {
    assert.equal(logs.includes(needle), false, 'log: ' + needle);
    assert.equal(health.includes(needle), false, 'healthz: ' + needle);
  }
  for (const s of [crawled.records[0].capture_id, crawled.records[0].sha256]) assert.equal(health.includes(s), false);
  assert.deepEqual(Object.keys(JSON.parse(health)).sort(), ['firecrawl', 'ok', 'queued', 'robots', 'running', 'served', 'version']);
});
