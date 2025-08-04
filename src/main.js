import { CheerioCrawler } from 'crawlee';

const startUrls = ['https://www.dealnews.com'];

const crawler = new CheerioCrawler({
    async requestHandler({ request, $, enqueueLinks, log }) {
        log.info(`Crawling: ${request.url}`);

        // Extract and print all <a href> links on the page
        $('a').each((index, el) => {
            const href = $(el).attr('href');
            if (href) {
                console.log('Link found:', href);
            }
        });

        // Optionally enqueue internal links to follow
        await enqueueLinks({
            strategy: 'same-domain',
        });
    },
    maxRequestsPerCrawl: 10, // Limit to prevent runaway crawls
    maxRequestRetries: 3,
});

console.log('Starting Crawlee crawler...');
console.log(`Target URL: ${startUrls[0]}`);
console.log('Press Ctrl+C to stop the crawler\n');

try {
    await crawler.run(startUrls);
    console.log('\nCrawling completed successfully!');
} catch (error) {
    console.error('Crawling failed:', error);
    process.exit(1);
} 