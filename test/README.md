# Tests

The suite is offline: it starts a local fixture site (`fixture-site.mjs`) and a fake Firecrawl API, so no internet or
Firecrawl instance is needed. It uses Node's built-in test runner (`node:test`); there are no extra dependencies.

## Run

```bash
npm ci
npm test                                  # all tests
node --test test/service.test.mjs         # one file
node --test --test-name-pattern=ssrf test/*.test.mjs   # tests whose name matches
npm run check                             # syntax check of src/*.mjs, then the tests
```

## Files

| File | Covers |
|---|---|
| `service.test.mjs` | HTTP API, crawl modes, limits, extraction, SSRF guard |
| `firecrawl.test.mjs` | Rendering, blocked-page recovery, `mode=map`, render budget (fake Firecrawl) |
| `crawl-response.test.mjs` | Response shape against `crawl-response.schema.json` |
| `capture.test.mjs` | Page captures: byte-identical body and SHA-256, redirects, size caps, unwritable directory, atomic writes (SIGKILL mid-write), TTL sweep |
| `fixture-site.mjs` | Helper, not a test: the local site the crawls run against |

## Coverage

```bash
npm run coverage
```

This runs the same tests with Node's built-in coverage for `src/**` and fails if a total falls below:

| Metric | Minimum | At introduction |
|---|---|---|
| Lines | 95% | 98.9% |
| Functions | 85% | 89.1% |
| Branches | 70% | 77.0% |

The thresholds sit a little under the current numbers so normal changes don't trip them. Raise them in the `coverage`
script in `package.json` when coverage improves; don't lower them to land a change, add tests instead. The README badge
is static and states the line threshold, so update it if you change that number. CI runs `npm test` only; coverage is
checked locally. Needs Node 22.8 or newer.

## Add a test

1. Put it in an existing `*.test.mjs` file, or create `test/<topic>.test.mjs` (the `test/*.test.mjs` glob finds it).
2. Use `node:test` and `node:assert/strict`, ES modules, as the existing files do.
3. Crawl the fixture site, never a real one. Extend `fixture-site.mjs` if you need a new page, and stub Firecrawl with
   the fake used in `firecrawl.test.mjs`.
4. Run the file, then `npm run coverage`.
