# Deployment

Production runs on `joe@droplet-secured` (DigitalOcean), managed with Komodo, next to the research gateway and
Firecrawl. The same steps work on any Docker host.

## Release → deploy

1. Tag a release (`git tag v2.0.0 && git push origin v2.0.0`, or a GitHub release). The `release` workflow publishes
   `ghcr.io/j-zulick/crawlee-server:2.0.0` for amd64 and arm64.
2. On the server, create the secrets once (never printed):
   ```bash
   ssh joe@droplet-secured
   umask 077; openssl rand -hex 32 > ~/research-platform/secrets/crawl.token
   # firecrawl.key: the Firecrawl API key, mode 600
   ```
3. Komodo → Stacks → `crawlee-server` → compose from [`compose.yaml`](compose.yaml) with the image tag, secrets mounted
   read-only and `FIRECRAWL_URL` set → **Deploy**. Or `docker compose up -d` in the stack folder.
4. Check: `curl -s http://127.0.0.1:8794/healthz` → `{"ok":true,"version":"2.0.0","firecrawl":true,…}`.

## Rollback

Komodo → `crawlee-server` → set the previous image tag → Deploy. Images are immutable and versioned, so a rollback is
a tag change.

## Notes

- Bind to `127.0.0.1` (or a private Docker network); callers on the same host use the token.
- Set `CRAWL_IGNORE_ROBOTS=true` only on deployments where you have decided to; results then say so.
