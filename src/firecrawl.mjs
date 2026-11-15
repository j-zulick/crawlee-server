// Firecrawl as the crawler's rendering and discovery backend.
//   scrapeHtml(url): the page as rendered by Firecrawl's browser (POST /v1/scrape, formats: rawHtml), for pages
//                    whose data is filled in by JavaScript or whose plain HTTP fetch was blocked.
//   map(url):        the site's URLs (POST /v1/map), to seed a crawl when there is no sitemap.
// Crawlee stays in charge of the queue, limits, robots.txt, SSRF checks and extraction; Firecrawl only fetches.
// Off unless FIRECRAWL_URL is set. The API key is read from FIRECRAWL_API_KEY_FILE (or FIRECRAWL_API_KEY) and is
// never returned, logged or included in errors.
import { readFileSync } from 'node:fs';

export function firecrawlPolicy(env = {}) {
  const url = (env.FIRECRAWL_URL || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  let parsed; try { parsed = new URL(url); } catch { throw Error('FIRECRAWL_URL is not a valid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Error('FIRECRAWL_URL must be http(s)');
  let key = '';
  if (env.FIRECRAWL_API_KEY_FILE) key = readFileSync(env.FIRECRAWL_API_KEY_FILE, 'utf8').trim();
  else if (env.FIRECRAWL_API_KEY) key = String(env.FIRECRAWL_API_KEY).trim();
  const int = (v, d, lo, hi) => { const n = v === undefined || v === '' ? d : Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
  return Object.freeze({
    url, key,
    timeoutMs: int(env.FIRECRAWL_TIMEOUT_MS, 45000, 5000, 120000),
    concurrency: int(env.FIRECRAWL_CONCURRENCY, 2, 1, 8),
    maxRendersPerCrawl: int(env.FIRECRAWL_MAX_RENDERS, 25, 0, 300),
    maxHtmlBytes: int(env.FIRECRAWL_MAX_HTML_BYTES, 5_000_000, 100_000, 20_000_000),
  });
}

export class Firecrawl {
  constructor(policy, { fetcher = fetch } = {}) {
    this.policy = policy; this.fetcher = fetcher; this.active = 0; this.waiters = [];
  }
  get enabled() { return !!this.policy; }

  async #slot(fn) {
    if (this.active >= this.policy.concurrency) await new Promise(r => this.waiters.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; const n = this.waiters.shift(); if (n) n(); }
  }

  async #post(path, body, signal) {
    const signals = [AbortSignal.timeout(this.policy.timeoutMs)]; if (signal) signals.push(signal);
    const headers = { 'content-type': 'application/json' };
    if (this.policy.key) headers.authorization = 'Bearer ' + this.policy.key;
    const res = await this.fetcher(this.policy.url + path, { method: 'POST', redirect: 'error', signal: AbortSignal.any(signals), headers, body: JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) return { ok: false, outcome: 'unauthorized' };
    if (res.status === 429) return { ok: false, outcome: 'rate_limited' };
    if (!res.ok) return { ok: false, outcome: 'http_' + res.status };
    const text = await res.text();
    if (text.length > this.policy.maxHtmlBytes * 1.5) return { ok: false, outcome: 'too_large' };
    try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, outcome: 'invalid_json' }; }
  }

  // -> { ok: true, html, final_url, status_code } | { ok: false, outcome }
  async scrapeHtml(url, { signal } = {}) {
    if (!this.enabled) return { ok: false, outcome: 'not_configured' };
    return this.#slot(async () => {
      try {
        const r = await this.#post('/v1/scrape', { url, formats: ['rawHtml'], onlyMainContent: false, timeout: this.policy.timeoutMs - 2000 }, signal);
        if (!r.ok) return r;
        const data = r.body?.data || {};
        const html = typeof data.rawHtml === 'string' ? data.rawHtml : typeof data.html === 'string' ? data.html : '';
        if (!r.body?.success || !html.trim()) return { ok: false, outcome: 'empty' };
        if (html.length > this.policy.maxHtmlBytes) return { ok: false, outcome: 'too_large' };
        const meta = data.metadata || {};
        const final = typeof meta.url === 'string' ? meta.url : typeof meta.sourceURL === 'string' ? meta.sourceURL : url;
        const code = Number.isInteger(meta.statusCode) ? meta.statusCode : null;
        if (code !== null && code >= 400) return { ok: false, outcome: 'target_http_' + code };
        return { ok: true, html, final_url: final, status_code: code };
      } catch (e) {
        return { ok: false, outcome: e?.name === 'TimeoutError' ? 'timeout' : signal?.aborted ? 'cancelled' : 'transport_error' };
      }
    });
  }

  // -> { ok: true, links: [url, ...] } | { ok: false, outcome }. Same-hostname http(s) links only.
  async map(url, { limit = 300, signal } = {}) {
    if (!this.enabled) return { ok: false, outcome: 'not_configured' };
    return this.#slot(async () => {
      try {
        const r = await this.#post('/v1/map', { url, limit, includeSubdomains: false }, signal);
        if (!r.ok) return r;
        if (!r.body?.success || !Array.isArray(r.body.links)) return { ok: false, outcome: 'empty' };
        const host = new URL(url).hostname.toLowerCase(); const seen = new Set(); const links = [];
        for (const l of r.body.links) {
          let u; try { u = new URL(typeof l === 'string' ? l : l?.url); } catch { continue; }
          if (!['http:', 'https:'].includes(u.protocol) || u.hostname.toLowerCase() !== host || u.username || u.password) continue;
          u.hash = ''; if (seen.has(u.href)) continue; seen.add(u.href); links.push(u.href);
          if (links.length >= limit) break;
        }
        return { ok: true, links };
      } catch (e) {
        return { ok: false, outcome: e?.name === 'TimeoutError' ? 'timeout' : 'transport_error' };
      }
    });
  }
}

// A page whose listing data is probably filled in by JavaScript: almost no visible text but scripts present,
// a "please enable JavaScript" notice, or an empty single-page-app root element.
export function looksClientRendered($) {
  const body = $('body');
  const text = body.clone().find('script,style,noscript,template').remove().end().text().replace(/\s+/g, ' ').trim();
  if ($('script[type="application/ld+json"]').length && text.length >= 20) return false;
  // Data blocks (JSON-LD, JSON) are content, not code: a server-rendered page with JSON-LD is not client-rendered.
  const scripts = $('script').filter((_, el) => !/json/i.test($(el).attr('type') || '')).length;
  if (text.length < 200 && scripts > 0) return true;
  if (/enable javascript|requires javascript|javascript is (disabled|required)/i.test($('noscript').text()) && text.length < 1500) return true;
  const root = $('#root, #app, #__next, [data-reactroot]').first();
  return root.length > 0 && root.text().trim().length === 0 && text.length < 1500;
}
