import { Dataset } from 'crawlee';
import fs from 'fs/promises';
import path from 'path';

async function analyzeData() {
    try {
        console.log('📊 Analyzing collected data...\n');
        
        // Open the dataset
        const dataset = await Dataset.open();
        const stats = await dataset.getInfo();
        
        console.log(`📈 Dataset Statistics:`);
        console.log(`   Total items: ${stats.itemCount}`);
        console.log(`   Dataset ID: ${dataset.id}`);
        console.log(`   Created: ${stats.createdAt}`);
        console.log(`   Modified: ${stats.modifiedAt}\n`);
        
        if (stats.itemCount === 0) {
            console.log('❌ No data found in dataset. Run the crawler first.');
            return;
        }
        
        // Get all data
        const data = await dataset.getData();
        
        console.log('📋 Data Summary:');
        console.log(`   Total pages crawled: ${data.items.length}`);
        
        // Analyze deals
        let totalDeals = 0;
        let dealsWithPrices = 0;
        let dealsWithImages = 0;
        const stores = new Set();
        const categories = new Set();
        
        data.items.forEach(item => {
            if (item.deals) {
                totalDeals += item.deals.length;
                
                item.deals.forEach(deal => {
                    if (deal.price) dealsWithPrices++;
                    if (deal.image) dealsWithImages++;
                    if (deal.store) stores.add(deal.store);
                    if (deal.category) categories.add(deal.category);
                });
            }
        });
        
        console.log(`   Total deals found: ${totalDeals}`);
        console.log(`   Deals with prices: ${dealsWithPrices}`);
        console.log(`   Deals with images: ${dealsWithImages}`);
        console.log(`   Unique stores: ${stores.size}`);
        console.log(`   Unique categories: ${categories.size}\n`);
        
        // Show some sample deals
        console.log('🛍️  Sample Deals:');
        let sampleCount = 0;
        data.items.forEach(item => {
            if (item.deals && sampleCount < 5) {
                item.deals.slice(0, 2).forEach(deal => {
                    if (sampleCount < 5) {
                        console.log(`   ${deal.title || 'No title'} - ${deal.price || 'No price'}`);
                        sampleCount++;
                    }
                });
            }
        });
        
        // Export data to JSON
        const exportPath = path.join(process.cwd(), 'exported-data.json');
        await fs.writeFile(exportPath, JSON.stringify(data, null, 2));
        console.log(`\n💾 Data exported to: ${exportPath}`);
        
        // Export deals only
        const allDeals = [];
        data.items.forEach(item => {
            if (item.deals) {
                allDeals.push(...item.deals);
            }
        });
        
        const dealsPath = path.join(process.cwd(), 'deals-only.json');
        await fs.writeFile(dealsPath, JSON.stringify(allDeals, null, 2));
        console.log(`💾 Deals exported to: ${dealsPath}`);
        
        // Generate CSV-like summary
        const csvData = allDeals.map(deal => ({
            title: deal.title || '',
            price: deal.price || '',
            originalPrice: deal.originalPrice || '',
            discount: deal.discount || '',
            store: deal.store || '',
            category: deal.category || '',
            sourceUrl: deal.sourceUrl || '',
            timestamp: deal.timestamp || '',
        }));
        
        const csvPath = path.join(process.cwd(), 'deals-summary.csv');
        const csvHeader = Object.keys(csvData[0]).join(',');
        const csvRows = csvData.map(row => Object.values(row).map(val => `"${val}"`).join(','));
        const csvContent = [csvHeader, ...csvRows].join('\n');
        
        await fs.writeFile(csvPath, csvContent);
        console.log(`💾 CSV summary exported to: ${csvPath}`);
        
        console.log('\n✅ Data analysis completed!');
        
    } catch (error) {
        console.error('❌ Error analyzing data:', error);
        process.exit(1);
    }
}

// Run analysis
analyzeData(); 