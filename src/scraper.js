const axios = require('axios');
const cheerio = require('cheerio');
const { extractCategoryFromUrl, cleanText, sleep } = require('./utils');

async function scrapeCategory(url) {
    const category = extractCategoryFromUrl(url);
    const products = [];
    
    try {
        console.log(`Scraping category: ${category} (${url})`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(response.data);
        
        // As analyzed, products are in .wrapper-product-preview
        $('.wrapper-product-preview').each((i, el) => {
            const titleEl = $(el).find('.product-preview_title h1');
            const title = cleanText(titleEl.text());
            
            // Image is usually the src or srcset of img, or source element
            const imgEl = $(el).find('img');
            let imageUrl = imgEl.attr('src');
            
            if (!imageUrl) {
                 imageUrl = $(el).find('source').attr('srcset');
                 if (imageUrl) {
                     imageUrl = imageUrl.split(',')[0].split(' ')[0]; // Take first URL in srcset
                 }
            }
            
            // Extract the individual product URL
            let productUrl = $(el).closest('a').attr('href');
            if (!productUrl) {
                productUrl = $(el).find('a').attr('href');
            }
            
            if (title) {
                products.push({
                    name: title,
                    category: category,
                    imageUrl: imageUrl || '',
                    sourceUrl: url,
                    productUrl: productUrl || ''
                });
            }
        });
        
        console.log(`Extracted ${products.length} products from ${category}`);
        
        // Add a small delay to be polite
        await sleep(500);
        
        return products;
    } catch (error) {
        console.error(`Error scraping category ${url}:`, error.message);
        return [];
    }
}

module.exports = {
    scrapeCategory
};
