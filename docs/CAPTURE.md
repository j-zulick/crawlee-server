# Page captures

A capture is the raw page a crawl fetched, stored with a SHA-256 and the time the fetch finished. It lets you check
later that a record, or a citation built from it, matches what the server actually received. Off by default.

## Use

Send `"capture": true` (or set `CRAWL_CAPTURE_DEFAULT=true`). Each record that has a stored page gets:

| Field | Meaning |
|---|---|
| `capture_id` | 192 random bits as 48 lowercase hex characters; not guessable |
| `sha256` | SHA-256 of the stored bytes, lowercase hex |
| `fetched_at` | ISO 8601 UTC, taken when the response finished |

The response also has `capture: { enabled, stored, not_stored }`. With capture off, nothing is written and none of
these fields appear. Pages that yield no record (index pages, duplicates) are not stored.

## What is stored

Two files per capture in `CRAWL_CAPTURE_DIR`, both mode 0600:

- `<capture_id>.body`: the response body exactly as received, after HTTP content-decoding (gzip and the like) and
  before any charset decoding. For a page rendered through Firecrawl: the rendered HTML used for extraction, as UTF-8.
- `<capture_id>.json`: `capture_id`, `url` (final, after redirects), `requested_url`, `fetched_at`, `http_status`,
  `content_type`, `size_bytes`, `sha256`, `fetch_method` (the record's `fetched_via`: `http` or `firecrawl`),
  `rendered`, `recovered` (plain HTTP failed and Firecrawl fetched it), `client_id`, `crawl_id`, `mac`. The `mac` is an HMAC-SHA-256
  over all other fields, keyed from the server token; a read whose metadata fails it returns 500 `capture_corrupt`
  (see [SECURITY.md](../SECURITY.md)).

`client_id` is `tok_` plus 16 hex characters of an HMAC-SHA-256 of the bearer token under a fixed server label. The
token is never stored or logged. `client_id` is not returned in crawl responses or `/healthz`. Ownership is checked
with `ownsCapture` (`src/client.mjs`): constant-time, and false for any empty or malformed id. When per-client tokens
arrive (2.4.0) they replace the body of `resolveClient(request)`; the capture format stays the same.

**Token rotation:** a new token gives a new `client_id`, so captures made under the old token are no longer owned by
any caller. They stay on disk until the TTL sweep removes them. There is deliberately no override setting to carry
an id across rotation: it would let a misconfiguration expose one client's captures to another. If continuity matters,
revisit it with the per-client tokens in 2.4.0.

Writes are atomic: each file is written under a `.tmp-` name, flushed, then renamed, `.json` last. A capture exists
only when its `.json` exists, so a crash never leaves a half-written capture that looks complete.

## Reading a capture

`GET /v1/captures/:id` and `GET /v1/captures/:id/meta` (bearer token, owner only; see the README for statuses).

- The id must be exactly 48 lowercase hex characters, checked before any file is opened, so a request cannot reach a
  path outside `CRAWL_CAPTURE_DIR`. Anything else is 400.
- Unknown, expired and other-client ids take the same code path and return the same 404 body. Each does at most one
  metadata file read, and a foreign capture's body is never opened. Ids are 192 random bits, so probing is not feasible.
- The body response recomputes SHA-256 and compares it to the stored value. A mismatch returns 500 `capture_corrupt`
  with no body, and the server logs the capture id only. `/meta` returns the stored hash without rereading the body.
- `/meta` fields: `capture_id`, `url`, `requested_url`, `fetched_at`, `http_status`, `content_type`, `size_bytes`,
  `sha256`, `fetch_method`, `rendered`, `recovered`, `crawl_id`. `client_id` is never returned.
- Bodies are served as attachments with `Content-Security-Policy: sandbox` and `nosniff`. A stored content type that
  is not a plain `type/subtype` with simple parameters is replaced by `application/octet-stream`.
- Reads bypass the crawl queue, so they work while a crawl runs. The limit is `CRAWL_CAPTURE_READS_PER_MIN` per client
  (default 60, fixed one-minute window, in memory).

## Limits and failure

- `CRAWL_CAPTURE_MAX_BYTES` (5 MB): larger pages are not stored; `limitations` names them.
- `CRAWL_CAPTURE_MAX_TOTAL_BYTES` (1 GiB): once reached, further pages are not stored; `limitations` says so.
- `CRAWL_CAPTURE_TTL_DAYS` (30): captures older than this are removed at startup and every hour. The sweep only
  touches files named like captures, plus stale `.tmp-` leftovers.
- Directory unset, missing, not a directory or not writable: the crawl still returns its records, `status` is
  `partial` and `limitations` gives the reason (`capture_dir_missing`, `capture_dir_not_writable`, ...). The server
  does not create the directory; mount it.

Captures hold third-party page content. They stay in the capture volume: never in the repo, logs, fixtures or
responses. Tests use small synthetic pages only.
