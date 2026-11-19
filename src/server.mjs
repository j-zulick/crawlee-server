// HTTP front for runCrawl. Bind to 127.0.0.1 / a private Docker network only; the
// research gateway is the only intended caller. Token: CRAWL_TOKEN_FILE (owner-only file).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCrawl, crawlPolicy, BadRequest } from './crawl.mjs';
import { UrlRefused } from './ssrf.mjs';
import { storeFor, isCaptureId, sha256Hex, captureMacKey } from './capture.mjs';
import { makeResolveClient, ownsCapture } from './client.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function createServer({ env = process.env, crawl = runCrawl } = {}) {
  const base = crawlPolicy(env);
  const token = env.CRAWL_TOKEN_FILE ? readFileSync(env.CRAWL_TOKEN_FILE, 'utf8').trim() : env.CRAWL_TOKEN || '';
  if (token.length < 24) throw Error('CRAWL_TOKEN_FILE must hold a token of 24+ characters');
  // Captures are written and read with a metadata MAC keyed from the token.
  const policy = { ...base, capture: Object.freeze({ ...base.capture, macKey: captureMacKey(token) }) };
  const resolveClient = makeResolveClient(token);
  const maxQueued = Number(env.CRAWL_MAX_QUEUED || 2);
  let running = 0; const waiters = [];
  const acquire = () => (running < 1 ? (running++, Promise.resolve()) : waiters.length >= maxQueued ? Promise.reject(Object.assign(Error('busy'), { busy: true })) : new Promise(r => waiters.push(r)));
  const release = () => { const n = waiters.shift(); if (n) n(); else running--; };
  let served = 0;

  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), 'cache-control': 'no-store' }); res.end(b); };

  // Capture reads bypass the crawl queue. Fixed-window limit per client (CRAWL_CAPTURE_READS_PER_MIN, default 60).
  const readLimit = Number.isInteger(Number(env.CRAWL_CAPTURE_READS_PER_MIN)) && Number(env.CRAWL_CAPTURE_READS_PER_MIN) > 0 ? Number(env.CRAWL_CAPTURE_READS_PER_MIN) : 60;
  const reads = new Map();
  const allowRead = (id, now = Date.now()) => {
    const w = Math.floor(now / 60_000); const r = reads.get(id);
    if (!r || r.w !== w) { reads.clear(); reads.set(id, { w, n: 1 }); return true; }
    return ++r.n <= readLimit;
  };
  const META_FIELDS = ['capture_id', 'url', 'requested_url', 'fetched_at', 'http_status', 'content_type', 'size_bytes', 'sha256', 'fetch_method', 'rendered', 'recovered', 'crawl_id'];
  const safeHeader = v => (/^[\x20-\x7e]*$/.test(String(v)) ? String(v) : encodeURI(String(v)).replace(/[^\x20-\x7e]/g, ''));
  const safeType = v => (typeof v === 'string' && /^[\w.+-]+\/[\w.+-]+(; ?[\w.-]+=[\w.\-"]+)*$/.test(v) ? v : 'application/octet-stream');
  const NOT_FOUND = { error: 'capture_not_found' };

  async function serveCapture(req, res, clientId) {
    if (!allowRead(clientId)) return send(res, 429, { error: 'rate_limited', retry_after_s: 60 });
    const rest = req.url.slice('/v1/captures/'.length);
    const metaOnly = rest.endsWith('/meta');
    const id = metaOnly ? rest.slice(0, -5) : rest;
    if (!isCaptureId(id)) return send(res, 400, { error: 'invalid_capture_id' });
    const store = storeFor(policy.capture);
    const meta = await store.readMeta(id);
    // Unknown, expired and foreign captures take the same path and give the same answer.
    if (!ownsCapture(clientId, meta) || meta.capture_id !== id) return send(res, 404, NOT_FOUND);
    if (!store.metaIntact(meta)) { console.error('capture_corrupt', id); return send(res, 500, { error: 'capture_corrupt' }); }
    if (metaOnly) return send(res, 200, Object.fromEntries(META_FIELDS.filter(k => k in meta).map(k => [k, meta[k]])));
    const body = await store.readBody(id);
    if (!body) return send(res, 404, NOT_FOUND);
    if (sha256Hex(body) !== meta.sha256) { console.error('capture_corrupt', id); return send(res, 500, { error: 'capture_corrupt' }); }
    res.writeHead(200, {
      'content-type': safeType(meta.content_type), 'content-length': body.length, 'cache-control': 'no-store',
      'x-capture-sha256': meta.sha256, 'x-capture-fetched-at': safeHeader(meta.fetched_at), 'x-capture-url': safeHeader(meta.url), 'x-capture-crawl-id': safeHeader(meta.crawl_id),
      'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="capture-${id}.bin"`,
    });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, version: VERSION, firecrawl: !!policy.firecrawl, robots: policy.respectRobots ? 'respected' : 'ignored', running, queued: waiters.length, served });
      const clientId = resolveClient(req);
      if (!clientId) return send(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET' && req.url.startsWith('/v1/captures/')) return await serveCapture(req, res, clientId);
      if (req.method !== 'POST' || req.url !== '/v1/crawl') return send(res, 404, { error: 'not_found' });
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json_required' });
      let size = 0; const chunks = [];
      for await (const c of req) { size += c.length; if (size > 64_000) return send(res, 413, { error: 'body_too_large' }); chunks.push(c); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'invalid_json' }); }
      try { await acquire(); } catch { return send(res, 429, { error: 'busy', retry_after_s: 30 }); }
      try { const out = await crawl(body, policy, { clientId }); served++; return send(res, 200, out); }
      finally { release(); }
    } catch (e) {
      if (e instanceof BadRequest) return send(res, 400, { error: e.message });
      if (e instanceof UrlRefused) return send(res, 400, { error: 'url_refused', reason: e.reason, ...(e.refused && { refused: e.refused }) });
      console.error('crawl_error', e?.name, String(e?.message || '').slice(0, 200));
      return send(res, 500, { error: 'crawl_failed' });
    }
  });
  // Expired captures are removed now and then hourly, for as long as the server runs.
  server.on('close', storeFor(policy.capture).start());
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const host = process.env.CRAWL_BIND || '127.0.0.1'; const port = Number(process.env.CRAWL_PORT || 8794);
  createServer().listen(port, host, () => console.log(JSON.stringify({ msg: 'crawlee-server listening', host, port, version: VERSION })));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0));
}
