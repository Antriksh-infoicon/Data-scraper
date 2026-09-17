const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('category_vegan.html', 'utf8');
const $ = cheerio.load(html);

console.log("Category Title:", $('title').text());
console.log("H1:", $('h1').text().trim());

const products = $('.product, .product-item, [class*="product"]');
console.log("Product elements found:", products.length);

if (products.length > 0) {
    console.log("\nSample product details:");
    const firstProd = products.first();
    console.log("Text inside:", firstProd.text().replace(/\s+/g, ' ').trim().substring(0, 100));
}

// Check for vue data attributes or scripts again
let productsData = null;
$('script').each((i, el) => {
    const content = $(el).html();
    if (content && content.includes('products') && content.includes('{')) {
        console.log(`Found a script that might contain product data (length: ${content.length})`);
    }
});

// Since WordPress is often used here, check if it's rendered by an API or Ajax request
console.log("\nAjax/API signs:");
console.log("wc-ajax =", html.includes('wc-ajax') ? 'Yes' : 'No');
console.log("admin-ajax.php =", html.includes('admin-ajax.php') ? 'Yes' : 'No');

console.log("Any data attributes with JSON?", $('[data-product]').length);
