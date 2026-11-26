#!/usr/bin/env bash
# One public scraper-test page, one temporary container and one disposable capture volume.
set -euo pipefail
image=ghcr.io/j-zulick/crawlee-server:2.2.0
version=2.2.0
fixture=https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html
scratch=$(mktemp -d)
cid='' volume=''
cleanup() {
  if [[ -n "$cid" ]]; then docker rm -f "$cid" >/dev/null; fi
  if [[ -n "$volume" ]]; then docker volume rm "$volume" >/dev/null; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
export CRAWL_TOKEN
CRAWL_TOKEN=$(openssl rand -hex 32)
docker pull "$image" >/dev/null
volume=$(docker volume create)
cid=$(docker run -d --read-only --tmpfs /tmp:size=256m --cap-drop ALL \
  --security-opt no-new-privileges -e CRAWL_TOKEN \
  -v "$volume:/var/lib/crawlee-captures" -p 127.0.0.1::8794 "$image")
endpoint=http://$(docker port "$cid" 8794/tcp)
curl -fsS --retry 15 --retry-delay 1 --retry-connrefused "$endpoint/healthz" > "$scratch/health"
jq -e --arg version "$version" '.ok and .version == $version and .firecrawl == false' "$scratch/health" >/dev/null
request=$(jq -nc --arg url "$fixture" '{start_urls:[$url],mode:"page",render:"never",max_pages:1,capture:true}')
curl -fsS --max-time 100 -H "Authorization: Bearer $CRAWL_TOKEN" -H 'Content-Type: application/json' \
  --data "$request" "$endpoint/v1/crawl" > "$scratch/crawl"
jq -e '.capture.stored == 1 and (.records | length) == 1 and .records[0].title == "A Light in the Attic"' "$scratch/crawl" >/dev/null
id=$(jq -er '.records[0].capture_id' "$scratch/crawl")
expected=$(jq -er '.records[0].sha256' "$scratch/crawl")
curl -fsS -H "Authorization: Bearer $CRAWL_TOKEN" "$endpoint/v1/captures/$id" -o "$scratch/body"
actual=$(openssl dgst -sha256 "$scratch/body" | awk '{print $NF}')
test "$expected" = "$actual"
printf 'Image %s, fixture title verified, 1 record, 1 capture, SHA-256 %s\n' "$version" "$actual"
