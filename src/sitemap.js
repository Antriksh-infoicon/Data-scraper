const axios = require('axios');
const cheerio = require('cheerio');

const CATEGORY_SITEMAP_URL = 'https://natuerlich-fuer-uns.at/produkt-kategorien-sitemap.xml';

async function getCategoryUrls() {
    try {
        console.log(`Fetching category sitemap: ${CATEGORY_SITEMAP_URL}`);
        const response = await axios.get(CATEGORY_SITEMAP_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        });
        
        const $ = cheerio.load(response.data, { xmlMode: true });
        const urls = [];
        
        $('loc').each((i, el) => {
            const url = $(el).text();
            if (url.includes('/produkt-kategorien/')) {
                urls.push(url);
            }
        });
        
        console.log(`Found ${urls.length} category URLs.`);
        return urls;
    } catch (error) {
        console.error('Error fetching category sitemap:', error.message);
        throw error;
    }
}

module.exports = {
    getCategoryUrls
};
