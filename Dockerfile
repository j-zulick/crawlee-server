# crawlee-server: bounded Crawlee crawler behind a token-protected HTTP API.
FROM node:26-bookworm-slim AS build
# Crawlee's autoscaler reads memory via `ps`; slim images lack it.
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY test ./test
# The full test suite runs inside the build (offline fixtures only): an image that fails it is never produced.
RUN node --test test/*.test.mjs

FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production CRAWL_BIND=0.0.0.0 CRAWL_PORT=8794 CRAWLEE_PERSIST_STORAGE=false CRAWLEE_STORAGE_DIR=/tmp/crawlee
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json NOTICES.md LICENSE ./
COPY src ./src
USER node
EXPOSE 8794
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8794/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
