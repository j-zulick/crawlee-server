import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startFixture } from './fixture-site.mjs';
import { runCrawl, crawlPolicy } from '../src/crawl.mjs';
import { createServer } from '../src/server.mjs';

const schema = JSON.parse(await readFile(new URL('./crawl-response.schema.json', import.meta.url), 'utf8'));

// Minimal validator for the JSON Schema keywords used in the schema file (no extra dependency).
function validate(value, s, path = '$') {
  const errors = [];
  const typeOk = { object: v => v !== null && typeof v === 'object' && !Array.isArray(v), array: Array.isArray, string: v => typeof v === 'string', boolean: v => typeof v === 'boolean', number: v => typeof v === 'number' && Number.isFinite(v), integer: Number.isInteger };
  if (s.enum && !s.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(s.enum)}`];
  if (s.type) {
    if (!typeOk[s.type](value)) return [`${path}: expected ${s.type}, got ${JSON.stringify(value)}`];
    if (typeof value === 'number' && s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
    if (typeof value === 'string' && s.pattern && !new RegExp(s.pattern).test(value)) errors.push(`${path}: does not match ${s.pattern}`);
    if (typeof value === 'string' && s.minLength !== undefined && value.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (s.type === 'array') {
      if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
      if (s.items) value.forEach((v, i) => errors.push(...validate(v, s.items, `${path}[${i}]`)));
    }
    if (s.type === 'object') {
      for (const k of s.required || []) if (!(k in value)) errors.push(`${path}: missing ${k}`);
      for (const [k, sub] of Object.entries(s.properties || {})) if (k in value) errors.push(...validate(value[k], sub, `${path}.${k}`));
      if (s.additionalProperties) for (const [k, v] of Object.entries(value)) if (!s.properties?.[k]) errors.push(...validate(v, s.additionalProperties, `${path}.${k}`));
    }
  }
  return errors;
}

test('validator rejects malformed responses', () => {
  assert.ok(validate({}, schema).length > 0);
  assert.ok(validate({ status: 'bogus' }, schema).some(e => e.includes('status')));
  const bad = { records: [{ capture_id: 'guessable', sha256: 'ABC', fetched_at: 'yesterday' }], capture: { enabled: false } };
  const errs = validate(bad, schema).join('\n');
  for (const k of ['capture_id', 'sha256', 'fetched_at', 'capture.enabled']) assert.ok(errs.includes(k), k);
});

test('/v1/crawl response with capture on matches the JSON schema, with capture fields on every record', async t => {
  const { server, base } = await startFixture({ duplicate: false });
  t.after(() => server.close());
  const dir = await mkdtemp(join(tmpdir(), 'capture-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_MAX_SECONDS: '60', CRAWL_CAPTURE_DIR: dir };
  const out = await runCrawl({ start_urls: [base + '/inventory'], profile: 'vehicle', include_patterns: [base + '/inventory/*'], max_pages: 4, capture: true }, crawlPolicy(env));
  assert.deepEqual(validate(out, schema), []);
  assert.ok(out.records.length > 0);
  assert.ok(out.records.every(r => r.capture_id && r.sha256 && r.fetched_at));
  assert.equal(out.capture.stored, out.records.length);
  const off = await runCrawl({ start_urls: [base + '/inventory/1'], mode: 'page' }, crawlPolicy(env));
  assert.deepEqual(validate(off, schema), []);
  assert.ok(!('capture' in off));
});

test('/v1/crawl response matches the JSON schema', async t => {
  const { server, base } = await startFixture({ duplicate: false });
  t.after(() => server.close());
  const token = 'x'.repeat(32);
  const srv = createServer({ env: { CRAWL_TOKEN: token, CRAWL_ALLOW_PRIVATE_HOSTS: '127.0.0.1', CRAWL_MAX_SECONDS: '60' }, crawl: runCrawl });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const post = async body => {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/v1/crawl`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const withRecords = await post({ start_urls: [base + '/inventory'], profile: 'vehicle', include_patterns: [base + '/inventory/*'], max_pages: 5, max_depth: 2 });
  assert.deepEqual(validate(withRecords, schema), []);
  assert.ok(withRecords.records.length > 0);
  assert.equal(withRecords.stats.stopped, 'max_pages');

  const dead = await startFixture({ duplicate: false });
  await new Promise(r => dead.server.close(r));
  const withFailures = await post({ start_urls: [dead.base + '/inventory'], mode: 'page' });
  assert.deepEqual(validate(withFailures, schema), []);
  assert.equal(withFailures.status, 'failed');
  assert.ok(withFailures.failures.length > 0);
});
