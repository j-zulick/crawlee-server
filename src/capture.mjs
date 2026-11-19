// Raw page captures: the exact bytes a crawl fetched, with a SHA-256 and the fetch time, so a record (or a citation
// built from it) can later be checked against what the server really received.
//
// Layout in CRAWL_CAPTURE_DIR, one pair per capture:  <capture_id>.body  and  <capture_id>.json
// Both are written under a ".tmp-" name, flushed, then renamed; the .json is renamed last. A capture exists only when
// its .json exists, so a half-written capture is never listed. Leftovers from a crash are removed by the sweep.
//
// Off unless a request sets `capture: true` (or CRAWL_CAPTURE_DEFAULT=true). Captured pages are third-party content:
// they stay in this directory and are never logged, returned in responses or put in the repo.
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { open, rename, rm, readdir, readFile, stat, access, constants } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import { CheerioCrawler } from '@crawlee/cheerio';

const ID_RE = /^[0-9a-f]{48}$/;
const DAY_MS = 86_400_000;
const STALE_TMP_MS = 3_600_000;

export function capturePolicy(env = {}) {
  const int = (v, d, lo) => { const n = v === undefined || v === '' ? d : Number(v); return Number.isInteger(n) && n >= lo ? n : d; };
  return Object.freeze({
    dir: (env.CRAWL_CAPTURE_DIR || '').trim() || null,
    byDefault: env.CRAWL_CAPTURE_DEFAULT === 'true',
    maxBytes: int(env.CRAWL_CAPTURE_MAX_BYTES, 5_000_000, 1),
    maxTotalBytes: int(env.CRAWL_CAPTURE_MAX_TOTAL_BYTES, 1_073_741_824, 1),
    ttlDays: int(env.CRAWL_CAPTURE_TTL_DAYS, 30, 1),
  });
}

// Stable id for the caller, derived from the bearer token (the token itself is never stored). Per-client tokens (2.4.0)
// can replace the input without changing the capture format.
export const clientIdFromToken = token => 'tok_' + createHmac('sha256', 'crawlee-server client-id v1').update(String(token)).digest('hex').slice(0, 16);

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
// 192 random bits, hex: unguessable, and safe to use as a file name.
export const newCaptureId = () => randomBytes(24).toString('hex');

export class CaptureStore {
  #used = null;       // bytes in finished captures (+ reserved by writes in flight); scanned on first use
  #hooks;
  constructor(cfg, { hooks = {} } = {}) { this.cfg = cfg; this.#hooks = hooks; }

  // null when usable, otherwise a short reason.
  async problem() {
    if (!this.cfg.dir) return 'capture_dir_not_configured';
    try { if (!(await stat(this.cfg.dir)).isDirectory()) return 'capture_dir_not_a_directory'; await access(this.cfg.dir, constants.W_OK); } catch (e) { return e.code === 'ENOENT' ? 'capture_dir_missing' : 'capture_dir_not_writable'; }
    return null;
  }

  async #usage() {
    if (this.#used === null) {
      let total = 0;
      for (const m of await this.list()) total += m.size_bytes;
      this.#used ??= total;
    }
    return this.#used;
  }

  // -> { ok: true, meta } | { ok: false, reason: 'too_large' | 'total_cap' | 'write_failed' }
  async write(bytes, meta, { now = Date.now() } = {}) {
    if (bytes.length > this.cfg.maxBytes) return { ok: false, reason: 'too_large' };
    let used; try { used = await this.#usage(); } catch { return { ok: false, reason: 'write_failed' }; }
    if (used + bytes.length > this.cfg.maxTotalBytes) return { ok: false, reason: 'total_cap' };
    this.#used += bytes.length;          // reserve before the first await so parallel writes cannot overshoot
    const id = newCaptureId();
    const full = { capture_id: id, ...meta, size_bytes: bytes.length, sha256: sha256Hex(bytes) };
    const tmp = n => join(this.cfg.dir, `.tmp-${id}.${n}`);
    const fin = n => join(this.cfg.dir, `${id}.${n}`);
    const put = async (path, data) => { const fh = await open(path, 'wx', 0o600); try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); } };
    try {
      await put(tmp('body'), bytes);
      await put(tmp('json'), JSON.stringify(full, null, 2) + '\n');
      await this.#hooks.beforeRename?.(id);
      await rename(tmp('body'), fin('body'));
      await rename(tmp('json'), fin('json'));
      return { ok: true, meta: full };
    } catch {
      this.#used -= bytes.length;
      await Promise.all(['body', 'json'].flatMap(n => [rm(tmp(n), { force: true }), rm(fin(n), { force: true })])).catch(() => {});
      return { ok: false, reason: 'write_failed' };
    }
  }

  // Finished captures only (those with a readable .json).
  async list() {
    const out = [];
    for (const f of await readdir(this.cfg.dir)) {
      if (!f.endsWith('.json') || !ID_RE.test(f.slice(0, -5))) continue;
      try { out.push(JSON.parse(await readFile(join(this.cfg.dir, f), 'utf8'))); } catch { /* unreadable: left for the sweep */ }
    }
    return out;
  }

  // Removes captures older than the TTL, plus stale temp files and bodies that never got their metadata.
  async sweep(now = Date.now()) {
    if (!this.cfg.dir) return { removed: 0 };
    let removed = 0; let names;
    try { names = await readdir(this.cfg.dir); } catch { return { removed: 0 }; }
    const set = new Set(names);
    const age = async f => now - (await stat(join(this.cfg.dir, f))).mtimeMs;
    const drop = async id => { await Promise.all([rm(join(this.cfg.dir, id + '.body'), { force: true }), rm(join(this.cfg.dir, id + '.json'), { force: true })]); removed++; };
    for (const f of names) {
      try {
        if (f.startsWith('.tmp-')) { if (await age(f) > STALE_TMP_MS) await rm(join(this.cfg.dir, f), { force: true }); continue; }
        const [id, ext] = [f.slice(0, f.lastIndexOf('.')), f.slice(f.lastIndexOf('.') + 1)];
        if (!ID_RE.test(id)) continue;                                   // not ours: never touched
        if (ext === 'body' && !set.has(id + '.json')) { if (await age(f) > STALE_TMP_MS) await drop(id); continue; }
        if (ext !== 'json') continue;
        let at; try { at = Date.parse(JSON.parse(await readFile(join(this.cfg.dir, f), 'utf8')).fetched_at); } catch { at = NaN; }
        if (Number.isNaN(at)) at = now - await age(f);
        if (now - at > this.cfg.ttlDays * DAY_MS) await drop(id);
      } catch { /* vanished or unreadable: try again next sweep */ }
    }
    if (removed) this.#used = null;
    return { removed };
  }

  // Startup sweep, then hourly. The timer does not keep the process alive.
  start() {
    if (!this.cfg.dir) return () => {};
    this.sweep().catch(() => {});
    const t = setInterval(() => this.sweep().catch(() => {}), 3_600_000); t.unref();
    return () => clearInterval(t);
  }
}

const stores = new Map();
export const storeFor = cfg => { const k = JSON.stringify(cfg); if (!stores.has(k)) stores.set(k, new CaptureStore(cfg)); return stores.get(k); };

// CheerioCrawler decodes the body to text before the request handler sees it, which loses invalid UTF-8, BOMs and
// other charsets. This subclass copies the bytes as they arrive (after content-decoding, before charset decoding),
// up to a limit, and records when the response finished. Only used when a crawl asks for captures.
export class CapturingCheerioCrawler extends CheerioCrawler {
  raw = new WeakMap();   // request -> { chunks, size, over, finishedAt }
  captureLimit = 0;
  _encodeResponse(request, response, encoding) {
    if (!this.captureLimit) return super._encodeResponse(request, response, encoding);
    const entry = { chunks: [], size: 0, over: false, finishedAt: null };
    const limit = this.captureLimit;
    const tap = new Transform({
      transform(chunk, _enc, cb) { entry.size += chunk.length; if (entry.size > limit) { entry.over = true; entry.chunks = []; } else if (!entry.over) entry.chunks.push(chunk); cb(null, chunk); },
      flush(cb) { entry.finishedAt = new Date(); cb(); },
    });
    response.on('error', e => tap.destroy(e));
    response.pipe(tap);
    for (const k of ['statusCode', 'statusMessage', 'headers', 'url', 'redirectUrls']) tap[k] = response[k];
    this.raw.set(request, entry);
    return super._encodeResponse(request, tap, encoding);
  }
}
