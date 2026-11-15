# Contributions

| Area | Who |
|---|---|
| 2025 prototype (Express API, basic/advanced/configurable crawlers, first Docker and Komodo deployment) | Built mainly by a contributor for Joe Zulick's deployment (see the Aug 2025 commits) |
| 2.0 requirements and design: service boundary, SSRF policy, provenance fields, Firecrawl strategy, the fictional "Ridgeline Motors" test site, deployment | Joe Zulick |
| 2.0 implementation, tests and docs | Joe Zulick, with AI coding assistance (Claude); every change reviewed and tested before release |
| Frameworks | Crawlee, Cheerio, zod ([NOTICES.md](../NOTICES.md)); Firecrawl as an external service |

Bugs found while testing 2.0 and fixed: block text fused across elements hid VINs; the start URL was dropped by
`exclude_patterns`; `*` in globs crossed `/`; skipped requests were silent; the slim image lacked `ps`, which made
every crawl fail inside Docker; JSON-LD `<script>` blocks made server-rendered pages look JavaScript-built.
