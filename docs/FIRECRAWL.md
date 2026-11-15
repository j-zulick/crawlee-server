# Using Firecrawl

crawlee-server works without Firecrawl (plain HTTP only). Add it to handle pages that are built by JavaScript or
that refuse plain HTTP clients.

## Enable

| Variable | Example |
|---|---|
| `FIRECRAWL_URL` | `https://firecrawl.example.com` (self-hosted) or `https://api.firecrawl.dev` |
| `FIRECRAWL_API_KEY_FILE` | `/run/secrets/firecrawl.key` (mounted read-only; `FIRECRAWL_API_KEY` also works) |
| `FIRECRAWL_MAX_RENDERS` | renders allowed per crawl, default 25 |
| `FIRECRAWL_CONCURRENCY` | parallel Firecrawl calls, default 2 |
| `FIRECRAWL_TIMEOUT_MS` | per call, default 45000 |

`GET /healthz` then shows `"firecrawl": true`. The API calls used are `POST /v1/scrape` (`formats: ["rawHtml"]`) and
`POST /v1/map`; both exist in self-hosted Firecrawl and the hosted API.

## Per request

| `render` | Behaviour |
|---|---|
| `auto` (default) | plain HTTP first; Firecrawl for pages that look JavaScript-built, listing pages with no listing, and pages whose plain fetch failed |
| `always` | every page through Firecrawl (slow, costly; use with a small `max_pages`) |
| `never` | plain HTTP only, even when Firecrawl is configured |

`mode: "map"` asks Firecrawl for the site's URLs and crawls those that match `include_patterns` and not
`exclude_patterns`. Use it for sites without a sitemap.

## Reading the result

```json
"firecrawl": {
  "enabled": true, "render": "auto",
  "pages_rendered": 6, "http_failures_recovered": 2, "map_urls_found": 0,
  "render_budget_skips": 0, "failures": []
}
```

Each record has `fetched_via: "http"` or `"firecrawl"`. Failures list the URL and an outcome such as `timeout`,
`rate_limited`, `unauthorized` or `http_500`; the key itself never appears.
