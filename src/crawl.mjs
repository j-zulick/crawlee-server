// One bounded crawl = one fresh in-memory Crawlee storage. No disk state, no shared queue.
import { Configuration, RequestQueue, ProxyConfiguration, log, LogLevel } from '@crawlee/cheerio';
import { randomUUID } from 'node:crypto';
import { checkUrl, UrlRefused } from './ssrf.mjs';
import { load } from 'cheerio';
import { extractVehicle, extractGeneric, looksLikeListing } from './extract.mjs';
import { capturePolicy, storeFor, CapturingCheerioCrawler } from './capture.mjs';
import { Firecrawl, firecrawlPolicy, looksClientRendered } from './firecrawl.mjs';

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
    userAgent: env.CRAWL_USER_AGENT || (env.CRAWL_IGNORE_ROBOTS === 'true' ? 'crawlee-server/2.0 (+self-hosted)' : 'crawlee-server/2.0 (+self-hosted; respects robots.txt)'),
    firecrawl: firecrawlPolicy(env),
    capture: capturePolicy(env),
  });
}

export class BadRequest extends Error { constructor(m) { super(m); this.name = 'BadRequest'; } }

export function validateRequest(body, policy) {
  if (!body || typeof body !== 'object') throw new BadRequest('body_must_be_object');
  const start = Array.isArray(body.start_urls) ? body.start_urls : body.url ? [body.url] : [];
  if (!start.length || start.length > 10 || !start.every(u => typeof u === 'string' && u.length < 2048)) throw new BadRequest('start_urls_1_to_10');
  const mode = body.mode ?? 'crawl';
  if (!['page', 'crawl', 'sitemap', 'map'].includes(mode)) throw new BadRequest('mode_must_be_page_crawl_sitemap_or_map');
  let render = body.render ?? 'auto';
  if (!['auto', 'never', 'always'].includes(render)) throw new BadRequest('render_must_be_auto_never_or_always');
  if (!policy.firecrawl) {
    if (render === 'always' || mode === 'map') throw new BadRequest('firecrawl_not_configured');
    render = 'never';
  }
  if (body.capture !== undefined && typeof body.capture !== 'boolean') throw new BadRequest('capture_must_be_boolean');
  const profile = body.profile ?? 'generic';
  if (!['vehicle', 'generic'].includes(profile)) throw new BadRequest('profile_must_be_vehicle_or_generic');
  const strs = (v, name, max = 20) => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > max || !v.every(s => typeof s === 'string' && s.length < 300)) throw new BadRequest(name + '_invalid'); return v; };
  const selectors = body.selectors ?? {};
  if (typeof selectors !== 'object' || Array.isArray(selectors) || Object.keys(selectors).length > 20 || !Object.values(selectors).every(s => typeof s === 'string' && s.length < 300)) throw new BadRequest('selectors_invalid');
  const int = (v, d, lo, hi) => { const n = v === undefined ? d : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new BadRequest('number_out_of_range'); return n; };
  return {
    start_urls: start, mode, profile, selectors, render,
    include: strs(body.include_patterns, 'include_patterns'),
    exclude: strs(body.exclude_patterns, 'exclude_patterns'),
    link_selector: typeof body.link_selector === 'string' && body.link_selector.length < 300 ? body.link_selector : 'a[href]',
    max_pages: int(body.max_pages, 50, 1, policy.maxPages),
    max_depth: int(body.max_depth, 2, 0, policy.maxDepth),
    concurrency: int(body.concurrency, 3, 1, policy.maxConcurrency),
    listings_only: body.listings_only !== false,
    capture: body.capture ?? policy.capture.byDefault,
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

export async function runCrawl(reqBody, policy = crawlPolicy(process.env), { fetcher = fetch, firecrawlFetcher = fetch, clientId = null } = {}) {
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
  const fc = new Firecrawl(policy.firecrawl, { fetcher: firecrawlFetcher });
  const fcStats = { rendered: 0, fallback_after_http_failure: 0, failures: [], budget_skips: 0, map_urls: 0 };

  // Fetch one page through Firecrawl's browser. Returns { $, finalUrl } or null (and records why).
  const render = async url => {
    if (fcStats.rendered + fcStats.failures.length >= policy.firecrawl.maxRendersPerCrawl) { fcStats.budget_skips++; return null; }
    const r = await fc.scrapeHtml(url);
    if (!r.ok) { fcStats.failures.push({ url, outcome: r.outcome }); return null; }
    let finalUrl = r.final_url || url;
    try { await checkUrl(finalUrl, policy); } catch (e) { refused.push({ url: finalUrl, reason: e instanceof UrlRefused ? e.reason : 'invalid_url' }); return null; }
    if (!onSite(finalUrl)) { refused.push({ url: finalUrl, reason: 'redirected_off_site' }); return null; }
    fcStats.rendered++;
    // The rendered HTML that extraction uses is what gets captured (as UTF-8), marked as rendered.
    const source = req.capture ? { bytes: Buffer.from(r.html, 'utf8'), url: finalUrl, requested_url: url, fetched_at: new Date(), http_status: r.status_code, content_type: 'text/html; charset=utf-8', rendered: true } : null;
    return { $: load(r.html), finalUrl, source };
  };
  const linksFrom = ($, pageUrl) => {
    const out = new Set();
    $(req.link_selector).each((_, el) => { const h = $(el).attr('href'); if (!h) return; try { const u = new URL(h, pageUrl); u.hash = ''; if (['http:', 'https:'].includes(u.protocol) && wanted(u.href)) out.add(u.href); } catch {} });
    return [...out];
  };
  // Captures are stored for pages that yield a record. Problems never fail the crawl; they become limitations.
  const cap = { problem: null, stored: 0, notStored: {} };
  const store = req.capture ? storeFor(policy.capture) : null;
  if (store) cap.problem = await store.problem();
  const capture = async (source, via, recovered) => {
    if (!store || !source) return {};
    const miss = reason => { (cap.notStored[reason] ??= []).push(source.url); return {}; };
    if (cap.problem) return miss('unavailable');
    const w = await store.write(source.bytes, {
      url: source.url, requested_url: source.requested_url, fetched_at: source.fetched_at.toISOString(), http_status: source.http_status,
      content_type: source.content_type, fetch_method: via, rendered: source.rendered, recovered, client_id: clientId, crawl_id: id,
    });
    if (!w.ok) { if (w.reason === 'write_failed') cap.problem = 'capture_write_failed'; return miss(w.reason); }
    cap.stored++;
    return { capture_id: w.meta.capture_id, sha256: w.meta.sha256, fetched_at: w.meta.fetched_at };
  };
  // Extraction shared by both fetch paths; `via` records how the page was fetched.
  const emit = async ($, finalUrl, via, source, recovered = false) => {
    if (include.length && !isDetail(finalUrl)) return; // index / navigation page: follow links, emit nothing
    if (req.profile === 'vehicle') {
      const rec = extractVehicle($, finalUrl, { selectors: req.selectors });
      if (req.listings_only && !looksLikeListing(rec)) return;
      const key = rec.vin || finalUrl;
      if (byKey.has(key)) { duplicates++; byKey.get(key).duplicate_urls.push(finalUrl); return; }
      const out = { ...rec, fetched_via: via, duplicate_urls: [] }; byKey.set(key, out); records.push(out);
      Object.assign(out, await capture(source, via, recovered));
    } else {
      const out = { ...extractGeneric($, finalUrl, { fields: req.selectors }), fetched_via: via }; records.push(out);
      Object.assign(out, await capture(source, via, recovered));
    }
  };
  // render=auto: re-fetch through Firecrawl when the HTML looks JavaScript-built, or when a page that should be a
  // listing (matches include_patterns) yields no listing from the plain HTML.
  const needsRender = ($, finalUrl) => {
    if (req.render === 'always') return true;
    if (req.render !== 'auto') return false;
    if (looksClientRendered($)) return true;
    if (req.profile === 'vehicle' && include.length && isDetail(finalUrl)) return !looksLikeListing(extractVehicle($, finalUrl, { selectors: req.selectors }));
    return false;
  };

  const config = new Configuration({ persistStorage: false, purgeOnStart: true, availableMemoryRatio: 0.5 });
  const queue = await RequestQueue.open(id, { config });
  let seeds = req.start_urls;
  if (req.mode === 'sitemap') {
    const fromMap = [];
    for (const s of req.start_urls) fromMap.push(...await sitemapUrls(s, policy, req.max_pages, fetcher).catch(e => { failures.push({ url: s, error: e instanceof UrlRefused ? e.reason : 'sitemap_unavailable' }); return []; }));
    seeds = fromMap.filter(u => wanted(u) && isDetail(u));
    if (!seeds.length) seeds = req.start_urls;
  } else if (req.mode === 'map') {
    const found = [];
    for (const s of req.start_urls) {
      const r = await fc.map(s, { limit: Math.min(req.max_pages * 4, 1000) });
      if (r.ok) found.push(...r.links); else fcStats.failures.push({ url: s, outcome: 'map_' + r.outcome });
    }
    fcStats.map_urls = found.length;
    seeds = [...new Set(found)].filter(u => wanted(u) && isDetail(u));
    if (!seeds.length) seeds = req.start_urls;
  }
  await queue.addRequests(seeds.slice(0, req.max_pages).map(u => ({ url: u, userData: { depth: 0 } })));

  const crawler = new CapturingCheerioCrawler({
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
    async requestHandler({ request, $, response, enqueueLinks }) {
      const finalUrl = request.loadedUrl || request.url;
      if (finalUrl !== request.url) await checkUrl(finalUrl, policy);
      const depth = request.userData.depth ?? 0;
      if (!onSite(finalUrl)) { refused.push({ url: finalUrl, reason: 'redirected_off_site' }); return; }
      if (depth > 0 && !wanted(finalUrl)) { refused.push({ url: finalUrl, reason: 'excluded_after_redirect' }); return; }
      pages++;
      let page$ = $, pageUrl = finalUrl, via = 'http', source = null;
      const raw = crawler.raw.get(request);
      if (req.capture && raw) {
        if (raw.over) (cap.notStored.too_large ??= []).push(finalUrl);
        else source = { bytes: Buffer.concat(raw.chunks), url: finalUrl, requested_url: request.url, fetched_at: raw.finishedAt || new Date(), http_status: response.statusCode, content_type: String(response.headers?.['content-type'] || '') || null, rendered: false };
      }
      if (needsRender($, finalUrl)) {
        const r = await render(finalUrl);
        if (r) { page$ = r.$; pageUrl = r.finalUrl; via = 'firecrawl'; source = r.source; }
      }
      if (req.mode === 'crawl' && depth < req.max_depth) {
        if (via === 'http') {
          await enqueueLinks({
            selector: req.link_selector, strategy: 'same-hostname',
            transformRequestFunction: r => (wanted(r.url) ? { ...r, userData: { depth: depth + 1 } } : false),
          });
        } else {
          const urls = linksFrom(page$, pageUrl);
          if (urls.length) await enqueueLinks({ urls, transformRequestFunction: r => ({ ...r, userData: { depth: depth + 1 } }) });
        }
      }
      await emit(page$, pageUrl, via, source);
    },
    async failedRequestHandler({ request, error }) {
      const reason = error instanceof UrlRefused ? error.reason : String(error?.message || error).slice(0, 160);
      // Plain HTTP failed (blocked, 403, timeout): try the same URL through Firecrawl before giving up.
      if (!(error instanceof UrlRefused) && req.render !== 'never') {
        const r = await render(request.url);
        if (r) {
          fcStats.fallback_after_http_failure++; pages++;
          const depth = request.userData.depth ?? 0;
          if (req.mode === 'crawl' && depth < req.max_depth) {
            const urls = linksFrom(r.$, r.finalUrl);
            if (urls.length) await queue.addRequests(urls.map(u => ({ url: u, userData: { depth: depth + 1 } })));
          }
          await emit(r.$, r.finalUrl, 'firecrawl', r.source, true);
          return;
        }
      }
      failures.push({ url: request.url, error: reason });
    },
  }, config);
  if (store) crawler.captureLimit = policy.capture.maxBytes;

  const timer = setTimeout(() => { stoppedReason = 'time_budget'; crawler.stop('time budget reached'); }, policy.maxSeconds * 1000);
  try { await crawler.run(); } finally { clearTimeout(timer); await queue.drop().catch(() => {}); }
  if (!stoppedReason && pages >= req.max_pages) stoppedReason = 'max_pages';

  const capNote = [];
  if (cap.problem) capNote.push(`Page capture was requested but could not be written (${cap.problem}); records were returned without capture fields${cap.stored ? ' for the pages after the failure' : ''}.`);
  const names = { too_large: `exceeded CRAWL_CAPTURE_MAX_BYTES (${policy.capture.maxBytes} bytes)`, total_cap: `would exceed CRAWL_CAPTURE_MAX_TOTAL_BYTES (${policy.capture.maxTotalBytes} bytes)` };
  for (const [reason, urls] of Object.entries(cap.notStored)) if (names[reason]) capNote.push(`${urls.length} page(s) ${names[reason]} and were not stored: ${urls.slice(0, 5).join(', ')}${urls.length > 5 ? ', …' : ''}.`);
  const missing = records.filter(r => r.missing_required?.length).length;
  return {
    status: records.length ? (failures.length || cap.problem ? 'partial' : 'ok') : (failures.length || refused.length ? 'failed' : 'no_records'),
    crawl_id: id, profile: req.profile, mode: req.mode,
    firecrawl: { enabled: fc.enabled, render: req.render, pages_rendered: fcStats.rendered, http_failures_recovered: fcStats.fallback_after_http_failure, map_urls_found: fcStats.map_urls, render_budget_skips: fcStats.budget_skips, failures: fcStats.failures.slice(0, 20) },
    stats: { pages_fetched: pages, skipped: refused.length, links_not_followed: skippedCounts, records: records.length, duplicates, failures: failures.length, records_missing_required: missing, seconds: Math.round((Date.now() - started) / 100) / 10, stopped: stoppedReason },
    ...(store ? { capture: { enabled: true, stored: cap.stored, not_stored: Object.values(cap.notStored).reduce((n, u) => n + u.length, 0) } } : {}),
    records, failures: failures.slice(0, 50), refused: refused.slice(0, 50),
    limitations: [
      fc.enabled
        ? `Pages built by JavaScript or blocked for plain HTTP are fetched through Firecrawl (render=${req.render}, at most ${policy.firecrawl.maxRendersPerCrawl} per crawl); each record's fetched_via says how it was fetched.`
        : 'Static HTML only (Firecrawl not configured): data rendered by JavaScript is not seen.',
      'Fixed extraction (JSON-LD, microdata, then selectors). Records listing missing_required fields are candidates for LLM fallback.',
      ...(fcStats.failures.length ? [`Firecrawl failed for ${fcStats.failures.length} page(s) (${[...new Set(fcStats.failures.map(f => f.outcome))].join(', ')}); those pages were not rendered, so JavaScript-built data on them is missing.`] : []),
      ...capNote,
      policy.respectRobots ? 'robots.txt is respected; disallowed pages are listed under refused (skipped_robotsTxt).' : 'robots.txt checking is OFF.',
    ],
  };
}
