const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('category_vegan.html', 'utf8');
const $ = cheerio.load(html);

// Find all elements containing "Bio Gemüselaibchen" to figure out the class names
const els = $('*:contains("Bio Gemüselaibchen")').last();

if (els.length > 0) {
    let current = els;
    for(let i=0; i<3; i++) {
        console.log(`Parent ${i} classes:`, current.attr('class'));
        current = current.parent();
    }
}

// Let's dump all headings
console.log("\nHeadings:");
$('h2, h3, h4').each((i, el) => {
    const txt = $(el).text().trim();
    if (txt) console.log(el.tagName, txt);
});

console.log("\nLinks in this page containing 'bio-gemuselaibchen' or similar:");
$('a').each((i, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('gemuse')) {
        console.log(href);
    }
});

// Let's check if there is an accordion or modal for product details
console.log("Modals:", $('.modal, [class*="modal"]').length);
console.log("Popups:", $('.popup, [class*="popup"]').length);
