// Module specifically for scraping "natuerlich-fuer-uns.at"
const { getCategoryUrls } = require('../sitemap');
const { scrapeCategory } = require('../scraper');

const siteName = 'natuerlich-fuer-uns.at';
const siteSlug = 'natuerlich-fuer-uns';

/**
 * Runs the scraper workflow specifically for natuerlich-fuer-uns.at:
 * 1. Fetches all category URLs from sitemap
 * 2. Scrapes products category by category
 * 3. Deduplicates products within this website
 * 4. Returns the cleaned array of products
 */
async function run() {
    console.log(`=== Starting Scraper for Website: ${siteName} ===`);
    
    // Step 1: Fetch category URLs
    const categoryUrls = await getCategoryUrls();
    console.log(`Discovered ${categoryUrls.length} category URLs for ${siteName}.`);
    
    let allProducts = [];
    let uniqueProductKeys = new Set();
    
    // Step 2: Loop through each category URL
    for (let i = 0; i < categoryUrls.length; i++) {
        const url = categoryUrls[i];
        console.log(`\n[${siteSlug}] [${i + 1}/${categoryUrls.length}] Processing ${url}...`);
        
        // Scrape single category
        const products = await scrapeCategory(url);
        
        // Step 3: Deduplicate products for this website
        for (const p of products) {
            // Deduplication key: combination of lowercased name and category
            const key = (p.name || '').toLowerCase() + '-' + (p.category || '');
            
            if (!uniqueProductKeys.has(key)) {
                uniqueProductKeys.add(key);
                allProducts.push(p);
            }
        }
    }
    
    console.log(`\n=== Completed ${siteName}. Collected ${allProducts.length} unique products. ===`);
    return allProducts;
}

module.exports = {
    siteName,
    siteSlug,
    run
};
