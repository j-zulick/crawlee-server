# Changelog

## Unreleased

- Non-HTML responses (e.g. a JSON 404) are reported as `failures: [{ url, error: "http_<status>" | "non_html" }]` instead of `$ is not a function`; extraction is skipped for them.
- `url_refused` (400) now lists the refused start URLs and the guard's reason in `refused`; no resolved IPs are returned.
- Docs: Komodo stack example (deploy/komodo/compose.yaml) and deployment guide.

## 2.2.0 — Nov 2026

### Added
- Page captures: `capture: true` stores the raw page body exactly as received (or Firecrawl's rendered HTML) with its
  SHA-256, fetch time, final and requested URL, status, content type, fetch method, `client_id` and `crawl_id`.
  Records gain `capture_id`, `sha256` and `fetched_at`. Off by default. See [docs/CAPTURE.md](docs/CAPTURE.md).
- Settings `CRAWL_CAPTURE_DIR`, `CRAWL_CAPTURE_DEFAULT`, `CRAWL_CAPTURE_MAX_BYTES`, `CRAWL_CAPTURE_MAX_TOTAL_BYTES`,
  `CRAWL_CAPTURE_TTL_DAYS`; expired captures are swept at startup and hourly.
- Client identity: `client_id` is an HMAC-SHA-256 of the bearer token; `resolveClient(request)` and a constant-time,
  fail-closed `ownsCapture` live in `src/client.mjs`. Rotating the token orphans older captures (see docs/CAPTURE.md).
- `GET /v1/captures/:id` (raw bytes, `X-Capture-*` headers, sandbox/nosniff/attachment headers) and
  `GET /v1/captures/:id/meta`, limited to the client that made the crawl. Unknown, expired and foreign ids give the same
  404; malformed ids give 400; the SHA-256 is rechecked on every read (500 `capture_corrupt` on mismatch). Reads skip the
  crawl queue and are limited by `CRAWL_CAPTURE_READS_PER_MIN` (60).
- Capture metadata carries an HMAC-SHA-256 `mac` keyed from the server token; edited metadata (including a replaced
  body with a matching edited `sha256`) gives 500 `capture_corrupt`.
- `test/captures.security.test.mjs`: tamper and cross-client tests; threat model in SECURITY.md.
- `compose.yaml` mounts a `crawlee-captures` volume; the root filesystem stays read-only.


## 2.1.0 — Nov 2026

Hardening and test coverage; no API changes.

### Security
- A crawl whose start URL redirects to a loopback host is now refused (covered by a test).

### Tests
- Crawl request errors and queue overflow on the API.
- Crawl page and time budget stops.
- Sitemap index discovery through child sitemaps.
- Firecrawl timeout and error responses, recording a limitation on failure.
- `/v1/crawl` response shape validated against a JSON schema.
- Coverage script with thresholds, a badge and a test README.

### Changed
- CI: a stable `tests` check gates on the whole Node matrix.
- Deployment guide is host-agnostic; Node base image bumped to 26-bookworm-slim.

## 2.0.0 — Nov 2026

A rebuild of the 2025 prototype into one service.

### Added
- `POST /v1/crawl` with a bearer token; `GET /healthz` reports version, Firecrawl and robots settings.
- Modes `page`, `crawl`, `sitemap`, `map`; profiles `generic` and `vehicle`.
- Firecrawl integration: rendering for JavaScript-built pages (`render=auto|always|never`), recovery of pages that
  fail over plain HTTP, `mode=map` discovery, a per-crawl render budget, and `fetched_via` on every record.
- Per-field provenance (`extractor`), `missing_required`, VIN check digit (vehicle profile).
- SSRF guard on every start, followed, redirected and Firecrawl-final URL.
- Offline test suite (fixture site, fake Firecrawl) that also runs inside the Docker build.
- CI on Node 22, 24 and 26, secret scan, CodeQL, Dependabot; tagged releases publish multi-arch GHCR images with an
  SBOM, provenance and an attestation.

### Changed
- Node 26 (LTS) image, Crawlee 3.18, Cheerio 1.2, zod 4; CI tests Node 22, 24 and 26. Express and the per-script crawlers are gone.
- Deploys pull a pinned image tag; CI no longer logs in to the server.

### Removed
- `/crawl/basic`, `/crawl/advanced`, `/crawl/custom` (replaced by `POST /v1/crawl`).

## 1.0.0 — Aug 2025

First prototype: an Express API around Crawlee's CheerioCrawler with basic, advanced and configurable crawlers,
a Docker image on GHCR and a Komodo deployment.
