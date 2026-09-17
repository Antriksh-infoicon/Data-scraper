const axios = require('axios');
const cheerio = require('cheerio');
// Import our helper functions from utils.js
const { extractCategoryFromUrl, cleanText, sleep } = require('./utils');

// This function scrapes a single category page (like the "vegan" page)
async function scrapeCategory(url) {
    // Extract just the category name from the full URL (e.g., "bio-vegan")
    const category = extractCategoryFromUrl(url);
    const products = [];
    
    try {
        console.log(`Scraping category: ${category} (${url})`);
        
        // 1. Download the HTML of the category page
        const response = await axios.get(url, {
            headers: {
                // Pretend to be a browser so the server allows our request
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        });
        
        // 2. Load the downloaded HTML into cheerio
        const $ = cheerio.load(response.data);
        
        // 3. Find every product block on the page. 
        // Based on our analysis, every product is wrapped in a div with the class '.wrapper-product-preview'
        $('.wrapper-product-preview').each((i, el) => {
            
            // --- Extract the Title ---
            // Find the <h1> tag inside the title area
            const titleEl = $(el).find('.product-preview_title h1');
            const title = cleanText(titleEl.text()); // Clean up extra spaces/newlines
            
            // --- Extract the Image URL ---
            // Find the <img> tag
            const imgEl = $(el).find('img');
            let imageUrl = imgEl.attr('src'); // Try to get the normal src attribute
            
            // If the src is missing (sometimes websites use lazy-loading or <source> tags instead)
            if (!imageUrl) {
                 // Try to get it from the <source srcset="..."> attribute
                 imageUrl = $(el).find('source').attr('srcset');
                 if (imageUrl) {
                     // srcset usually has multiple sizes like "img1.jpg 100w, img2.jpg 200w"
                     // We split by comma to get the first one, then split by space to remove the "100w" size label
                     imageUrl = imageUrl.split(',')[0].split(' ')[0];
                 }
            }
            
            // --- Extract the Product URL ---
            // The product block is usually wrapped in a clickable link <a>
            let productUrl = $(el).closest('a').attr('href');
            if (!productUrl) {
                // If the block itself isn't a link, check if there's a link inside it
                productUrl = $(el).find('a').attr('href');
            }
            
            // If we successfully found a product title, save all the details to our list
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
        
        // 4. Add a small 0.5 second delay to be polite to the website's server
        // If we make requests too fast, the server might block our IP address
        await sleep(500);
        
        return products;
    } catch (error) {
        console.error(`Error scraping category ${url}:`, error.message);
        return []; // If this category fails, return an empty list so the rest of the script doesn't crash
    }
}

module.exports = {
    scrapeCategory
};
