const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('produktwelt.html', 'utf8');
const $ = cheerio.load(html);

console.log("Title:", $('title').text());
console.log("Number of elements with class containing 'product':", $('[class*="product"]').length);
console.log("Number of elements with class containing 'item':", $('[class*="item"]').length);

// Look for inline scripts that might contain product data
let dataFound = false;
$('script').each((i, el) => {
    const text = $(el).html();
    if (text && (text.includes('products') || text.includes('Produkte') || text.includes('produkte'))) {
        console.log(`Script ${i} length: ${text.length}`);
        if (text.length < 1000) {
            console.log(text.trim());
        } else {
            console.log("Snippet:", text.substring(0, 200).trim());
        }
    }
});

console.log("Looking for Vue or React roots, or specific data attributes...");
console.log("Vue root:", $('#app').length > 0 ? "Yes" : "No");
console.log("Any component with data-products:", $('[data-products]').length > 0 ? "Yes" : "No");

console.log("\nTrying to find any product names directly in HTML...");
const h3s = $('h3').map((i, el) => $(el).text().trim()).get();
console.log("H3s:", h3s.slice(0, 10));

const h2s = $('h2').map((i, el) => $(el).text().trim()).get();
console.log("H2s:", h2s.slice(0, 10));

const links = $('a').map((i, el) => $(el).attr('href')).get().filter(href => href && href.includes('produkt'));
console.log("Links containing 'produkt':", links.slice(0, 10));
