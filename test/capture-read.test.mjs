// GET /v1/captures/:id and /meta (2.2.0): owner-only reads, uniform 404, strict ids, security headers. Synthetic pages only.
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { crawlPolicy } from '../src/crawl.mjs';
import { storeFor, sha256Hex, clientIdFromToken, captureMacKey } from '../src/capture.mjs';

const TOKEN = 'x'.repeat(32);
const OTHER = 'y'.repeat(32);
const PAGE = Buffer.from('<html><title>synthetic</title><script>alert(1)</script>\xff</html>', 'latin1');

async function setup(t, extraEnv = {}, crawl = async () => ({ status: 'ok' })) {
  const dir = await mkdtemp(join(tmpdir(), 'capture-read-'));
  const env = { CRAWL_TOKEN: TOKEN, CRAWL_CAPTURE_DIR: dir, ...extraEnv };
  const srv = createServer({ env, crawl });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.close(); return rm(dir, { recursive: true, force: true }); });
  const store = storeFor({ ...crawlPolicy(env).capture, macKey: captureMacKey(TOKEN) });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const put = async (token = TOKEN, bytes = PAGE, extra = {}) => (await store.write(bytes, {
    url: 'http://page.test/a', requested_url: 'http://page.test/a', fetched_at: new Date().toISOString(), http_status: 200,
    content_type: 'text/html', fetch_method: 'http', rendered: false, recovered: false, client_id: clientIdFromToken(token), crawl_id: 'crawl_1', ...extra,
  })).meta;
  const get = (path, token = TOKEN) => fetch(base + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
  return { dir, store, base, put, get };
}

test('owner fetches body and meta; bytes and hash match, security headers present', async t => {
  const { put, get } = await setup(t);
  const m = await put();
  const r = await get('/v1/captures/' + m.capture_id);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PAGE);
  assert.equal(r.headers.get('x-capture-sha256'), sha256Hex(PAGE));
  assert.equal(r.headers.get('x-capture-fetched-at'), m.fetched_at);
  assert.equal(r.headers.get('x-capture-url'), 'http://page.test/a');
  assert.equal(r.headers.get('x-capture-crawl-id'), 'crawl_1');
  assert.equal(r.headers.get('content-type'), 'text/html');
  assert.equal(r.headers.get('content-security-policy'), 'sandbox');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  const mr = await get(`/v1/captures/${m.capture_id}/meta`);
  assert.equal(mr.status, 200);
  const meta = await mr.json();
  assert.deepEqual(Object.keys(meta).sort(), ['capture_id', 'content_type', 'crawl_id', 'fetch_method', 'fetched_at', 'http_status', 'recovered', 'rendered', 'requested_url', 'sha256', 'size_bytes', 'url']);
  assert.equal(meta.sha256, sha256Hex(PAGE));
  assert.equal(meta.size_bytes, PAGE.length);
});

test('missing or wrong token gives 401', async t => {
  const { put, get } = await setup(t);
  const m = await put();
  for (const p of [`/v1/captures/${m.capture_id}`, `/v1/captures/${m.capture_id}/meta`]) {
    assert.equal((await get(p, null)).status, 401);
    assert.equal((await get(p, OTHER)).status, 401);
  }
});

test('unknown, expired and foreign ids give an identical 404', async t => {
  const { put, get, store } = await setup(t);
  const foreign = await put(OTHER);
  const old = await put(TOKEN, PAGE, { fetched_at: new Date(Date.now() - 90 * 86_400_000).toISOString() });
  await store.sweep();
  const seen = [];
  for (const id of ['a'.repeat(48), old.capture_id, foreign.capture_id]) {
    for (const suffix of ['', '/meta']) { const r = await get(`/v1/captures/${id}${suffix}`); seen.push([r.status, await r.text()]); }
  }
  assert.equal(seen.length, 6);
  for (const s of seen) assert.deepEqual(s, [404, seen[0][1]]);
  assert.equal(seen[0][1].includes('a'.repeat(48)), false);
});

test('malformed ids give 400 and the filesystem outside the capture dir is never read', async t => {
  const { get, dir, base } = await setup(t);
  await writeFile(join(dir, '..', 'capture-read-outside.json'), '{}').catch(() => {});
  t.after(() => rm(join(dir, '..', 'capture-read-outside.json'), { force: true }));
  // fetch() normalises ../ away before sending, so raw paths go through http.request.
  const raw = path => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: new URL(base).port, path, headers: { authorization: 'Bearer ' + TOKEN } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));
  for (const p of ['/v1/captures/../x', '/v1/captures/x/../../y', '/v1/captures/../../etc/passwd/meta', '/v1/captures/a/b']) assert.equal(await raw(p), 400, p);
  for (const id of ['..%2Fx', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', 'A'.repeat(48), 'g'.repeat(48), 'a'.repeat(49), 'a'.repeat(5000), 'a'.repeat(47), '', 'a'.repeat(48) + '.json', 'a'.repeat(48) + '?x=1']) {
    const r = await get('/v1/captures/' + id + '/meta');
    assert.equal(r.status, 400, id.slice(0, 30));
    assert.deepEqual(await r.json(), { error: 'invalid_capture_id' });
  }
  assert.equal((await get('/v1/captures/' + 'a'.repeat(5000))).status, 400);
  assert.deepEqual(await readdir(dir), []);
});

test('a body that no longer matches its hash gives 500 capture_corrupt without the body', async t => {
  const { put, get, dir } = await setup(t);
  const m = await put();
  await writeFile(join(dir, m.capture_id + '.body'), 'tampered');
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  let r; try { r = await get('/v1/captures/' + m.capture_id); } finally { console.error = orig; }
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'capture_corrupt' });
  assert.deepEqual(logged, ['capture_corrupt ' + m.capture_id]);
});

test('reads are rate limited per client', async t => {
  const { get } = await setup(t, { CRAWL_CAPTURE_READS_PER_MIN: '3' });
  const codes = []; for (let i = 0; i < 5; i++) codes.push((await get('/v1/captures/' + 'a'.repeat(48))).status);
  assert.deepEqual(codes.slice(0, 3), [404, 404, 404]);
  assert.equal(codes[4], 429);
});

test('reads work while a crawl runs and do not use the crawl slot', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const { put, get, base } = await setup(t, {}, async () => { await gate; return { status: 'ok' }; });
  const m = await put();
  const crawl = fetch(base + '/v1/crawl', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: '{}' });
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await (await fetch(base + '/healthz')).json()).running, 1);
  for (let i = 0; i < 5; i++) assert.equal((await get('/v1/captures/' + m.capture_id)).status, 200);
  assert.equal((await (await fetch(base + '/healthz')).json()).running, 1);
  release(); assert.equal((await crawl).status, 200);
});
