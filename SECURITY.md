# Security policy

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab), not in a
public issue. Expect a reply within a week.

In scope: SSRF bypasses (reaching private, loopback, link-local or metadata addresses), token bypass, crashes from a
crafted request or page, and secrets appearing in output or logs.

Design notes: the service is meant to sit on localhost or a private network behind its bearer token. Target URLs are
checked before every request, after every redirect and after Firecrawl rendering. The Firecrawl key is read from a
file and never returned.

## Threat model: page captures (2.2.0)

Captures (`capture: true`) store the raw bytes a crawl received, with a SHA-256, fetch time and the owning `client_id`.

**What the hash proves:** the bytes returned by `GET /v1/captures/:id` are the bytes the server stored. They have not
changed since storage. The SHA-256 is rechecked on every read; a mismatch gives 500 `capture_corrupt` and no body.

**What it does not prove:**
- that the website really served those bytes. The server records what it received; a compromised site, proxy, CDN or
  DNS answer would be captured as received.
- that the fetch was honest. A capture is evidence of what this server stored, not a signed statement by the site.
  `fetched_at` is the server's clock.
- anything about content that was never captured (pages over `CRAWL_CAPTURE_MAX_BYTES`, or crawls with capture off).

**Metadata MAC.** A hash stored next to the body only protects against a change to one of the two. So each capture's
metadata carries a `mac`: HMAC-SHA-256 over the canonical metadata (including `sha256`, `client_id` and `url`), keyed
from the server token. Replacing a body and editing its `sha256`, changing `url` or `fetched_at`, or changing the owner
on disk is detected on read (500 `capture_corrupt`). Chosen over only documenting the limit because it is a few lines
and needs no new secret.

**Known limits:**
- Someone who can write the capture volume **and** knows the server token can forge a valid capture. Protect the
  volume (mode 0600, private volume) and the token.
- Someone who can write the volume can delete captures; a missing body reads as 404 `capture_not_found`, the same as an
  unknown id.
- Rotating the token makes every older capture unreadable (new `client_id`, new MAC key) until the TTL sweep removes it
  (see docs/CAPTURE.md).
- The MAC key comes from the shared token in 2.2.0. A per-client or separate key is a 2.4.0 question.

**Ownership.** Only the client whose token made the crawl can read a capture. Unknown, expired and other-client ids
return the same 404. Ids are 192 random bits and there is no listing endpoint. Captured content is never logged or put
in `/healthz`.

These properties are tested in `test/captures.security.test.mjs`; weakening the hash check, the MAC check or the
ownership check makes tests fail.
