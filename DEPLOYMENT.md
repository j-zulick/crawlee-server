# Deployment

crawlee-server runs on any Docker host. These steps use [Komodo](https://komo.do) stacks; plain
`docker compose` works the same way. Firecrawl is a separate, optional service: set `FIRECRAWL_URL` to use it.

## Release → deploy

1. Tag a release (`git tag v2.2.0 && git push origin v2.2.0`, or a GitHub release). The `release` workflow publishes
   `ghcr.io/j-zulick/crawlee-server:2.2.0` for amd64 and arm64.
2. On the server, create the secrets once (never printed). The container runs as uid 1000:
   ```bash
   ssh <user>@<host>
   mkdir -p <stack-dir> && cd <stack-dir>
   umask 077; openssl rand -hex 32 > crawl.token
   # optional: firecrawl.key holds the Firecrawl API key (mode 600)
   sudo chown 1000:1000 crawl.token        # skip if your user is uid 1000
   ```
3. Komodo → Stacks → New stack `crawlee-server` → compose from [`compose.yaml`](compose.yaml), image
   `ghcr.io/j-zulick/crawlee-server:<version>`, secrets mounted read-only, and `FIRECRAWL_URL` set if you use
   Firecrawl → **Deploy**. Without Komodo: `docker compose up -d` in the stack folder.
4. Check: `curl -s http://127.0.0.1:8794/healthz` → `{"ok":true,"version":"2.2.0",…}`
   (`"firecrawl":true` when Firecrawl is configured).

## Deploying with Komodo

Stack definition: [`deploy/komodo/compose.yaml`](deploy/komodo/compose.yaml). Host paths and the Firecrawl URL in it are
placeholders.

1. **Secrets on the host.** Create the token file and, if you use Firecrawl, the key file. Both must be owned by
   uid 1000 with mode 600 or stricter:
   ```bash
   umask 077; openssl rand -hex 32 > /path/on/host/crawl.token
   sudo chown 1000:1000 /path/on/host/crawl.token
   chmod 600 /path/on/host/crawl.token
   # only if you use Firecrawl: put its API key in /path/on/host/firecrawl.key, same owner and mode
   ```
2. **Create the stack.** Komodo → Stacks → New stack `crawlee-server`, with the compose defined in the UI: paste the
   contents of `deploy/komodo/compose.yaml`. Replace the host paths. Firecrawl is off as written: to use it, uncomment
   `FIRECRAWL_URL`, `FIRECRAWL_API_KEY_FILE` and the key mount. The `172.17.0.1` port line assumes Docker's default
   bridge on Linux; remove it if no container needs to reach the service, or change it to your bridge gateway.
3. **Deploy**, then verify:
   ```bash
   TOKEN=$(cat /path/on/host/crawl.token)
   # version matches the tag you deployed
   curl -s http://127.0.0.1:8794/healthz
   # no token: 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8794/v1/crawl \
     -H 'Content-Type: application/json' -d '{"start_urls":["https://books.toscrape.com/"]}'
   # crawl returns records
   curl -s http://127.0.0.1:8794/v1/crawl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"start_urls":["https://books.toscrape.com/"],"mode":"page"}' | jq '.stats, .records[0]'
   # link-local metadata address is refused: HTTP 400, error url_refused
   curl -s http://127.0.0.1:8794/v1/crawl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"start_urls":["http://169.254.169.254/"],"mode":"page"}'
   ```
4. **Upgrade.** Change the image tag in the stack to the new release, Deploy, then check that `/healthz` reports the new
   version. Pin an exact tag, not `latest`.
5. **Roll back.** Set the previous tag and Deploy again; check `/healthz`.
6. **Captures.** If you enable captures (`CRAWL_CAPTURE_DEFAULT: "true"` or `capture: true` requests), the stack needs a
   writable volume for `CRAWL_CAPTURE_DIR` (see [Page captures](#page-captures-optional)). The root filesystem is
   read-only, so without it captures are not stored.

## Firecrawl for JavaScript pages (optional)

crawlee-server renders JavaScript pages through Firecrawl when `FIRECRAWL_URL` is set. The self-hosted Firecrawl used
with it is the fork [`j-zulick/firecrawl`](https://github.com/j-zulick/firecrawl), which adds, on top of upstream:

- **Upstream sync (Nov 2026)** with the NuQ job harness: one `api` container runs the API and its workers, next to
  `playwright-service`, `rabbitmq` and `nuq-postgres`. Redis is external (`REDIS_URL`). `/v1` stays, `/v2` is current.
- **Self-hosted `/map` discovery** when fire-engine is not available.
- **Browser recovery:** `playwright-service` relaunches Chromium once (single-flight) after a crash.
- **Compose health checks** that use `node` (the API image has no `curl`), memory limits per service, and bounded logs.
- **Fork CI** (compose config, ops scripts, playwright-service tests, API type check and knip) and an end-to-end
  smoke test, [`ops/selfhost-smoke.sh`](https://github.com/j-zulick/firecrawl/blob/main/ops/selfhost-smoke.sh).

Operator notes: [`ops/README.md`](https://github.com/j-zulick/firecrawl/blob/main/ops/README.md) and
[`ops/ARCHITECTURE.md`](https://github.com/j-zulick/firecrawl/blob/main/ops/ARCHITECTURE.md) in the fork.

**Deploy with Komodo.** Run Firecrawl as its own stack, separate from `crawlee-server`. Either point a stack at the
fork's Git repo (branch `main`, file `docker-compose.yaml`), or import a Compose project that already runs on the host
by its Compose project name. Keep `REDIS_URL` and `POSTGRES_PASSWORD` in the stack's environment, not in the repo.

- **DeployStack does not rebuild images.** After a code change, build the changed services (`api`,
  `playwright-service`) from the checkout, then Deploy. Otherwise the new compose runs the old code.
- **Check the running revision,** not just container health: the commit Komodo shows for the stack should match
  `main`, and the running images should be newer than that commit.
- **Smoke test** on a deployment you are allowed to test (read-only against the target site; it creates one small
  crawl and one 2-URL batch scrape):
  ```bash
  bash ops/selfhost-smoke.sh http://127.0.0.1:3002
  # behind a bearer-token proxy:
  FIRECRAWL_TOKEN=<token> bash ops/selfhost-smoke.sh https://firecrawl.example.com
  ```
  Record the commit and the PASS/FAIL lines with the date.

**Connect crawlee-server.** Set `FIRECRAWL_URL` (and `FIRECRAWL_API_KEY_FILE` if Firecrawl sits behind a token) in the
`crawlee-server` stack, Deploy, and check that `/healthz` reports `"firecrawl":true`.

## Page captures (optional)

`capture: true` requests write raw pages to `CRAWL_CAPTURE_DIR` (see [docs/CAPTURE.md](docs/CAPTURE.md)). The root
filesystem stays read-only; [`compose.yaml`](compose.yaml) mounts the named volume `crawlee-captures` at
`/var/lib/crawlee-captures`, the only writable path besides `/tmp`.

- **Komodo:** in the stack's compose, keep the `crawlee-captures` volume and the `CRAWL_CAPTURE_*` environment entries
  from `compose.yaml`, then Deploy. For a bind mount instead of a named volume, create the folder first and give it to
  uid 1000: `mkdir -p <stack-dir>/captures && sudo chown 1000:1000 <stack-dir>/captures && chmod 700 <stack-dir>/captures`.
- **Check:** `docker exec crawlee-server touch /var/lib/crawlee-captures/.w && docker exec crawlee-server rm /var/lib/crawlee-captures/.w`
  succeeds, and `docker exec crawlee-server touch /app/x` fails (read-only root).
- Captures hold third-party page content. Restrict access to the volume, back it up only if you mean to, and keep it
  out of git. They expire after `CRAWL_CAPTURE_TTL_DAYS` (30); the volume can be deleted at any time.
- Stored captures are read back with `GET /v1/captures/:id` and `/meta` (same token; owner only). Keep
  `CRAWL_CAPTURE_READS_PER_MIN` in the Komodo stack's environment next to the other `CRAWL_CAPTURE_*` entries.
- If the volume is missing or not writable, crawls with `capture: true` still return records with status `partial`.

## Verify the published image in isolation

Run `bash deploy/komodo/verify-image.sh` with Docker, curl, jq and OpenSSL. It pulls the pinned image, starts it with a read-only root and disposable capture volume, checks its version with rendering off, then requests one book detail page from Books to Scrape. The check requires the expected title, one stored capture and a matching SHA-256 after downloading the captured bytes. The test prints the digest and removes its container and volume. If the fixture site is unavailable, the crawl check fails and can be rerun when the site returns. The [image verification workflow](.github/workflows/verify-release-image.yml) runs the same script.

## Rollback

Komodo → `crawlee-server` → set the previous image tag → Deploy. Images are immutable and versioned, so a rollback is
a tag change.

## Notes

- Bind to `127.0.0.1` (or a private Docker network). Other services on the same host or network call it with the token.
- One deployment can serve several projects. Give each caller the token through its own secret store.
- Set `CRAWL_IGNORE_ROBOTS=true` only on deployments where you have decided to; results then say so.
