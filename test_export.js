const { scrapeCategory } = require('./src/scraper');

async function runTest() {
    console.log("Running 5-product test for Product URL extraction...");
    const url = 'https://natuerlich-fuer-uns.at/produkt-kategorien/bio-vegan/';
    const products = await scrapeCategory(url);
    
    const testProducts = products.slice(0, 5);
    console.log("Test Results:");
    console.log(JSON.stringify(testProducts, null, 2));
}

runTest();
