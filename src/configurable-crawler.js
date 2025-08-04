import { CheerioCrawler, Dataset } from 'crawlee';
import { getConfig } from './config.js';

const config = getConfig();

// Data extraction using config selectors
const extractDealData = ($, url) => {
    const deals = [];
    
    $(config.selectors.deals).each((index, el) => {
        const $el = $(el);
        
        const deal = {
            title: $el.find(config.selectors.titles).first().text().trim(),
            price: $el.find(config.selectors.prices).first().text().trim(),
            originalPrice: $el.find(config.selectors.originalPrices).first().text().trim(),
            discount: $el.find(config.selectors.discounts).first().text().trim(),
            description: $el.find(config.selectors.descriptions).first().text().trim(),
            image: $el.find(config.selectors.images).first().attr('src'),
            link: $el.find(config.selectors.links).first().attr('href'),
            category: $el.find(config.selectors.categories).first().text().trim(),
            store: $el.find(config.selectors.stores).first().text().trim(),
            timestamp: new Date().toISOString(),
            sourceUrl: url,
        };
        
        if (deal.title || deal.price) {
            deals.push(deal);
        }
    });
    
    return deals;
};

const crawler = new CheerioCrawler({
    async requestHandler({ request, $, enqueueLinks, log }) {
        log.info(`Crawling: ${request.url}`);
        
        try {
            // Extract deals data
            const deals = extractDealData($, request.url);
            
            if (deals.length > 0 && config.output.saveToDataset) {
                console.log(`Found ${deals.length} deals on this page`);
                
                // Save to dataset
                await Dataset.pushData({
                    url: request.url,
                    deals: deals,
                    totalDeals: deals.length,
                    crawledAt: new Date().toISOString(),
                });
                
                // Log deals if enabled
                if (config.output.logToConsole) {
                    deals.slice(0, config.output.maxDealsToLog).forEach((deal, index) => {
                        console.log(`  Deal ${index + 1}: ${deal.title} - ${deal.price}`);
                    });
                }
            }
            
            // Enqueue links based on configuration
            await enqueueLinks({
                strategy: config.linkStrategy,
                globs: config.followPatterns,
                exclude: config.excludePatterns,
            });
            
        } catch (error) {
            log.error(`Error processing ${request.url}:`, error);
        }
    },
    
    // Use configuration
    maxRequestsPerCrawl: config.maxRequestsPerCrawl,
    maxRequestRetries: config.maxRequestRetries,
});

console.log('🚀 Starting Configurable Crawlee Crawler...');
console.log(`🎯 Target URLs: ${config.startUrls.join(', ')}`);
console.log(`📊 Max requests: ${config.maxRequestsPerCrawl}`);
console.log(`⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
console.log('⏹️  Press Ctrl+C to stop the crawler\n');

try {
    await crawler.run(config.startUrls);
    
    const dataset = await Dataset.open();
    const stats = await dataset.getInfo();
    
    console.log('\n✅ Crawling completed successfully!');
    console.log(`📈 Total items collected: ${stats.itemCount}`);
    console.log(`💾 Data saved to: ${dataset.id}`);
    
} catch (error) {
    console.error('❌ Crawling failed:', error);
    process.exit(1);
} 