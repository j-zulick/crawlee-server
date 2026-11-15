// Minimal client: node examples/client.mjs <start-url> [include-glob]
// Needs CRAWL_URL (default http://127.0.0.1:8794) and CRAWL_TOKEN.
const [start, include] = process.argv.slice(2);
if (!start || !process.env.CRAWL_TOKEN) { console.error('usage: CRAWL_TOKEN=... node examples/client.mjs <start-url> [include-glob]'); process.exit(2); }
const res = await fetch((process.env.CRAWL_URL || 'http://127.0.0.1:8794') + '/v1/crawl', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.CRAWL_TOKEN },
  body: JSON.stringify({ start_urls: [start], ...(include ? { include_patterns: [include] } : {}), max_pages: 10 }),
});
const out = await res.json();
if (!res.ok) { console.error(res.status, out); process.exit(1); }
console.log(JSON.stringify({ status: out.status, stats: out.stats, firecrawl: out.firecrawl }, null, 2));
for (const r of out.records.slice(0, 5)) console.log(`- [${r.fetched_via}] ${r.title || r.listing_url}`);
