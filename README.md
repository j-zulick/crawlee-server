# Crawlee Server

A web scraping project using [Crawlee](https://crawlee.dev/) to crawl and extract data from dealnews.com.

## Features

- **CheerioCrawler**: Fast HTML parsing using Cheerio
- **Link Extraction**: Extracts all `<a href>` links from pages
- **Same-domain Crawling**: Follows internal links within the same domain
- **Request Limiting**: Prevents runaway crawls with configurable limits
- **Error Handling**: Robust error handling and retry logic

## Prerequisites

- Node.js 18+ 
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd crawlee-server
```

2. Install dependencies:
```bash
npm install
```

## Usage

### Basic Usage

Run the basic crawler:
```bash
npm start
```

### Advanced Crawler

Run the advanced crawler with data extraction:
```bash
npm run advanced
```

### Configurable Crawler

Run the configurable crawler (uses config.js):
```bash
npm run configurable
```

### Development Mode

Run with file watching for development:
```bash
npm run dev
npm run advanced:dev
npm run configurable:dev
```

### Data Analysis

After running a crawler, analyze the collected data:
```bash
npm run analyze
```

### REST API Server

Start the REST API server:
```bash
npm run api
```

### Docker Deployment

Build and run with Docker:
```bash
# Build Docker image
npm run docker:build

# Run container
npm run docker:run

# Or use Docker Compose
npm run docker:compose
```

## Configuration

The crawler is configured in `src/main.js` with the following settings:

- **Start URL**: `https://www.dealnews.com`
- **Max Requests**: 10 (prevents runaway crawls)
- **Request Timeout**: 60 seconds
- **Max Retries**: 3
- **Strategy**: Same-domain link following

## Project Structure

```
crawlee-server/
├── src/
│   ├── main.js                    # Basic crawler script
│   ├── advanced-crawler.js        # Advanced crawler with data extraction
│   ├── configurable-crawler.js    # Configurable crawler using config
│   ├── config.js                  # Configuration file
│   ├── analyze-data.js            # Data analysis and export utility
│   └── api-server.js              # REST API server
├── examples/
│   └── client-example.js          # API client example
├── Dockerfile                     # Docker container configuration
├── docker-compose.yml             # Docker Compose configuration
├── .dockerignore                  # Docker ignore rules
├── API.md                         # REST API documentation
├── package.json                   # Project dependencies
├── .gitignore                    # Git ignore rules
└── README.md                     # This file
```

## Customization

### Changing the Target URL

Edit the `startUrls` array in `src/main.js`:

```javascript
const startUrls = ['https://your-target-site.com'];
```

### Adjusting Crawl Limits

Modify the crawler configuration:

```javascript
const crawler = new CheerioCrawler({
    // ... other options
    maxRequestsPerCrawl: 50, // Increase for more pages
    maxRequestRetries: 5,     // Increase retry attempts
});
```

### Adding Data Extraction

Extend the `requestHandler` to extract specific data:

```javascript
async requestHandler({ request, $, enqueueLinks, log }) {
    log.info(`Crawling: ${request.url}`);

    // Extract page title
    const title = $('title').text();
    console.log('Page title:', title);

    // Extract specific elements
    $('.product-item').each((index, el) => {
        const name = $(el).find('.product-name').text();
        const price = $(el).find('.product-price').text();
        console.log(`Product: ${name} - ${price}`);
    });

    // Continue crawling
    await enqueueLinks({
        strategy: 'same-domain',
    });
}
```

## Output

### Basic Crawler
- All discovered links to the console
- Crawling progress and status messages
- Error messages if any issues occur

### Advanced & Configurable Crawlers
- Extracted deal data saved to Crawlee dataset
- Page metadata and statistics
- Sample deals logged to console
- Comprehensive error handling

### Data Analysis
After running a crawler, use `npm run analyze` to:
- View dataset statistics
- Export data to JSON files
- Generate CSV summaries
- Analyze deal patterns and stores

### REST API
The API provides stateless crawling endpoints:
- **GET /health** - Health check
- **POST /crawl/basic** - Basic crawling
- **POST /crawl/advanced** - Advanced crawling with data extraction
- **POST /crawl/configurable** - Configurable crawling
- **GET /config** - Get current configuration
- **PUT /config** - Update configuration

See [API.md](API.md) for complete documentation.

## Storage

Crawlee automatically creates a `storage/` directory to store:
- Request queue
- Crawling results
- Logs and debugging information

This directory is ignored by git (see `.gitignore`).

## Docker Deployment

### Stateless Container

The project is designed as a stateless Docker container:

```bash
# Build the image
docker build -t crawlee-api .

# Run the container
docker run -p 3000:3000 crawlee-api

# Or use Docker Compose
docker-compose up -d
```

### Container Features

- **Stateless design** - No persistent storage, perfect for scaling
- **Security** - Runs as non-root user
- **Health checks** - Built-in monitoring
- **Resource limits** - Memory and CPU constraints
- **CORS enabled** - Cross-origin request support

### Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (production/development)

## Troubleshooting

### Common Issues

1. **Network Errors**: Check your internet connection and the target site's availability
2. **Rate Limiting**: The crawler includes delays to be respectful to servers
3. **Memory Issues**: Reduce `maxRequestsPerCrawl` if you encounter memory problems

### Debug Mode

Enable verbose logging by changing the log level:

```javascript
logLevel: 'DEBUG', // Instead of 'INFO'
```

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Resources

- [Crawlee Documentation](https://crawlee.dev/docs)
- [Cheerio Documentation](https://cheerio.js.org/)
- [Crawlee GitHub](https://github.com/apify/crawlee)
