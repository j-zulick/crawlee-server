# Crawlee REST API Documentation

## Overview

The Crawlee REST API provides stateless web crawling capabilities through HTTP endpoints. The API is designed to be containerized and deployed as a microservice.

## Base URL

```
http://localhost:3000
```

## Endpoints

### Health Check

**GET** `/health`

Check if the API server is running and healthy.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-08-04T17:00:00.000Z",
  "version": "1.0.0"
}
```

### Basic Crawling

**POST** `/crawl/basic`

Perform basic web crawling to extract links and page information.

**Request Body:**
```json
{
  "urls": ["https://www.dealnews.com"],
  "maxRequests": 10
}
```

**Response:**
```json
{
  "success": true,
  "message": "Basic crawling completed",
  "data": {
    "pagesCrawled": 5,
    "results": [
      {
        "url": "https://www.dealnews.com",
        "title": "DealNews - Best Deals, Coupons, Promo Codes",
        "links": [
          {
            "href": "https://www.dealnews.com/deals",
            "text": "Deals"
          }
        ],
        "timestamp": "2025-08-04T17:00:00.000Z"
      }
    ]
  }
}
```

### Advanced Crawling

**POST** `/crawl/advanced`

Perform advanced crawling with data extraction for deals, products, etc.

**Request Body:**
```json
{
  "urls": ["https://www.dealnews.com"],
  "maxRequests": 20
}
```

**Response:**
```json
{
  "success": true,
  "message": "Advanced crawling completed",
  "data": {
    "pagesCrawled": 10,
    "totalDeals": 25,
    "totalLinks": 150,
    "results": [
      {
        "url": "https://www.dealnews.com",
        "title": "DealNews - Best Deals, Coupons, Promo Codes",
        "deals": [
          {
            "title": "Nike Air Max Shoes",
            "price": "$89.99",
            "originalPrice": "$129.99",
            "discount": "30% off",
            "description": "Comfortable running shoes",
            "image": "https://example.com/shoe.jpg",
            "link": "https://example.com/buy",
            "category": "Shoes",
            "store": "Nike",
            "timestamp": "2025-08-04T17:00:00.000Z",
            "sourceUrl": "https://www.dealnews.com"
          }
        ],
        "links": [...],
        "timestamp": "2025-08-04T17:00:00.000Z"
      }
    ]
  }
}
```

### Configurable Crawling

**POST** `/crawl/configurable`

Perform crawling with custom configuration options.

**Request Body:**
```json
{
  "urls": ["https://www.dealnews.com"],
  "maxRequests": 20,
  "customConfig": {
    "followPatterns": ["**/deals/**"],
    "excludePatterns": ["**/login/**"],
    "selectors": {
      "deals": ".deal-item",
      "titles": ".deal-title"
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Configurable crawling completed",
  "data": {
    "pagesCrawled": 8,
    "totalDeals": 15,
    "totalLinks": 120,
    "config": {
      "maxRequests": 20,
      "linkStrategy": "same-domain",
      "followPatterns": ["**/deals/**"]
    },
    "results": [...]
  }
}
```

### Get Configuration

**GET** `/config`

Retrieve the current crawling configuration.

**Response:**
```json
{
  "success": true,
  "data": {
    "startUrls": ["https://www.dealnews.com"],
    "maxRequestsPerCrawl": 20,
    "maxRequestRetries": 3,
    "linkStrategy": "same-domain",
    "followPatterns": ["**/deals/**", "**/products/**"],
    "excludePatterns": ["**/login/**", "**/admin/**"],
    "selectors": {
      "deals": "[class*=\"deal\"], [class*=\"product\"]",
      "titles": "h1, h2, h3, .title",
      "prices": "[class*=\"price\"], .price",
      "images": "img",
      "links": "a"
    }
  }
}
```

### Update Configuration

**PUT** `/config`

Update the crawling configuration (not persisted in stateless mode).

**Request Body:**
```json
{
  "config": {
    "maxRequestsPerCrawl": 50,
    "followPatterns": ["**/deals/**"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Configuration merged (not persisted in stateless mode)",
  "data": {
    "maxRequestsPerCrawl": 50,
    "followPatterns": ["**/deals/**"],
    "linkStrategy": "same-domain"
  }
}
```

## Error Responses

All endpoints return error responses in the following format:

```json
{
  "success": false,
  "error": "Error message description"
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `500` - Internal Server Error

## Usage Examples

### cURL Examples

**Health Check:**
```bash
curl http://localhost:3000/health
```

**Basic Crawling:**
```bash
curl -X POST http://localhost:3000/crawl/basic \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://www.dealnews.com"],
    "maxRequests": 5
  }'
```

**Advanced Crawling:**
```bash
curl -X POST http://localhost:3000/crawl/advanced \
  -H "Content-Type: application/json" \
  -d '{
    "urls": ["https://www.dealnews.com"],
    "maxRequests": 10
  }'
```

### JavaScript Examples

**Basic Crawling:**
```javascript
const response = await fetch('http://localhost:3000/crawl/basic', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    urls: ['https://www.dealnews.com'],
    maxRequests: 10
  })
});

const data = await response.json();
console.log(data);
```

**Advanced Crawling:**
```javascript
const response = await fetch('http://localhost:3000/crawl/advanced', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    urls: ['https://www.dealnews.com'],
    maxRequests: 20
  })
});

const data = await response.json();
console.log(`Found ${data.data.totalDeals} deals across ${data.data.pagesCrawled} pages`);
```

## Docker Deployment

### Build and Run

```bash
# Build the Docker image
docker build -t crawlee-api .

# Run the container
docker run -p 3000:3000 crawlee-api
```

### Using Docker Compose

```bash
# Start the service
docker-compose up -d

# Stop the service
docker-compose down
```

### Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (production/development)

## Rate Limiting

The API includes built-in rate limiting to be respectful to target websites:
- Default: 1 request per second
- Configurable via custom configuration
- Automatic retry logic for failed requests

## Security Considerations

- Container runs as non-root user
- CORS enabled for cross-origin requests
- Input validation on all endpoints
- No persistent storage (stateless design)

## Monitoring

- Health check endpoint for monitoring
- Docker health checks configured
- Structured logging for debugging
- Request statistics in responses 