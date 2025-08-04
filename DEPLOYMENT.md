# Deployment Guide - Komodo Stack

## Overview

Streamlined deployment workflow for the Crawlee API to Komodo stack.

## Prerequisites

1. **GitHub Container Registry Access**
   - Personal Access Token with `write:packages` and `read:packages` scopes
   - Docker logged in to `ghcr.io`

2. **Server Access**
   - SSH access to `joe@droplet-secured`
   - Docker and Komodo installed on server

## Deployment Workflow

### Option A: GitHub Actions (Recommended)
Push to `main` branch - deployment happens automatically:
1. ✅ Builds and pushes Docker image with new tag
2. ✅ Logs into GitHub Container Registry on server
3. ✅ Pulls new image with updated tag
4. ✅ Updates image tag in docker-compose.yml
5. ✅ Restarts Komodo stack
6. ✅ Verifies service health

### Option B: Manual Deployment
```bash
# 1. Build and push new image
npm run docker:build:amd64

# 2. On server
ssh joe@droplet-secured
cd /etc/komodo/stacks/crawlee-stack

# 3. Login to GitHub Container Registry
echo $TOKEN | sudo docker login ghcr.io -u $USERNAME --password-stdin

# 4. Pull new image and restart
sudo docker pull ghcr.io/j-zulick/crawlee-server:latest
sudo komodo stack deploy crawlee-stack
```

## Verification

### Check Service Status
```bash
# On server
sudo komodo stack status crawlee-stack
docker compose -f /etc/komodo/stacks/crawlee-stack/docker-compose.yml ps
```

### Test API
```bash
# Health check
curl http://joe@droplet-secured:3000/health

# Test crawling
curl -X POST http://joe@droplet-secured:3000/crawl/basic \
  -H "Content-Type: application/json" \
  -d '{"url": "https://httpbin.org/html"}'
```

## Update Process

### Manual Update
```bash
# 1. Build and push new image
npm run docker:build:amd64

# 2. On server
ssh joe@droplet-secured
cd /etc/komodo/stacks/crawlee-stack
sudo docker pull ghcr.io/j-zulick/crawlee-server:latest
sudo komodo stack deploy crawlee-stack
```

### Automatic Update
Push to `main` branch - GitHub Actions handles everything.

## Troubleshooting

### Service Not Starting
```bash
# Check logs
sudo docker logs crawlee-api

# Check stack status
sudo komodo stack status crawlee-stack
```

### Image Pull Issues
```bash
# Login to GitHub Container Registry on server
echo $TOKEN | sudo docker login ghcr.io -u $USERNAME --password-stdin
```

### Permission Issues
```bash
# Fix stack directory permissions
sudo chown -R root:root /etc/komodo/stacks/crawlee-stack
sudo chmod 644 /etc/komodo/stacks/crawlee-stack/docker-compose.yml
```

## API Endpoints

- **Health Check**: `GET /health`
- **Basic Crawling**: `POST /crawl/basic`
- **Advanced Crawling**: `POST /crawl/advanced`
- **Configurable Crawling**: `POST /crawl/configurable`
- **Get Config**: `GET /config`
- **Update Config**: `PUT /config`

## Configuration

The stack configuration is in `/etc/komodo/stacks/crawlee-stack/docker-compose.yml`:
- **Image**: `ghcr.io/j-zulick/crawlee-server:latest`
- **Port**: `3000`
- **Memory Limit**: `1G`
- **CPU Limit**: `1.0`
- **Health Check**: Every 30s
- **Restart Policy**: `unless-stopped` 