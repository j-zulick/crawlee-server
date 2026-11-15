# Changelog

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
- CI on Node 22 and 24, secret scan, CodeQL, Dependabot; tagged releases publish multi-arch GHCR images with an
  SBOM, provenance and an attestation.

### Changed
- Node 24 image, Crawlee 3.18, Cheerio 1.2, zod 4. Express and the per-script crawlers are gone.
- Deploys pull a pinned image tag; CI no longer logs in to the server.

### Removed
- `/crawl/basic`, `/crawl/advanced`, `/crawl/custom` (replaced by `POST /v1/crawl`).

## 1.0.0 — Aug 2025

First prototype: an Express API around Crawlee's CheerioCrawler with basic, advanced and configurable crawlers,
a Docker image on GHCR and a Komodo deployment.
