// Built-in Node.js modules to interact with file system and paths
const fs = require('fs');
const path = require('path');
// Import our exporter module that saves products to CSV and Excel
const { exportData } = require('./src/exporter');

/**
 * Main Orchestrator for Multi-Website Scraper
 * 
 * Rules enforced:
 * 1. Each website is scraped separately.
 * 2. All products from one website are stored in ONE CSV file and ONE Excel file inside `data/`.
 * 3. Filename is automatically generated based on the website name / domain.
 * 4. Websites do not overwrite each other's files.
 */
async function main() {
    console.log("=========================================");
    console.log("   MULTI-WEBSITE DATA SCRAPER ENGINE     ");
    console.log("=========================================\n");

    const sitesDir = path.join(__dirname, 'src', 'sites');

    // Read command-line arguments (e.g. `node index.js natuerlich-fuer-uns`)
    const targetSiteArg = process.argv[2] ? process.argv[2].toLowerCase().trim() : null;

    try {
        // Find all site modules in `src/sites/` (excluding .example files)
        const siteFiles = fs.readdirSync(sitesDir).filter(file => 
            (file.endsWith('.js') || file.endsWith('.cjs')) && !file.endsWith('.example')
        );

        if (siteFiles.length === 0) {
            console.error("No website scrapers found in src/sites/");
            return;
        }

        console.log(`Found ${siteFiles.length} website scraper module(s): ${siteFiles.join(', ')}\n`);

        // Loop over each registered site scraper module
        for (const file of siteFiles) {
            const sitePath = path.join(sitesDir, file);
            const siteModule = require(sitePath);

            const siteName = siteModule.siteName || file.replace(/\.js$/, '');
            const siteSlug = siteModule.siteSlug || siteName;

            // If a specific site argument was passed, filter by that site
            if (targetSiteArg && !siteSlug.toLowerCase().includes(targetSiteArg) && !siteName.toLowerCase().includes(targetSiteArg)) {
                continue;
            }

            console.log(`>>> Starting scrape job for: ${siteName} <<<`);
            
            // 1. Run the website-specific scraper module to collect products
            const products = await siteModule.run();

            // 2. Export collected products to website-specific CSV and Excel files in data/
            if (products && products.length > 0) {
                await exportData(siteSlug, products);
            } else {
                console.log(`No products collected for ${siteName}. Skipping export.`);
            }

            console.log(`\n>>> Completed scrape job for: ${siteName} <<<\n`);
        }

        console.log("=========================================");
        console.log("   ALL SCRAPING JOBS COMPLETED SUCCESSFULLY");
        console.log("=========================================");

    } catch (error) {
        console.error("An error occurred during execution:", error);
    }
}

// Execute main function
main();
