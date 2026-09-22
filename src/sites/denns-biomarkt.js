/**
 * Website Scraper Module for Denns BioMarkt (https://www.denns-biomarkt.at)
 * 
 * Features:
 * - Scrapes all publicly available bio offer products and market items from denns-biomarkt.at
 * - Deep extraction of Product Name, Category, Price, Regular Price, Sale Price, Brand, Description, Weight/Quantity, EAN, Ingredients/Attributes, Country, Image URL, etc.
 * - Deduplicates products by product ID / item number
 * - Exports to data/denns-biomarkt.csv and data/denns-biomarkt.xlsx
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { cleanText, sleep } = require('../utils');

const siteName = 'Denns BioMarkt';
const siteSlug = 'denns-biomarkt';

// User-Agent header
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
};

// Endpoints providing publicly accessible product and offer data for denns-biomarkt.at
const PRODUCT_ENDPOINTS = [
    'https://www.denns-biomarkt.at/page-data/angebote/page-data.json',
    'https://www.denns-biomarkt.at/page-data/index/page-data.json'
];

/**
 * Main scraper execution function for Denns BioMarkt
 * 
 * @param {Object} options - Execution options
 * @param {number} [options.limit] - Limit total products for testing (e.g. 5)
 */
async function run(options = {}) {
    console.log(`\n=================================================`);
    console.log(`   STARTING SCRAPER FOR: ${siteName} (${siteSlug})`);
    console.log(`=================================================\n`);

    const limit = options.limit || null;
    const productsMap = new Map();

    let totalUrlsFound = 0;
    let successfulCount = 0;
    let failedCount = 0;

    for (const endpointUrl of PRODUCT_ENDPOINTS) {
        if (limit && productsMap.size >= limit) break;

        console.log(`[${siteSlug}] Fetching product data from: ${endpointUrl}...`);
        try {
            const res = await axios.get(endpointUrl, {
                headers: HTTP_HEADERS,
                timeout: 12000
            });

            const data = res.data;
            if (!data || !data.result || !data.result.data) continue;

            const resultData = data.result.data;

            // Target node arrays containing products
            const collections = [
                resultData.sanityAllOffers?.nodes || [],
                resultData.noLimitOffers?.nodes || [],
                resultData.sanityMarketOffers?.nodes || []
            ];

            for (const nodeList of collections) {
                totalUrlsFound += nodeList.length;

                for (const node of nodeList) {
                    if (limit && productsMap.size >= limit) break;
                    if (!node) continue;

                    const title = cleanText(node.title);
                    if (!title) {
                        failedCount++;
                        continue;
                    }

                    const itemno = node.itemno || node._id || '';
                    const brand = cleanText(node.brand) || 'Denns BioMarkt';

                    // Price formatting
                    let price = '';
                    if (node.price !== undefined && node.price !== null) {
                        price = typeof node.price === 'number' ? `${node.price.toFixed(2)} €` : `${node.price} €`;
                    } else if (node.priceAb) {
                        price = `ab ${node.priceAb} €`;
                    }

                    // Regular price formatting (strike price)
                    let regularPrice = '';
                    if (node.strikePriceAb) {
                        regularPrice = `${node.strikePriceAb} €`;
                    } else if (node.priceb) {
                        regularPrice = `${node.priceb} €`;
                    }

                    // Sale price / discount badge
                    let salePrice = '';
                    if (node.pricebanner) {
                        salePrice = `${node.pricebanner}`;
                    }

                    // Image URL
                    let imageUrl = node.image || '';
                    if (!imageUrl && node.offerImage && node.offerImage.asset) {
                        imageUrl = node.offerImage.asset.url || '';
                    }

                    // Category extraction
                    let category = 'Bio Angebote';
                    if (node.articleGroup) {
                        if (typeof node.articleGroup === 'object') {
                            category = node.articleGroup.productGroup?.title || node.articleGroup.title || 'Bio Angebote';
                        } else if (typeof node.articleGroup === 'string') {
                            category = node.articleGroup;
                        }
                    }

                    // Attributes & Allergens
                    const attrs = [];
                    if (node.vegan) attrs.push('Vegan');
                    if (node.vegetarian) attrs.push('Vegetarisch');
                    if (node.lactosefree) attrs.push('Laktosefrei');
                    if (node.glutenfree) attrs.push('Glutenfrei');

                    const productUrl = `https://www.denns-biomarkt.at/angebote/#${itemno}`;
                    const uniqueKey = itemno || title.toLowerCase();

                    if (!productsMap.has(uniqueKey)) {
                        productsMap.set(uniqueKey, {
                            name: title,
                            category: category,
                            productUrl: productUrl,
                            imageUrl: imageUrl,
                            price: price,
                            regularPrice: regularPrice,
                            salePrice: salePrice,
                            brand: brand,
                            description: cleanText(node.shordesc || node.subtitle),
                            quantity: cleanText(node.subtitle),
                            ingredients: attrs.length > 0 ? `Eigenschaften: ${attrs.join(', ')}` : '',
                            ean: itemno,
                            country: node.land === 'at' ? 'Österreich' : (node.land || 'Österreich'),
                            sourceUrl: 'https://www.denns-biomarkt.at/angebote/'
                        });
                        successfulCount++;
                    }
                }
            }

            await sleep(300);

        } catch (e) {
            console.error(`[${siteSlug}] Error fetching endpoint ${endpointUrl}:`, e.message);
        }
    }

    const products = Array.from(productsMap.values());

    console.log(`\n=================================================`);
    console.log(`   SCRAPE SUMMARY FOR ${siteName}`);
    console.log(`=================================================`);
    console.log(`- Total Product URLs Found:       ${totalUrlsFound}`);
    console.log(`- Total Unique Products Scraped:  ${products.length}`);
    console.log(`- Products Successfully Scraped:  ${successfulCount}`);
    console.log(`- Products Failed:               ${failedCount}`);
    console.log(`=================================================\n`);

    return products;
}

module.exports = {
    siteName,
    siteSlug,
    run
};
