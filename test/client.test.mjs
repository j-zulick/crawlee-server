// Client identity (2.2.0): token -> client_id, ownership check. Offline; synthetic pages and temp directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from './fixture-site.mjs';
import { runCrawl } from '../src/crawl.mjs';
import { createServer } from '../src/server.mjs';
import { clientIdFromToken, makeResolveClient, ownsCapture } from '../src/client.mjs';

test('client: same token, same id; different tokens differ; the id never reveals the token', () => {
  const [a, b] = ['a'.repeat(32), 'b'.repeat(32)];
  assert.equal(clientIdFromToken(a), clientIdFromToken(a));
  assert.notEqual(clientIdFromToken(a), clientIdFromToken(b));
  assert.match(clientIdFromToken(a), /^tok_[0-9a-f]{16}$/);
  assert.ok(!clientIdFromToken(a).includes(a));
});

test('client: resolveClient accepts only the server token and fails closed otherwise', () => {
  const token = 'k'.repeat(32);
  const resolve = makeResolveClient(token);
  const req = authorization => ({ headers: { authorization } });
  assert.equal(resolve(req('Bearer ' + token)), clientIdFromToken(token));
  for (const bad of [undefined, '', 'Bearer', 'Bearer ', 'Bearer  ' + token, 'bearer ' + token, token, 'Bearer ' + token + 'x', 'Bearer ' + token.slice(1), 'Bearer a b', 42, null, ['Bearer ' + token]]) assert.equal(resolve(req(bad)), null, String(bad));
  for (const r of [undefined, null, {}, { headers: null }, 'x']) assert.equal(resolve(r), null);
});

test('client: ownsCapture is true only for an identical well-formed id and fails closed on bad input', () => {
  const id = clientIdFromToken('a'.repeat(32)); const other = clientIdFromToken('b'.repeat(32));
  assert.equal(ownsCapture(id, { client_id: id }), true);
  assert.equal(ownsCapture(other, { client_id: id }), false);
  for (const bad of [undefined, null, '', 'tok_', 'tok_xyz', id.toUpperCase(), id + '0', ' ' + id, 7, {}, [id]]) {
    assert.equal(ownsCapture(bad, { client_id: id }), false, 'caller ' + String(bad));
    assert.equal(ownsCapture(id, { client_id: bad }), false, 'owner ' + String(bad));
    assert.equal(ownsCapture(bad, { client_id: bad }), false, 'both ' + String(bad));
  }
  for (const m of [undefined, null, {}, 'x', []]) assert.equal(ownsCapture(id, m), false);
});

test('client: the token never appears in logs, responses or capture metadata; client_id is not in responses', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'client-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await startFixture({ duplicate: false }); t.after(() => f.server.close());
  const token = 'Zq9' + 'w'.repeat(29);
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.join(' '));
  t.after(() => Object.assign(console, orig));
  const srv = createServer({ env: { CRAWL_TOKEN: token, CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_CAPTURE_DIR: dir }, crawl: runCrawl });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}`;
  const bodies = [];
  for (const auth of ['Bearer ' + token, 'Bearer wrong' + token]) {
    const res = await fetch(url + '/v1/crawl', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ start_urls: [f.base + '/inventory/3'], mode: 'page', capture: true }) });
    bodies.push(await res.text());
  }
  bodies.push(await (await fetch(url + '/healthz')).text());
  const out = JSON.parse(bodies[0]);
  const meta = await readFile(join(dir, out.records[0].capture_id + '.json'), 'utf8');
  const id = clientIdFromToken(token);
  assert.equal(JSON.parse(meta).client_id, id);
  for (const text of [...bodies, ...logged, meta]) assert.ok(!text.includes(token), 'token leaked');
  for (const text of bodies) assert.ok(!text.includes(id), 'client_id is not exposed in responses');
});
