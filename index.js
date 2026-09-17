const { getCategoryUrls } = require('./src/sitemap');
const { scrapeCategory } = require('./src/scraper');
const { exportData } = require('./src/exporter');

async function main() {
    console.log("Starting Natuerlich-fuer-uns Data Scraper...");
    
    try {
        const categoryUrls = await getCategoryUrls();
        console.log(`Discovered ${categoryUrls.length} category URLs to scrape.`);
        
        let allProducts = [];
        let uniqueProductKeys = new Set();
        
        for (let i = 0; i < categoryUrls.length; i++) {
            const url = categoryUrls[i];
            console.log(`\n[${i+1}/${categoryUrls.length}] Processing ${url}...`);
            const products = await scrapeCategory(url);
            
            // Deduplicate across categories
            for (const p of products) {
                const key = p.name.toLowerCase() + '-' + p.category;
                if (!uniqueProductKeys.has(key)) {
                    uniqueProductKeys.add(key);
                    allProducts.push(p);
                }
            }
        }
        
        console.log(`\nScraping complete. Collected ${allProducts.length} unique products.`);
        await exportData(allProducts);
        
        console.log("All done!");
    } catch (error) {
        console.error("An error occurred during scraping:", error);
    }
}

main();
