const fs = require('fs');
const cheerio = require('cheerio');

// Analyze product page
const productHtml = fs.readFileSync('product_leberkase.html', 'utf8');
const $prod = cheerio.load(productHtml);

console.log("=== PRODUCT PAGE ANALYSIS ===");
console.log("Title:", $prod('title').text());
console.log("JSON-LD scripts found:", $prod('script[type="application/ld+json"]').length);

$prod('script[type="application/ld+json"]').each((i, el) => {
    try {
        const json = JSON.parse($prod(el).html());
        console.log(`JSON-LD block ${i}:`, JSON.stringify(json, null, 2).substring(0, 500) + '...');
    } catch(e) {}
});

console.log("\nPossible attributes / structured data:");
$prod('table, .woocommerce-product-attributes, .product-attributes, .attributes').each((i, el) => {
    console.log(`Table ${i}:`, $prod(el).html().substring(0, 200));
});

console.log("\nFields from DOM:");
console.log("H1:", $prod('h1').text().trim());
console.log("Price:", $prod('.price').text().trim());
console.log("SKU:", $prod('.sku').text().trim());
console.log("Categories:", $prod('.posted_in').text().trim());

console.log("\nImages:");
$prod('img').slice(0, 5).each((i, el) => {
    console.log(`Img ${i}: src=${$prod(el).attr('src')}, data-src=${$prod(el).attr('data-src')}, loading=${$prod(el).attr('loading')}`);
});

console.log("\n=== INDEX PAGE ANALYSIS ===");
const indexHtml = fs.readFileSync('products_index.html', 'utf8');
const $idx = cheerio.load(indexHtml);

console.log("Index Title:", $idx('title').text());
console.log("Pagination found:", $idx('.woocommerce-pagination, .pagination').length > 0 ? "Yes" : "No");
if ($idx('.woocommerce-pagination, .pagination').length > 0) {
    console.log("Pagination HTML:", $idx('.woocommerce-pagination, .pagination').html().substring(0, 300));
}
console.log("Product links on index:", $idx('a[href*="/produkte/"]').length);
