// Client example for the Crawlee REST API
const API_BASE_URL = 'http://localhost:3000';

async function testAPI() {
    console.log('🧪 Testing Crawlee REST API...\n');

    try {
        // Test health check
        console.log('1. Testing health check...');
        const healthResponse = await fetch(`${API_BASE_URL}/health`);
        const healthData = await healthResponse.json();
        console.log('✅ Health check:', healthData.status);
        console.log('   Version:', healthData.version);
        console.log('   Timestamp:', healthData.timestamp);
        console.log('');

        // Test basic crawling
        console.log('2. Testing basic crawling...');
        const basicResponse = await fetch(`${API_BASE_URL}/crawl/basic`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                urls: ['https://httpbin.org/html'],
                maxRequests: 1
            })
        });
        const basicData = await basicResponse.json();
        console.log('✅ Basic crawling completed');
        console.log('   Pages crawled:', basicData.data.pagesCrawled);
        console.log('   Results:', basicData.data.results.length, 'pages');
        console.log('');

        // Test advanced crawling
        console.log('3. Testing advanced crawling...');
        const advancedResponse = await fetch(`${API_BASE_URL}/crawl/advanced`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                urls: ['https://httpbin.org/html'],
                maxRequests: 1
            })
        });
        const advancedData = await advancedResponse.json();
        console.log('✅ Advanced crawling completed');
        console.log('   Pages crawled:', advancedData.data.pagesCrawled);
        console.log('   Total deals:', advancedData.data.totalDeals);
        console.log('   Total links:', advancedData.data.totalLinks);
        console.log('');

        // Test configurable crawling
        console.log('4. Testing configurable crawling...');
        const configResponse = await fetch(`${API_BASE_URL}/crawl/configurable`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                urls: ['https://httpbin.org/html'],
                maxRequests: 1,
                customConfig: {
                    followPatterns: ['**/html/**'],
                    excludePatterns: ['**/login/**']
                }
            })
        });
        const configData = await configResponse.json();
        console.log('✅ Configurable crawling completed');
        console.log('   Pages crawled:', configData.data.pagesCrawled);
        console.log('   Config used:', configData.data.config.linkStrategy);
        console.log('');

        // Test get configuration
        console.log('5. Testing get configuration...');
        const getConfigResponse = await fetch(`${API_BASE_URL}/config`);
        const getConfigData = await getConfigResponse.json();
        console.log('✅ Configuration retrieved');
        console.log('   Max requests:', getConfigData.data.maxRequestsPerCrawl);
        console.log('   Link strategy:', getConfigData.data.linkStrategy);
        console.log('   Follow patterns:', getConfigData.data.followPatterns.length, 'patterns');
        console.log('');

        console.log('🎉 All API tests completed successfully!');
        console.log('\n📋 API Endpoints Summary:');
        console.log('   GET  /health                    - Health check');
        console.log('   POST /crawl/basic              - Basic crawling');
        console.log('   POST /crawl/advanced           - Advanced crawling');
        console.log('   POST /crawl/configurable       - Configurable crawling');
        console.log('   GET  /config                   - Get configuration');
        console.log('   PUT  /config                   - Update configuration');

    } catch (error) {
        console.error('❌ API test failed:', error.message);
        console.log('\n💡 Make sure the API server is running:');
        console.log('   npm run api');
        console.log('   or');
        console.log('   docker-compose up -d');
    }
}

// Run the test
testAPI(); 