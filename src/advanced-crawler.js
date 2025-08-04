import { CheerioCrawler, Dataset } from 'crawlee';

const startUrls = ['https://www.dealnews.com'];

// Data structure for extracted deals
const extractDealData = ($, url) => {
    const deals = [];
    
    // Look for common deal selectors
    $('[class*="deal"], [class*="product"], [class*="item"]').each((index, el) => {
        const $el = $(el);
        
        // Extract deal information
        const deal = {
            title: $el.find('h1, h2, h3, h4, .title, .name').first().text().trim(),
            price: $el.find('[class*="price"], .price, .cost').first().text().trim(),
            originalPrice: $el.find('[class*="original"], .original-price').first().text().trim(),
            discount: $el.find('[class*="discount"], .discount, .savings').first().text().trim(),
            description: $el.find('[class*="description"], .description, .summary').first().text().trim(),
            image: $el.find('img').first().attr('src'),
            link: $el.find('a').first().attr('href'),
            category: $el.find('[class*="category"], .category').first().text().trim(),
            store: $el.find('[class*="store"], .store, .merchant').first().text().trim(),
            timestamp: new Date().toISOString(),
            sourceUrl: url,
        };
        
        // Only add deals with meaningful data
        if (deal.title || deal.price) {
            deals.push(deal);
        }
    });
    
    return deals;
};

// Extract page metadata
const extractPageMetadata = ($, url) => {
    return {
        title: $('title').text().trim(),
        description: $('meta[name="description"]').attr('content') || '',
        keywords: $('meta[name="keywords"]').attr('content') || '',
        canonical: $('link[rel="canonical"]').attr('href') || '',
        url: url,
        timestamp: new Date().toISOString(),
    };
};

const crawler = new CheerioCrawler({
    async requestHandler({ request, $, enqueueLinks, log }) {
        log.info(`Crawling: ${request.url}`);
        
        try {
            // Extract page metadata
            const metadata = extractPageMetadata($, request.url);
            console.log(`Page: ${metadata.title}`);
            
            // Extract deals data
            const deals = extractDealData($, request.url);
            
            if (deals.length > 0) {
                console.log(`Found ${deals.length} deals on this page`);
                
                // Save deals to dataset
                await Dataset.pushData({
                    url: request.url,
                    metadata: metadata,
                    deals: deals,
                    totalDeals: deals.length,
                });
                
                // Log some deal examples
                deals.slice(0, 3).forEach((deal, index) => {
                    console.log(`  Deal ${index + 1}: ${deal.title} - ${deal.price}`);
                });
            }
            
            // Extract and log all links for analysis
            const links = [];
            $('a').each((index, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim();
                if (href) {
                    links.push({ href, text });
                    console.log(`Link: ${text} -> ${href}`);
                }
            });
            
            console.log(`Total links found: ${links.length}\n`);
            
            // Enqueue internal links to continue crawling
            await enqueueLinks({
                strategy: 'same-domain',
                // Add some filtering to focus on deal-related pages
                globs: [
                    '**/deals/**',
                    '**/products/**',
                    '**/sales/**',
                    '**/offers/**',
                ],
            });
            
        } catch (error) {
            log.error(`Error processing ${request.url}:`, error);
        }
    },
    
    // Configuration
    maxRequestsPerCrawl: 20,
    maxRequestRetries: 3,
    

});

console.log('🚀 Starting Advanced Crawlee Crawler...');
console.log(`🎯 Target URL: ${startUrls[0]}`);
console.log('📊 Data will be saved to Crawlee dataset');
console.log('⏹️  Press Ctrl+C to stop the crawler\n');

try {
    await crawler.run(startUrls);
    
    // Get final statistics
    const dataset = await Dataset.open();
    const stats = await dataset.getInfo();
    
    console.log('\n✅ Crawling completed successfully!');
    console.log(`📈 Total items collected: ${stats.itemCount}`);
    console.log(`💾 Data saved to: ${dataset.id}`);
    
} catch (error) {
    console.error('❌ Crawling failed:', error);
    process.exit(1);
} 