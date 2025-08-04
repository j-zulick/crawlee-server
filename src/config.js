export const config = {
    // Target URLs
    startUrls: ['https://www.dealnews.com'],
    
    // Crawler limits
    maxRequestsPerCrawl: 20,
    maxRequestRetries: 3,
    
    // Link following strategy
    linkStrategy: 'same-domain',
    
    // URL patterns to follow (glob patterns)
    followPatterns: [
        '**/deals/**',
        '**/products/**',
        '**/sales/**',
        '**/offers/**',
        '**/discounts/**',
    ],
    
    // URL patterns to exclude
    excludePatterns: [
        '**/login/**',
        '**/register/**',
        '**/cart/**',
        '**/checkout/**',
        '**/admin/**',
        '**/api/**',
        '**/*.pdf',
        '**/*.jpg',
        '**/*.png',
        '**/*.gif',
    ],
    
    // Data extraction selectors
    selectors: {
        deals: '[class*="deal"], [class*="product"], [class*="item"]',
        titles: 'h1, h2, h3, h4, .title, .name',
        prices: '[class*="price"], .price, .cost',
        originalPrices: '[class*="original"], .original-price',
        discounts: '[class*="discount"], .discount, .savings',
        descriptions: '[class*="description"], .description, .summary',
        images: 'img',
        links: 'a',
        categories: '[class*="category"], .category',
        stores: '[class*="store"], .store, .merchant',
    },
    
    // Output settings
    output: {
        saveToDataset: true,
        logToConsole: true,
        maxDealsToLog: 3,
    },
    
    // Rate limiting (requests per second)
    rateLimit: 1,
};

// Environment-specific overrides
export const getConfig = () => {
    const env = process.env.NODE_ENV || 'development';
    
    if (env === 'production') {
        return {
            ...config,
            maxRequestsPerCrawl: 50,
            logLevel: 'WARNING',
            rateLimit: 0.5, // Slower for production
        };
    }
    
    if (env === 'testing') {
        return {
            ...config,
            maxRequestsPerCrawl: 5,
            logLevel: 'DEBUG',
        };
    }
    
    return config;
}; 