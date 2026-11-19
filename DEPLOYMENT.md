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

## Rollback

Komodo → `crawlee-server` → set the previous image tag → Deploy. Images are immutable and versioned, so a rollback is
a tag change.

## Notes

- Bind to `127.0.0.1` (or a private Docker network). Other services on the same host or network call it with the token.
- One deployment can serve several projects. Give each caller the token through its own secret store.
- Set `CRAWL_IGNORE_ROBOTS=true` only on deployments where you have decided to; results then say so.
