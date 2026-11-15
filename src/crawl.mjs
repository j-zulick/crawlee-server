// One bounded crawl = one fresh in-memory Crawlee storage. No disk state, no shared queue.
import { CheerioCrawler, Configuration, RequestQueue, ProxyConfiguration, log, LogLevel } from '@crawlee/cheerio';
import { randomUUID } from 'node:crypto';
import { checkUrl, UrlRefused } from './ssrf.mjs';
import { extractVehicle, extractGeneric, looksLikeListing } from './extract.mjs';

log.setLevel(process.env.CRAWL_LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.WARNING);

export function crawlPolicy(env = {}) {
  return Object.freeze({
    maxPages: Number(env.CRAWL_MAX_PAGES || 300),
    maxConcurrency: Number(env.CRAWL_MAX_CONCURRENCY || 5),
    maxSeconds: Number(env.CRAWL_MAX_SECONDS || 150),
    maxDepth: 3,
    allowPrivateHosts: new Set(String(env.CRAWL_ALLOW_PRIVATE_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)),
    respectRobots: env.CRAWL_IGNORE_ROBOTS !== 'true',
    proxyUrl: env.CRAWL_PROXY_URL || null,
    userAgent: env.CRAWL_USER_AGENT || 'crawlee-server/2.0 (+self-hosted; respects robots.txt)',
  });
}

export class BadRequest extends Error { constructor(m) { super(m); this.name = 'BadRequest'; } }

export function validateRequest(body, policy) {
  if (!body || typeof body !== 'object') throw new BadRequest('body_must_be_object');
  const start = Array.isArray(body.start_urls) ? body.start_urls : body.url ? [body.url] : [];
  if (!start.length || start.length > 10 || !start.every(u => typeof u === 'string' && u.length < 2048)) throw new BadRequest('start_urls_1_to_10');
  const mode = body.mode ?? 'crawl';
  if (!['page', 'crawl', 'sitemap'].includes(mode)) throw new BadRequest('mode_must_be_page_crawl_or_sitemap');
  const profile = body.profile ?? 'generic';
  if (!['vehicle', 'generic'].includes(profile)) throw new BadRequest('profile_must_be_vehicle_or_generic');
  const strs = (v, name, max = 20) => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > max || !v.every(s => typeof s === 'string' && s.length < 300)) throw new BadRequest(name + '_invalid'); return v; };
  const selectors = body.selectors ?? {};
  if (typeof selectors !== 'object' || Array.isArray(selectors) || Object.keys(selectors).length > 20 || !Object.values(selectors).every(s => typeof s === 'string' && s.length < 300)) throw new BadRequest('selectors_invalid');
  const int = (v, d, lo, hi) => { const n = v === undefined ? d : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new BadRequest('number_out_of_range'); return n; };
  return {
    start_urls: start, mode, profile, selectors,
    include: strs(body.include_patterns, 'include_patterns'),
    exclude: strs(body.exclude_patterns, 'exclude_patterns'),
    link_selector: typeof body.link_selector === 'string' && body.link_selector.length < 300 ? body.link_selector : 'a[href]',
    max_pages: int(body.max_pages, 50, 1, policy.maxPages),
    max_depth: int(body.max_depth, 2, 0, policy.maxDepth),
    concurrency: int(body.concurrency, 3, 1, policy.maxConcurrency),
    listings_only: body.listings_only !== false,
  };
}

async function sitemapUrls(startUrl, policy, cap, fetcher = fetch) {
  const origin = new URL(startUrl).origin;
  const candidates = new URL(startUrl).pathname.endsWith('.xml') ? [startUrl] : [origin + '/sitemap.xml'];
  const out = []; const seen = new Set();
  while (candidates.length && out.length < cap && seen.size < 10) {
    const sm = candidates.shift(); if (seen.has(sm)) continue; seen.add(sm);
    await checkUrl(sm, policy);
    const res = await fetcher(sm, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': policy.userAgent } });
    if (!res.ok) continue;
    const xml = (await res.text()).slice(0, 5_000_000);
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
    for (const l of locs) {
      let lu; try { lu = new URL(l); } catch { continue; }
      if (lu.origin !== origin) continue;
      if (/\.xml(\.gz)?$/i.test(lu.pathname) && /<sitemapindex/i.test(xml)) candidates.push(lu.href); else out.push(lu.href);
      if (out.length >= cap) break;
    }
  }
  return out;
}

const globToRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/?#]*').replace(/\u0000/g, '.*') + '$');

export async function runCrawl(reqBody, policy = crawlPolicy(process.env), { fetcher = fetch } = {}) {
  const req = validateRequest(reqBody, policy);
  const started = Date.now();
  const id = randomUUID();
  for (const u of req.start_urls) await checkUrl(u, policy);
  const hosts = new Set(req.start_urls.map(u => new URL(u).hostname.toLowerCase()));
  const include = req.include.map(globToRe); const exclude = req.exclude.map(globToRe);
  const onSite = u => hosts.has(new URL(u).hostname.toLowerCase());
  const wanted = u => onSite(u) && !exclude.some(r => r.test(u));  // applies to followed links, not start URLs
  const isDetail = u => !include.length || include.some(r => r.test(u));

  const records = []; const failures = []; const refused = []; const byKey = new Map();
  const skippedCounts = {}; let pages = 0; let duplicates = 0; let stoppedReason = null;

  const config = new Configuration({ persistStorage: false, purgeOnStart: true, availableMemoryRatio: 0.5 });
  const queue = await RequestQueue.open(id, { config });
  let seeds = req.start_urls;
  if (req.mode === 'sitemap') {
    const fromMap = [];
    for (const s of req.start_urls) fromMap.push(...await sitemapUrls(s, policy, req.max_pages, fetcher).catch(e => { failures.push({ url: s, error: e instanceof UrlRefused ? e.reason : 'sitemap_unavailable' }); return []; }));
    seeds = fromMap.filter(u => wanted(u) && isDetail(u));
    if (!seeds.length) seeds = req.start_urls;
  }
  await queue.addRequests(seeds.slice(0, req.max_pages).map(u => ({ url: u, userData: { depth: 0 } })));

  const crawler = new CheerioCrawler({
    requestQueue: queue,
    maxRequestsPerCrawl: req.max_pages,
    maxConcurrency: req.concurrency,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 30,
    navigationTimeoutSecs: 20,
    respectRobotsTxtFile: policy.respectRobots,
    ...(policy.proxyUrl ? { proxyConfiguration: new ProxyConfiguration({ proxyUrls: [policy.proxyUrl] }) } : {}),
    onSkippedRequest: ({ url, reason }) => { if (['filters', 'depth', 'limit', 'enqueueLimit'].includes(reason)) { skippedCounts[reason] = (skippedCounts[reason] || 0) + 1; return; } refused.push({ url, reason: 'skipped_' + reason }); },
    additionalMimeTypes: ['application/xhtml+xml'],
    preNavigationHooks: [async ({ request }, gotOptions) => {
      await checkUrl(request.url, policy);
      gotOptions.headers = { ...gotOptions.headers, 'user-agent': policy.userAgent };
      gotOptions.followRedirect = true; gotOptions.maxRedirects = 3;
    }],
    async requestHandler({ request, $, enqueueLinks }) {
      const finalUrl = request.loadedUrl || request.url;
      if (finalUrl !== request.url) await checkUrl(finalUrl, policy);
      const depth = request.userData.depth ?? 0;
      if (!onSite(finalUrl)) { refused.push({ url: finalUrl, reason: 'redirected_off_site' }); return; }
      if (depth > 0 && !wanted(finalUrl)) { refused.push({ url: finalUrl, reason: 'excluded_after_redirect' }); return; }
      pages++;
      if (req.mode === 'crawl' && depth < req.max_depth) {
        await enqueueLinks({
          selector: req.link_selector, strategy: 'same-hostname',
          transformRequestFunction: r => (wanted(r.url) ? { ...r, userData: { depth: depth + 1 } } : false),
        });
      }
      if (include.length && !isDetail(finalUrl)) return; // index / navigation page: follow links, emit nothing
      if (req.profile === 'vehicle') {
        const rec = extractVehicle($, finalUrl, { selectors: req.selectors });
        if (req.listings_only && !looksLikeListing(rec)) return;
        const key = rec.vin || finalUrl;
        if (byKey.has(key)) { duplicates++; byKey.get(key).duplicate_urls.push(finalUrl); return; }
        const out = { ...rec, duplicate_urls: [] }; byKey.set(key, out); records.push(out);
      } else {
        records.push(extractGeneric($, finalUrl, { fields: req.selectors }));
      }
    },
    failedRequestHandler({ request, error }) {
      failures.push({ url: request.url, error: error instanceof UrlRefused ? error.reason : String(error?.message || error).slice(0, 160) });
    },
  }, config);

  const timer = setTimeout(() => { stoppedReason = 'time_budget'; crawler.stop('time budget reached'); }, policy.maxSeconds * 1000);
  try { await crawler.run(); } finally { clearTimeout(timer); await queue.drop().catch(() => {}); }
  if (!stoppedReason && pages >= req.max_pages) stoppedReason = 'max_pages';

  const missing = records.filter(r => r.missing_required?.length).length;
  return {
    status: records.length ? (failures.length ? 'partial' : 'ok') : (failures.length || refused.length ? 'failed' : 'no_records'),
    crawl_id: id, profile: req.profile, mode: req.mode,
    stats: { pages_fetched: pages, skipped: refused.length, links_not_followed: skippedCounts, records: records.length, duplicates, failures: failures.length, records_missing_required: missing, seconds: Math.round((Date.now() - started) / 100) / 10, stopped: stoppedReason },
    records, failures: failures.slice(0, 50), refused: refused.slice(0, 50),
    limitations: [
      'Static HTML only (CheerioCrawler): data rendered by JavaScript is not seen; use read_page (Camoufox tier) for those pages.',
      'Fixed extraction (JSON-LD, microdata, then selectors). Records listing missing_required fields are candidates for LLM fallback.',
      policy.respectRobots ? 'robots.txt is respected; disallowed pages are listed under refused (skipped_robotsTxt).' : 'robots.txt checking is OFF.',
    ],
  };
}
