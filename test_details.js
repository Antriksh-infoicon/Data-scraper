const axios = require('axios');
const cheerio = require('cheerio');
const { extractCategoryFromUrl, cleanText } = require('./src/utils');

async function test5Products() {
    console.log("Testing 5 products detail extraction...");
    const catUrl = 'https://natuerlich-fuer-uns.at/produkt-kategorien/bio-vegan/';
    
    let response;
    try {
        response = await axios.get(catUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
    } catch (e) {
        console.error("Failed to load category", e.message);
        return;
    }
    
    const $ = cheerio.load(response.data);
    const previews = $('.wrapper-product-preview').slice(0, 5);
    
    const products = [];
    
    for (let i = 0; i < previews.length; i++) {
        const el = previews.eq(i);
        const title = cleanText(el.find('.product-preview_title h1').text());
        
        // Find the product URL - usually an <a> tag wrapping the preview or inside it
        let productUrl = el.closest('a').attr('href');
        if (!productUrl) {
            productUrl = el.find('a').attr('href');
        }
        
        if (!productUrl) {
            // Check if there is an onclick or other attribute
            console.log(`Product "${title}" has no <a> wrapper. Classes:`, el.attr('class'));
        }
        
        const prodData = {
            name: title,
            url: productUrl || 'NOT_FOUND',
            details: {}
        };
        
        if (productUrl) {
            try {
                // Fetch the detail page
                const detailRes = await axios.get(productUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    maxRedirects: 0 // Do not follow redirects so we can see if it 301s
                }).catch(e => e.response || e);
                
                prodData.statusCode = detailRes.status;
                prodData.redirectUrl = detailRes.headers.location;
                
                if (detailRes.status === 200 && detailRes.data) {
                    const $detail = cheerio.load(detailRes.data);
                    // Extract some fields as test
                    prodData.details.h1 = cleanText($detail('h1').text());
                    prodData.details.ingredients = cleanText($detail('.ingredients, [class*="zutaten"]').text());
                    prodData.details.nutrition = cleanText($detail('.nutrition, table').text()).substring(0, 50);
                    // Add more if we see them
                } else {
                    prodData.details.error = `HTTP ${detailRes.status}`;
                }
            } catch (err) {
                prodData.details.error = err.message;
            }
        }
        
        products.push(prodData);
    }
    
    console.log(JSON.stringify(products, null, 2));
}

test5Products();
