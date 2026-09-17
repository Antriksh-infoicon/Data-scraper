// require() is used to import functions from our other files (modules)
const { getCategoryUrls } = require('./src/sitemap');
const { scrapeCategory } = require('./src/scraper');
const { exportData } = require('./src/exporter');

// The main function is declared 'async' because we need to wait (await) for network requests to finish
async function main() {
    console.log("Starting Natuerlich-fuer-uns Data Scraper...");
    
    try {
        // Step 1: Get all the category URLs from the sitemap
        const categoryUrls = await getCategoryUrls();
        console.log(`Discovered ${categoryUrls.length} category URLs to scrape.`);
        
        // This array will hold all the final products we collect
        let allProducts = [];
        
        // A 'Set' is a special data structure that only stores unique values.
        // We use it here to remember which products we've already seen, to avoid duplicates.
        let uniqueProductKeys = new Set();
        
        // Step 2: Loop through every category URL one by one
        for (let i = 0; i < categoryUrls.length; i++) {
            const url = categoryUrls[i];
            console.log(`\n[${i+1}/${categoryUrls.length}] Processing ${url}...`);
            
            // Wait for the scraper to finish downloading and extracting products from this category
            const products = await scrapeCategory(url);
            
            // Step 3: Deduplicate (remove duplicates) across categories
            // Sometimes one product (like an apple) is in "Fruits" and "Vegan" categories.
            for (const p of products) {
                // Create a unique key by combining the name and category
                const key = p.name.toLowerCase() + '-' + p.category;
                
                // If we haven't seen this key before, add it to our Set and save the product
                if (!uniqueProductKeys.has(key)) {
                    uniqueProductKeys.add(key);
                    allProducts.push(p);
                }
            }
        }
        
        // Step 4: Scraping is done! Now export the collected products
        console.log(`\nScraping complete. Collected ${allProducts.length} unique products.`);
        await exportData(allProducts);
        
        console.log("All done!");
    } catch (error) {
        // If anything goes completely wrong (like the internet dies), catch the error here and print it
        console.error("An error occurred during scraping:", error);
    }
}

// Start the program by calling the main function
main();
