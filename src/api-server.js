import express from 'express';
import cors from 'cors';
import { CheerioCrawler, Dataset } from 'crawlee';
import { getConfig } from './config.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Basic crawler endpoint
app.post('/crawl/basic', async (req, res) => {
    try {
        const { urls = ['https://www.dealnews.com'], maxRequests = 10 } = req.body;
        
        const results = [];
        
        const crawler = new CheerioCrawler({
            async requestHandler({ request, $, enqueueLinks, log }) {
                log.info(`Crawling: ${request.url}`);
                
                const pageData = {
                    url: request.url,
                    title: $('title').text().trim(),
                    links: [],
                    timestamp: new Date().toISOString()
                };
                
                // Extract all links
                $('a').each((index, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().trim();
                    if (href) {
                        pageData.links.push({ href, text });
                    }
                });
                
                results.push(pageData);
                
                // Enqueue internal links
                await enqueueLinks({
                    strategy: 'same-domain',
                });
            },
            maxRequestsPerCrawl: maxRequests,
            maxRequestRetries: 3,
        });
        
        await crawler.run(urls);
        
        res.json({
            success: true,
            message: 'Basic crawling completed',
            data: {
                pagesCrawled: results.length,
                results: results
            }
        });
        
    } catch (error) {
        console.error('Basic crawl error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Advanced crawler endpoint with data extraction
app.post('/crawl/advanced', async (req, res) => {
    try {
        const { urls = ['https://www.dealnews.com'], maxRequests = 20 } = req.body;
        
        const config = getConfig();
        const results = [];
        
        // Data extraction function
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
                
                const pageData = {
                    url: request.url,
                    title: $('title').text().trim(),
                    deals: extractDealData($, request.url),
                    links: [],
                    timestamp: new Date().toISOString()
                };
                
                // Extract links
                $('a').each((index, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().trim();
                    if (href) {
                        pageData.links.push({ href, text });
                    }
                });
                
                results.push(pageData);
                
                // Enqueue links based on configuration
                await enqueueLinks({
                    strategy: config.linkStrategy,
                    globs: config.followPatterns,
                    exclude: config.excludePatterns,
                });
            },
            maxRequestsPerCrawl: maxRequests,
            maxRequestRetries: 3,
        });
        
        await crawler.run(urls);
        
        // Calculate statistics
        const totalDeals = results.reduce((sum, page) => sum + page.deals.length, 0);
        const totalLinks = results.reduce((sum, page) => sum + page.links.length, 0);
        
        res.json({
            success: true,
            message: 'Advanced crawling completed',
            data: {
                pagesCrawled: results.length,
                totalDeals: totalDeals,
                totalLinks: totalLinks,
                results: results
            }
        });
        
    } catch (error) {
        console.error('Advanced crawl error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Configurable crawler endpoint
app.post('/crawl/configurable', async (req, res) => {
    try {
        const { 
            urls = ['https://www.dealnews.com'], 
            maxRequests = 20,
            customConfig = {} 
        } = req.body;
        
        // Merge custom config with default config
        const config = { ...getConfig(), ...customConfig };
        const results = [];
        
        const crawler = new CheerioCrawler({
            async requestHandler({ request, $, enqueueLinks, log }) {
                log.info(`Crawling: ${request.url}`);
                
                const pageData = {
                    url: request.url,
                    title: $('title').text().trim(),
                    deals: [],
                    links: [],
                    timestamp: new Date().toISOString()
                };
                
                // Extract deals using config selectors
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
                        sourceUrl: request.url,
                    };
                    
                    if (deal.title || deal.price) {
                        pageData.deals.push(deal);
                    }
                });
                
                // Extract links
                $('a').each((index, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().trim();
                    if (href) {
                        pageData.links.push({ href, text });
                    }
                });
                
                results.push(pageData);
                
                // Enqueue links based on configuration
                await enqueueLinks({
                    strategy: config.linkStrategy,
                    globs: config.followPatterns,
                    exclude: config.excludePatterns,
                });
            },
            maxRequestsPerCrawl: maxRequests,
            maxRequestRetries: 3,
        });
        
        await crawler.run(urls);
        
        // Calculate statistics
        const totalDeals = results.reduce((sum, page) => sum + page.deals.length, 0);
        const totalLinks = results.reduce((sum, page) => sum + page.links.length, 0);
        
        res.json({
            success: true,
            message: 'Configurable crawling completed',
            data: {
                pagesCrawled: results.length,
                totalDeals: totalDeals,
                totalLinks: totalLinks,
                config: {
                    maxRequests,
                    linkStrategy: config.linkStrategy,
                    followPatterns: config.followPatterns
                },
                results: results
            }
        });
        
    } catch (error) {
        console.error('Configurable crawl error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get configuration endpoint
app.get('/config', (req, res) => {
    try {
        const config = getConfig();
        res.json({
            success: true,
            data: config
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Update configuration endpoint
app.put('/config', (req, res) => {
    try {
        const { config: newConfig } = req.body;
        
        // In a stateless environment, we can't persist config changes
        // This endpoint returns the merged config for the current request
        const currentConfig = getConfig();
        const mergedConfig = { ...currentConfig, ...newConfig };
        
        res.json({
            success: true,
            message: 'Configuration merged (not persisted in stateless mode)',
            data: mergedConfig
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Crawlee API Server running on port ${PORT}`);
    console.log(`📋 Available endpoints:`);
    console.log(`   GET  /health                    - Health check`);
    console.log(`   POST /crawl/basic              - Basic crawling`);
    console.log(`   POST /crawl/advanced           - Advanced crawling with data extraction`);
    console.log(`   POST /crawl/configurable       - Configurable crawling`);
    console.log(`   GET  /config                   - Get current configuration`);
    console.log(`   PUT  /config                   - Update configuration`);
    console.log(`\n🌐 API Documentation:`);
    console.log(`   http://localhost:${PORT}/health`);
}); 