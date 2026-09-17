// axios is a library used to make HTTP requests (like fetching a web page)
const axios = require('axios');
// cheerio is a library that lets us parse and search HTML/XML easily, just like jQuery
const cheerio = require('cheerio');

// The URL of the XML sitemap that contains all the category links
const CATEGORY_SITEMAP_URL = 'https://natuerlich-fuer-uns.at/produkt-kategorien-sitemap.xml';

// This function goes to the sitemap and extracts all the category URLs
async function getCategoryUrls() {
    try {
        console.log(`Fetching category sitemap: ${CATEGORY_SITEMAP_URL}`);
        
        // 1. Fetch the sitemap. We pretend to be a normal web browser using the 'User-Agent' header
        // so the server doesn't block us for being a bot.
        const response = await axios.get(CATEGORY_SITEMAP_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        });
        
        // 2. Load the downloaded XML data into cheerio so we can search it
        // We set { xmlMode: true } because this is an XML file, not HTML
        const $ = cheerio.load(response.data, { xmlMode: true });
        
        // This array will store all the valid category URLs we find
        const urls = [];
        
        // 3. Find every <loc> tag in the XML file (this is where the URLs are stored)
        $('loc').each((i, el) => {
            const url = $(el).text(); // Get the actual text inside the <loc>...</loc> tags
            
            // Only keep the URL if it is actually a product category
            if (url.includes('/produkt-kategorien/')) {
                urls.push(url);
            }
        });
        
        console.log(`Found ${urls.length} category URLs.`);
        return urls; // Send the list of URLs back to whoever called this function
    } catch (error) {
        // If we fail to fetch the sitemap, log the error
        console.error('Error fetching category sitemap:', error.message);
        throw error;
    }
}

// Export the function so it can be used in other files (like index.js)
module.exports = {
    getCategoryUrls
};
