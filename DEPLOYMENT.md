# Deployment

crawlee-server runs on any Docker host. These steps use [Komodo](https://komo.do) stacks; plain
`docker compose` works the same way. Firecrawl is a separate, optional service: set `FIRECRAWL_URL` to use it.

## Release → deploy

1. Tag a release (`git tag v2.1.0 && git push origin v2.0.0`, or a GitHub release). The `release` workflow publishes
   `ghcr.io/j-zulick/crawlee-server:2.1.0` for amd64 and arm64.
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
4. Check: `curl -s http://127.0.0.1:8794/healthz` → `{"ok":true,"version":"2.1.0",…}`
   (`"firecrawl":true` when Firecrawl is configured).

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
- If the volume is missing or not writable, crawls with `capture: true` still return records with status `partial`.

## Rollback

Komodo → `crawlee-server` → set the previous image tag → Deploy. Images are immutable and versioned, so a rollback is
a tag change.

## Notes

- Bind to `127.0.0.1` (or a private Docker network). Other services on the same host or network call it with the token.
- One deployment can serve several projects. Give each caller the token through its own secret store.
- Set `CRAWL_IGNORE_ROBOTS=true` only on deployments where you have decided to; results then say so.
