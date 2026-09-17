const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('category_vegan.html', 'utf8');
const $ = cheerio.load(html);

const preview = $('.wrapper-product-preview').first();
console.log(preview.html());

console.log("\n--- Second preview ---");
console.log($('.wrapper-product-preview').eq(1).html());
