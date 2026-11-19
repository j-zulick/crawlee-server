// HTTP front for runCrawl. Bind to 127.0.0.1 / a private Docker network only; the
// research gateway is the only intended caller. Token: CRAWL_TOKEN_FILE (owner-only file).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runCrawl, crawlPolicy, BadRequest } from './crawl.mjs';
import { UrlRefused } from './ssrf.mjs';
import { storeFor, clientIdFromToken } from './capture.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const digest = s => createHash('sha256').update(String(s)).digest();

export function createServer({ env = process.env, crawl = runCrawl } = {}) {
  const policy = crawlPolicy(env);
  const token = env.CRAWL_TOKEN_FILE ? readFileSync(env.CRAWL_TOKEN_FILE, 'utf8').trim() : env.CRAWL_TOKEN || '';
  if (token.length < 24) throw Error('CRAWL_TOKEN_FILE must hold a token of 24+ characters');
  const want = digest('Bearer ' + token);
  const clientId = clientIdFromToken(token);
  const maxQueued = Number(env.CRAWL_MAX_QUEUED || 2);
  let running = 0; const waiters = [];
  const acquire = () => (running < 1 ? (running++, Promise.resolve()) : waiters.length >= maxQueued ? Promise.reject(Object.assign(Error('busy'), { busy: true })) : new Promise(r => waiters.push(r)));
  const release = () => { const n = waiters.shift(); if (n) n(); else running--; };
  let served = 0;

  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), 'cache-control': 'no-store' }); res.end(b); };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, version: VERSION, firecrawl: !!policy.firecrawl, robots: policy.respectRobots ? 'respected' : 'ignored', running, queued: waiters.length, served });
      if (!timingSafeEqual(digest(req.headers.authorization || ''), want)) return send(res, 401, { error: 'unauthorized' });
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
      if (e instanceof UrlRefused) return send(res, 400, { error: 'url_refused', reason: e.reason });
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
