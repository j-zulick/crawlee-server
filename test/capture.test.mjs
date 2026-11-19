// Raw page captures (2.2.0), offline: fixture site only, synthetic pages, temp directories removed after each test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, chmod, utimes } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startFixture } from './fixture-site.mjs';
import { runCrawl, crawlPolicy, validateRequest, BadRequest } from '../src/crawl.mjs';
import { createServer } from '../src/server.mjs';
import { CaptureStore, capturePolicy, clientIdFromToken } from '../src/capture.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const tmpDir = async t => { const d = await mkdtemp(join(tmpdir(), 'capture-test-')); t.after(() => rm(d, { recursive: true, force: true })); return d; };
const policy = (dir, extra = {}) => crawlPolicy({ CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_MAX_SECONDS: '60', ...(dir ? { CRAWL_CAPTURE_DIR: dir } : {}), ...extra });
const fixture = async t => { const f = await startFixture({ duplicate: false }); t.after(() => f.server.close()); return f; };
const fetchBytes = async url => Buffer.from(await (await fetch(url)).arrayBuffer());

test('capture: stored body is byte-identical to what the server sent, with matching SHA-256 and metadata', async t => {
  const dir = await tmpDir(t); const f = await fixture(t);
  const before = Date.now();
  const out = await runCrawl({ start_urls: [f.base + '/inventory/1'], mode: 'page', capture: true }, policy(dir), { clientId: 'tok_test' });
  const after = Date.now();
  assert.equal(out.status, 'ok');
  const rec = out.records[0];
  const sent = await fetchBytes(f.base + '/inventory/1');
  assert.match(rec.capture_id, /^[0-9a-f]{48}$/);
  assert.equal(rec.sha256, sha(sent));
  assert.equal(rec.sha256, createHash('sha256').update(await readFile(join(dir, rec.capture_id + '.body'))).digest('hex'));
  assert.deepEqual(await readFile(join(dir, rec.capture_id + '.body')), sent);
  const meta = JSON.parse(await readFile(join(dir, rec.capture_id + '.json'), 'utf8'));
  assert.match(meta.fetched_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const at = Date.parse(meta.fetched_at);
  assert.ok(at >= before - 1000 && at <= after, 'fetched_at falls inside the crawl');
  assert.equal(rec.fetched_at, meta.fetched_at);
  assert.deepEqual({ ...meta, fetched_at: 0, capture_id: 0 }, {
    capture_id: 0, url: f.base + '/inventory/1', requested_url: f.base + '/inventory/1', fetched_at: 0, http_status: 200, content_type: 'text/html',
    size_bytes: sent.length, sha256: sha(sent), fetch_method: 'http', rendered: false, recovered: false, client_id: 'tok_test', crawl_id: out.crawl_id,
  });
  assert.deepEqual(out.capture, { enabled: true, stored: 1, not_stored: 0 });
  assert.equal(JSON.stringify(out).includes(sent.toString('utf8').slice(0, 40)), false, 'page content is not returned in the response');
});

test('capture: bytes that are not valid UTF-8 (BOM, 0xFF) are stored exactly as received', async t => {
  const dir = await tmpDir(t); const f = await fixture(t);
  const out = await runCrawl({ start_urls: [f.base + '/raw'], mode: 'page', capture: true }, policy(dir));
  const sent = await fetchBytes(f.base + '/raw');
  assert.ok(sent.includes(0xff));
  assert.deepEqual(await readFile(join(dir, out.records[0].capture_id + '.body')), sent);
  assert.equal(out.records[0].sha256, sha(sent));
});

test('capture: a redirected fetch stores the final URL and the requested URL', async t => {
  const dir = await tmpDir(t); const f = await fixture(t);
  const out = await runCrawl({ start_urls: [f.base + '/go/2'], mode: 'page', capture: true }, policy(dir));
  const meta = JSON.parse(await readFile(join(dir, out.records[0].capture_id + '.json'), 'utf8'));
  assert.equal(meta.url, f.base + '/inventory/2');
  assert.equal(meta.requested_url, f.base + '/go/2');
});

test('capture: absent or false writes nothing and adds no record fields', async t => {
  const dir = await tmpDir(t); const f = await fixture(t);
  for (const body of [{}, { capture: false }]) {
    const out = await runCrawl({ start_urls: [f.base + '/inventory/1'], mode: 'page', ...body }, policy(dir));
    assert.equal(out.records.length, 1);
    for (const k of ['capture_id', 'sha256', 'fetched_at']) assert.ok(!(k in out.records[0]), k);
    assert.ok(!('capture' in out));
  }
  assert.deepEqual(await readdir(dir), []);
  assert.throws(() => validateRequest({ url: 'http://a.test/', capture: 'yes' }, policy(dir)), e => e instanceof BadRequest);
});

test('capture: CRAWL_CAPTURE_DEFAULT=true turns it on; capture:false still wins', async t => {
  const dir = await tmpDir(t); const f = await fixture(t);
  const p = policy(dir, { CRAWL_CAPTURE_DEFAULT: 'true' });
  assert.ok((await runCrawl({ start_urls: [f.base + '/inventory/1'], mode: 'page' }, p)).records[0].capture_id);
  assert.ok(!(await runCrawl({ start_urls: [f.base + '/inventory/1'], mode: 'page', capture: false }, p)).records[0].capture_id);
});

test('capture: a page over CRAWL_CAPTURE_MAX_BYTES is not stored and limitations says so', async t => {
  const dir = await tmpDir(t); const f = await fixture(t);
  const out = await runCrawl({ start_urls: [f.base + '/big'], mode: 'page', capture: true }, policy(dir, { CRAWL_CAPTURE_MAX_BYTES: '1000' }));
  assert.equal(out.records.length, 1);
  assert.ok(!('capture_id' in out.records[0]));
  assert.deepEqual(await readdir(dir), []);
  assert.ok(out.limitations.some(l => l.includes('CRAWL_CAPTURE_MAX_BYTES') && l.includes(f.base + '/big')), out.limitations.join('\n'));
});

test('capture: the total size cap stops further captures and says so', async t => {
  const dir = await tmpDir(t); const f = await fixture(t);
  const one = (await fetchBytes(f.base + '/inventory/1')).length;
  const out = await runCrawl({ start_urls: [f.base + '/inventory/1', f.base + '/inventory/2'], mode: 'page', capture: true, concurrency: 1 }, policy(dir, { CRAWL_CAPTURE_MAX_TOTAL_BYTES: String(one + 10) }));
  assert.equal(out.records.length, 2);
  assert.equal(out.records.filter(r => r.capture_id).length, 1);
  assert.equal((await readdir(dir)).length, 2);
  assert.ok(out.limitations.some(l => l.includes('CRAWL_CAPTURE_MAX_TOTAL_BYTES')));
});

test('capture: a missing or unwritable directory gives status partial; records are still returned', async t => {
  const f = await fixture(t); const dir = await tmpDir(t);
  const req = { start_urls: [f.base + '/inventory/1'], mode: 'page', capture: true };
  const missing = await runCrawl(req, policy(join(dir, 'nope')));
  const unset = await runCrawl(req, policy(null));
  const ro = join(dir, 'ro'); await (await import('node:fs/promises')).mkdir(ro, { mode: 0o500 }); await chmod(ro, 0o500);
  const unwritable = await runCrawl(req, policy(ro));
  await writeFile(join(dir, 'file'), 'x');
  const notDir = await runCrawl(req, policy(join(dir, 'file')));
  const canWrite = process.getuid?.() === 0; // root ignores directory modes
  for (const [out, why] of [[missing, 'capture_dir_missing'], [unset, 'capture_dir_not_configured'], [notDir, 'capture_dir_not_a_directory'], ...(canWrite ? [] : [[unwritable, 'capture_dir_not_writable']])]) {
    assert.equal(out.status, 'partial', why);
    assert.equal(out.records.length, 1);
    assert.ok(!('capture_id' in out.records[0]));
    assert.ok(out.limitations.some(l => l.includes(why)), why);
  }
  await chmod(ro, 0o700);
});

test('capture: the write is atomic; a process killed mid-write leaves no listed capture, and the sweep clears the leftovers', async t => {
  const dir = await tmpDir(t);
  const code = `
    import { CaptureStore, capturePolicy } from ${JSON.stringify(new URL('../src/capture.mjs', import.meta.url).href)};
    const s = new CaptureStore(capturePolicy({ CRAWL_CAPTURE_DIR: ${JSON.stringify(dir)} }), { hooks: { beforeRename: () => process.kill(process.pid, 'SIGKILL') } });
    await s.write(Buffer.from('synthetic'), { url: 'http://x.test/' });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code]);
  assert.equal(r.signal, 'SIGKILL');
  const store = new CaptureStore(capturePolicy({ CRAWL_CAPTURE_DIR: dir }));
  assert.deepEqual(await store.list(), []);
  const left = await readdir(dir);
  assert.ok(left.length > 0 && left.every(n => n.startsWith('.tmp-')), left.join());
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const n of left) await utimes(join(dir, n), old, old);
  await store.sweep();
  assert.deepEqual(await readdir(dir), []);
});

test('capture: a failed write leaves nothing behind', async t => {
  const dir = await tmpDir(t);
  const store = new CaptureStore(capturePolicy({ CRAWL_CAPTURE_DIR: dir }), { hooks: { beforeRename: () => { throw new Error('disk full'); } } });
  assert.deepEqual(await store.write(Buffer.from('synthetic'), {}), { ok: false, reason: 'write_failed' });
  assert.deepEqual(await readdir(dir), []);
});

test('capture: the TTL sweep removes expired captures and keeps fresh ones; foreign files are never touched', async t => {
  const dir = await tmpDir(t);
  const store = new CaptureStore(capturePolicy({ CRAWL_CAPTURE_DIR: dir, CRAWL_CAPTURE_TTL_DAYS: '30' }));
  const now = Date.now(); const day = 86_400_000;
  const w = async daysAgo => (await store.write(Buffer.from('synthetic ' + daysAgo), { fetched_at: new Date(now - daysAgo * day).toISOString() })).meta.capture_id;
  const old = await w(31); const fresh = await w(29);
  await writeFile(join(dir, 'notes.txt'), 'not a capture');
  assert.deepEqual((await store.sweep(now)).removed, 1);
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ['notes.txt', fresh + '.body', fresh + '.json'].sort());
  assert.ok(!names.some(n => n.startsWith(old)));
});

test('capture: policy defaults, and the client id is derived from the token without containing it', () => {
  assert.deepEqual({ ...capturePolicy({}) }, { dir: null, byDefault: false, maxBytes: 5_000_000, maxTotalBytes: 1_073_741_824, ttlDays: 30 });
  assert.equal(capturePolicy({ CRAWL_CAPTURE_TTL_DAYS: '0' }).ttlDays, 30);
  const id = clientIdFromToken('a'.repeat(32));
  assert.match(id, /^tok_[0-9a-f]{16}$/);
  assert.equal(id, clientIdFromToken('a'.repeat(32)));
  assert.notEqual(id, clientIdFromToken('b'.repeat(32)));
});

test('capture: through the API, client_id comes from the token and records carry the capture fields', async t => {
  const dir = await tmpDir(t); const f = await fixture(t);
  const token = 'y'.repeat(32);
  const srv = createServer({ env: { CRAWL_TOKEN: token, CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_CAPTURE_DIR: dir }, crawl: runCrawl });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/v1/crawl`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ start_urls: [f.base + '/inventory/3'], mode: 'page', capture: true }) });
  const out = await res.json();
  const meta = JSON.parse(await readFile(join(dir, out.records[0].capture_id + '.json'), 'utf8'));
  assert.equal(meta.client_id, clientIdFromToken(token));
  assert.ok(!JSON.stringify(meta).includes(token));
});
