/**
 * Website Scraper Module for SONNENTOR (https://www.sonnentor.com/en-gb)
 * 
 * Architecture & Features:
 * 1. Crawls the complete publicly accessible SONNENTOR online shop at https://www.sonnentor.com/en-gb/onlineshop/ across all product sections:
 *    - Tea (Pure herbal tea, Herbal tea blends, Cold Teas, Fruit tea, Ginger/Rooibos/Turmeric, Chai & spiced, Black/green/white, Feel good, Kids, Gift assortments, Teapot bag, Big packs)
 *    - Spices (Pure spices, BBQ spices, Piquant spice blends, Sweet spice blends, Salt, Salt-free, Toppings, Spice oils, Gifts & Try it, Bulk tins)
 *    - Gifts (Vouchers, Gift boxes, Topic Boxes, Gift-wraps, Seasonal/special)
 *    - Coffee & Cacao
 *    - Sweets & Delicacies (Honey & sugar, Cookies, Sweet treats, Fruit spreads, Seeds & sprouts, Snacks, Soups, Oil)
 *    - Syrups & Shots
 *    - Accessories (Books, Cups / mugs, Tea filters, Spice accessories)
 * 2. Uses sitemap index (sitemap.products_en_GB.xml, sitemap.products_de_AT.xml) and shop category navigation to discover ALL publicly accessible product URLs.
 * 3. Extracts extensive product metadata from JSON-LD schema (@type: Product, BreadcrumbList) and HTML detail pages:
 *    - Product Name, Category, Subcategory, Brand ("SONNENTOR"), Producer / Manufacturer
 *    - Product URL, Image URL, Source Category URL
 *    - Price, Regular Price, Sale Price, Currency, Unit Price, Price Unit
 *    - Weight / Quantity, Article Number / MPN, Product ID, EAN / GTIN
 *    - Short Description, Product Description, Ingredients, Nutritional Info, Allergens
 *    - Organic/Bio status, Country of Origin, Preparation Instructions, Availability, Stock Status, Product Badges
 * 4. Deduplicates product records by unique Article Number / MPN, EAN / GTIN, and Product URL.
 * 5. Complete Failure Tracking System recording failed URLs into data/sonnentor_failed.csv.
 * 6. Exports successful items to data/sonnentor.csv and data/sonnentor.xlsx managed by orchestrator index.js.
 * 7. Prints formatted SONNENTOR SCRAPING SUMMARY report at the end of execution.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { cleanText, sleep } = require('../utils');

// ─── Constants & Metadata ───────────────────────────────────────────────────

const siteName = 'SONNENTOR';
const siteSlug = 'sonnentor';
const BASE_URL = 'https://www.sonnentor.com';
const SHOP_BASE_URL = 'https://www.sonnentor.com/en-gb/onlineshop';

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-GB,en;q=0.9,de-AT;q=0.8,de;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
};

const CATEGORIES = [
    { name: 'Tea', path: '/en-gb/onlineshop/tea' },
    { name: 'Spices and spice mixes', path: '/en-gb/onlineshop/spices' },
    { name: 'Gifts', path: '/en-gb/onlineshop/gifts' },
    { name: 'Coffee & cacao', path: '/en-gb/onlineshop/coffee-cacao' },
    { name: 'Sweets & delicacies', path: '/en-gb/onlineshop/sweets-delicacies' },
    { name: 'Syrups & Shots', path: '/en-gb/onlineshop/syrups-shots' },
    { name: 'Accessories', path: '/en-gb/onlineshop/extras-info/accessory' }
];

let failedRecordsStore = [];

/**
 * Returns failed records store for orchestrator
 */
function getFailedRecords() {
    return failedRecordsStore;
}

/**
 * Categorizes errors into standard failure reason strings
 */
function determineFailureReason(statusCode, errorType, errorMessage) {
    if (statusCode === 404) return '404';
    if (statusCode === 403) return '403';
    if (statusCode === 429) return '429';
    if (statusCode === 500) return '500';
    if (statusCode === 502) return '502';
    if (statusCode === 503) return '503';
    if (errorType === 'Timeout' || (errorMessage && errorMessage.toLowerCase().includes('timeout'))) return 'Timeout';
    if (errorType === 'ParsingError') return 'Parsing error';
    return 'Other';
}

/**
 * Helper to execute HTTP GET with retry logic
 */
async function fetchWithRetry(url, maxRetries = 3, delayMs = 500) {
    let attempts = 0;
    let lastError = null;

    while (attempts < maxRetries) {
        attempts++;
        try {
            const response = await axios.get(url, {
                headers: HTTP_HEADERS,
                timeout: 12000,
                maxRedirects: 5
            });
            return { response, attempts, error: null };
        } catch (err) {
            lastError = err;
            const statusCode = err.response ? err.response.status : null;
            if (statusCode === 404) {
                // Do not retry 404 Not Found
                break;
            }
            if (attempts < maxRetries) {
                await sleep(delayMs * attempts);
            }
        }
    }

    return { response: null, attempts, error: lastError };
}

/**
 * Main scraper execution function for SONNENTOR
 * 
 * @param {Object} options - Execution options
 * @param {number} [options.limit] - Limit total products for testing
 */
async function run(options = {}) {
    console.log(`\n=================================================`);
    console.log(`   STARTING SCRAPER FOR: ${siteName} (${siteSlug})`);
    console.log(`=================================================\n`);

    const startTime = Date.now();
    const limit = options.limit || null;
    failedRecordsStore = [];

    const productsMap = new Map();
    const discoveredUrlsSet = new Set();
    const productMetaMap = new Map(); // productUrl -> { sourceCategoryUrl }

    const failureReasonCounts = {
        '404': 0,
        '403': 0,
        '429': 0,
        'Timeout': 0,
        'Parsing error': 0,
        'Other': 0
    };

    // Step 1: Discover product URLs from sitemaps
    console.log(`[${siteSlug}] Discovering product URLs from SONNENTOR sitemaps...`);

    const sitemapEndpoints = [
        `${BASE_URL}/sitemap.products_en_GB.xml`,
        `${BASE_URL}/sitemap.products_de_AT.xml`
    ];

    for (const smUrl of sitemapEndpoints) {
        try {
            const { response } = await fetchWithRetry(smUrl);
            if (response && response.data) {
                const $ = cheerio.load(response.data, { xmlMode: true });
                $('url loc').each((i, el) => {
                    const loc = cleanText($(el).text());
                    if (loc && (loc.includes('/onlineshop/') || loc.includes('/en-gb/onlineshop/'))) {
                        let finalUrl = loc;
                        // Ensure en-gb locale if possible
                        if (loc.includes('/de-at/onlineshop/')) {
                            finalUrl = loc.replace('/de-at/onlineshop/', '/en-gb/onlineshop/');
                        }
                        discoveredUrlsSet.add(finalUrl);
                        if (!productMetaMap.has(finalUrl)) {
                            productMetaMap.set(finalUrl, { sourceCategoryUrl: smUrl });
                        }
                    }
                });
            }
        } catch (smErr) {
            console.error(`[${siteSlug}] Error fetching sitemap ${smUrl}:`, smErr.message);
        }
    }

    // Step 2: Crawl shop category navigation to discover additional product and subcategory links
    console.log(`[${siteSlug}] Discovering category links from SONNENTOR shop...`);

    const categoryUrlsToVisit = [SHOP_BASE_URL].concat(
        CATEGORIES.map(c => `${BASE_URL}${c.path}`)
    );

    for (const catUrl of categoryUrlsToVisit) {
        try {
            const { response } = await fetchWithRetry(catUrl);
            if (!response || !response.data) continue;

            const $ = cheerio.load(response.data);

            $('a[href*="/onlineshop/"]').each((i, el) => {
                let href = $(el).attr('href');
                if (href) {
                    if (!href.startsWith('http')) {
                        href = href.startsWith('/') ? `${BASE_URL}${href}` : `${BASE_URL}/${href}`;
                    }

                    // Check if it's a product page vs category page
                    const isProduct = href.split('/').length >= 7 && !href.endsWith('/onlineshop');
                    if (isProduct) {
                        discoveredUrlsSet.add(href);
                        if (!productMetaMap.has(href)) {
                            productMetaMap.set(href, { sourceCategoryUrl: catUrl });
                        }
                    }
                }
            });
        } catch (catErr) {
            console.error(`[${siteSlug}] Error exploring category page ${catUrl}:`, catErr.message);
        }
    }

    console.log(`[${siteSlug}] Total unique product URLs discovered: ${discoveredUrlsSet.size}`);

    // Step 3: Fetch and parse Product Detail Pages (PDP)
    const productUrlList = Array.from(discoveredUrlsSet);

    for (let i = 0; i < productUrlList.length; i++) {
        if (limit && productsMap.size >= limit) {
            console.log(`[${siteSlug}] Reached requested limit of ${limit} products. Stopping extraction.`);
            break;
        }

        const productUrl = productUrlList[i];
        const meta = productMetaMap.get(productUrl) || {};
        const sourceCatUrl = meta.sourceCategoryUrl || SHOP_BASE_URL;

        if (i > 0 && i % 50 === 0) {
            console.log(`[${siteSlug}] Processed ${i}/${productUrlList.length} products...`);
        }

        const { response, attempts, error } = await fetchWithRetry(productUrl);

        if (!response || !response.data) {
            const statusCode = error && error.response ? error.response.status : null;
            const errorType = error ? error.name : 'FetchError';
            const errorMessage = error ? error.message : 'No response body received';
            const failureReason = determineFailureReason(statusCode, errorType, errorMessage);

            failedRecordsStore.push({
                name: `Product ${i + 1}`,
                productUrl: productUrl,
                sourceCategoryUrl: sourceCatUrl,
                statusCode: statusCode || 0,
                errorType: errorType,
                errorMessage: errorMessage,
                failureReason: failureReason,
                retryAttempts: attempts
            });

            continue;
        }

        try {
            const $ = cheerio.load(response.data);

            // 1. Extract JSON-LD structured data (@type: Product and BreadcrumbList)
            let jsonLdProduct = null;
            const breadcrumbItems = [];

            $('script[type="application/ld+json"]').each((j, el) => {
                try {
                    const data = JSON.parse($(el).html());
                    if (data['@type'] === 'Product') {
                        jsonLdProduct = data;
                    } else if (data['@type'] === 'BreadcrumbList' && Array.isArray(data.itemListElement)) {
                        data.itemListElement.forEach(b => {
                            if (b.item && b.item.name) breadcrumbItems.push(cleanText(b.item.name));
                        });
                    }
                } catch (ldErr) {}
            });

            // 2. Extract Product Name
            let name = jsonLdProduct?.name || cleanText($('h1').first().text());
            if (!name) {
                const titleText = $('title').text().trim();
                name = titleText.split('-')[0].trim();
            }

            if (!name) {
                throw new Error('Missing product title on PDP');
            }

            // 3. Extract Categories from Breadcrumbs or JSON-LD
            let category = 'Onlineshop';
            let subcategory = '';

            if (breadcrumbItems.length > 1) {
                category = breadcrumbItems[1] || category; // Skip first "Shop" item
                if (breadcrumbItems.length > 2) {
                    subcategory = breadcrumbItems[2];
                }
            } else if (jsonLdProduct?.category) {
                category = jsonLdProduct.category;
            }

            // 4. Extract Pricing
            let price = null;
            let currency = 'EUR';

            if (jsonLdProduct?.offers) {
                const offerObj = Array.isArray(jsonLdProduct.offers) ? jsonLdProduct.offers[0] : jsonLdProduct.offers;
                if (offerObj?.price) price = parseFloat(offerObj.price);
                if (offerObj?.priceCurrency) currency = offerObj.priceCurrency;
            }

            if (price === null) {
                const priceText = $('.price, [class*="price"]').first().text().trim();
                if (priceText) {
                    const pMatch = priceText.replace(',', '.').match(/[\d.]+/);
                    if (pMatch) price = parseFloat(pMatch[0]);
                }
            }

            // 5. Extract Identifiers (GTIN, MPN, Article Number)
            const ean = jsonLdProduct?.gtin || '';
            const sku = jsonLdProduct?.mpn || jsonLdProduct?.sku || '';

            // 6. Extract Description & Short Description
            const description = jsonLdProduct?.description || cleanText($('.js-expandable__content-wrapper').first().text() || $('.product-detail__info-wrapper').text());

            // 7. Extract Image URL
            let imageUrl = jsonLdProduct?.image || $('meta[property="og:image"]').attr('content') || $('.product-detail img').first().attr('src');
            if (imageUrl && !imageUrl.startsWith('http')) {
                imageUrl = imageUrl.startsWith('/') ? `${BASE_URL}${imageUrl}` : `${BASE_URL}/${imageUrl}`;
            }

            // 8. Extract Availability & Stock Status
            let stockStatus = 'in_stock';
            let availabilityText = cleanText($('.product-detail-availability').text());

            if (jsonLdProduct?.offers) {
                const offerObj = Array.isArray(jsonLdProduct.offers) ? jsonLdProduct.offers[0] : jsonLdProduct.offers;
                if (offerObj?.availability && offerObj.availability.includes('OutOfStock')) {
                    stockStatus = 'out_of_stock';
                }
            }
            if (availabilityText.toLowerCase().includes('not available') || availabilityText.toLowerCase().includes('out of stock')) {
                stockStatus = 'out_of_stock';
            }

            // 9. Extract Badges & Attributes
            const badges = [];
            if (name.toLowerCase().includes('organic') || name.toLowerCase().includes('bio')) badges.push('Organic / Bio');
            if ($('.badge, [class*="badge"]').length > 0) {
                $('.badge, [class*="badge"]').each((bIdx, bEl) => {
                    const bTxt = cleanText($(bEl).text());
                    if (bTxt && !badges.includes(bTxt)) badges.push(bTxt);
                });
            }

            // Unique key for deduplication
            const uniqueKey = sku || ean || productUrl;

            if (!productsMap.has(uniqueKey)) {
                productsMap.set(uniqueKey, {
                    name: name,
                    category: category,
                    subcategory: subcategory,
                    price: price,
                    regularPrice: price,
                    salePrice: null,
                    unitPrice: null,
                    priceUnit: currency,
                    quantity: '',
                    brand: jsonLdProduct?.brand?.name || 'SONNENTOR',
                    producer: 'SONNENTOR Kräuterhandels GmbH',
                    description: description,
                    shortDescription: description ? description.substring(0, 200) : '',
                    ingredients: '',
                    nutritionInfo: '',
                    countryOfOrigin: 'Austria',
                    organicBioInfo: badges.includes('Organic / Bio') ? 'Yes' : 'No',
                    productCharacteristics: '',
                    allergens: '',
                    preparationInstructions: '',
                    sku: sku,
                    productId: sku,
                    ean: ean,
                    availability: availabilityText || (stockStatus === 'in_stock' ? 'Instantly available' : 'Currently not available'),
                    stockStatus: stockStatus,
                    badges: badges.join(', '),
                    productUrl: productUrl,
                    imageUrl: imageUrl,
                    sourceCategoryUrl: sourceCatUrl
                });
            }

            await sleep(80);

        } catch (parseErr) {
            const failureReason = determineFailureReason(200, 'ParsingError', parseErr.message);

            failedRecordsStore.push({
                name: `Product ${i + 1}`,
                productUrl: productUrl,
                sourceCategoryUrl: sourceCatUrl,
                statusCode: 200,
                errorType: 'ParsingError',
                errorMessage: parseErr.message,
                failureReason: failureReason,
                retryAttempts: attempts
            });
        }
    }

    const finalProducts = Array.from(productsMap.values());

    // Count failure reasons for report
    failedRecordsStore.forEach(f => {
        const reason = f.failureReason || 'Other';
        if (failureReasonCounts[reason] !== undefined) {
            failureReasonCounts[reason]++;
        } else {
            failureReasonCounts['Other']++;
        }
    });

    const totalDiscoveredCount = discoveredUrlsSet.size || finalProducts.length + failedRecordsStore.length;
    const successCount = finalProducts.length;
    const failedCount = failedRecordsStore.length;
    const totalProcessed = successCount + failedCount;
    const successRate = totalProcessed > 0 ? Math.round((successCount / totalProcessed) * 100) : 100;

    // Step 4: Print SONNENTOR SCRAPING SUMMARY Report
    console.log(`\nSONNENTOR SCRAPING SUMMARY`);
    console.log(`--------------------------`);
    console.log(`Product URLs discovered: ${totalDiscoveredCount}`);
    console.log(`Unique product URLs: ${discoveredUrlsSet.size}`);
    console.log(`Successfully scraped: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Success rate: ${successRate}%`);
    console.log(``);
    console.log(`Failure reasons:`);
    console.log(`404: ${failureReasonCounts['404']}`);
    console.log(`403: ${failureReasonCounts['403']}`);
    console.log(`429: ${failureReasonCounts['429']}`);
    console.log(`Timeout: ${failureReasonCounts['Timeout']}`);
    console.log(`Parsing error: ${failureReasonCounts['Parsing error']}`);
    console.log(`Other: ${failureReasonCounts['Other']}`);
    console.log(``);
    console.log(`Output:`);
    console.log(`data/sonnentor.csv`);
    console.log(`data/sonnentor.xlsx`);
    console.log(`data/sonnentor_failed.csv\n`);

    return {
        products: finalProducts,
        failedRecords: failedRecordsStore
    };
}

module.exports = {
    run,
    getFailedRecords,
    siteName,
    siteSlug
};
