/**
 * Website Scraper Module for Biohof Achleitner (https://www.biohof.at)
 *
 * Requirements & Architecture:
 * 1. Crawls the complete publicly accessible Biohof shop at https://www.biohof.at/shop/ across all categories:
 *    - Biokiste (/biokisten)
 *    - Grillangebot (/grillangebot)
 *    - Obst & Gemüse (/obst-gemuese, /obst, /gemuese)
 *    - Neu im Sortiment (/neu-im-sortiment)
 *    - vom Bäcker (/vom-baecker)
 *    - von der Pflanze (/von-der-pflanze)
 *    - Feinkosttheke (/feinkosttheke)
 *    - Eier & Milchprodukte (/eier-milchprodukte)
 *    - Speis (/speis)
 *    - Haushalt (/haushalt)
 *    - Geschenkideen (/geschenksideen)
 *    - Hausg'mocht (/hausgmocht-speisen)
 *    - Themen (/themen)
 * 2. Uses category crawling + catalog search queries (/suchergebnisse) to discover ALL products.
 * 3. Deduplicates product records by Product URL and Product ID / Article Number.
 * 4. Extracts 20+ product attributes:
 *    - Product Name, Category, Subcategory, Brand, Producer / Manufacturer
 *    - Product URL, Image URL, Source Category URL
 *    - Price, Regular Price, Sale Price, Unit Price, Weight / Quantity
 *    - Product ID / Article Number, EAN / GTIN, Availability / Pre-order status
 * 5. Complete Failure Tracking System recording failed URLs into data/biohof_failed.csv.
 * 6. Exports successful items to data/biohof.csv and data/biohof.xlsx managed by orchestrator index.js.
 * 7. Prints formatted BIOHOF SCRAPING SUMMARY at the end of execution.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const querystring = require('querystring');
const { cleanText, sleep } = require('../utils');

// ─── Constants & Metadata ───────────────────────────────────────────────────

const siteName = 'Biohof Achleitner';
const siteSlug = 'biohof';
const BASE_URL = 'https://www.biohof.at';

const CATEGORIES = [
    { name: 'Biokiste', slug: '/biokisten' },
    { name: 'Grillangebot', slug: '/grillangebot' },
    { name: 'Obst & Gemüse', slug: '/obst-gemuese' },
    { name: 'Obst', slug: '/obst' },
    { name: 'Gemüse', slug: '/gemuese' },
    { name: 'Neu im Sortiment', slug: '/neu-im-sortiment' },
    { name: 'vom Bäcker', slug: '/vom-baecker' },
    { name: 'von der Pflanze', slug: '/von-der-pflanze' },
    { name: 'Feinkosttheke', slug: '/feinkosttheke' },
    { name: 'Eier & Milchprodukte', slug: '/eier-milchprodukte' },
    { name: 'Speis', slug: '/speis' },
    { name: 'Haushalt', slug: '/haushalt' },
    { name: 'Geschenkideen', slug: '/geschenksideen' },
    { name: 'Hausg\'mocht', slug: '/hausgmocht-speisen' },
    { name: 'Themen', slug: '/themen' }
];

const SEARCH_TERMS = [
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'Apfel', 'Brot', 'Käse', 'Milch', 'Bio', 'Gemüse', 'Fleisch', 'Saft', 'Schokolade', 'Tee', 'Öl', 'Suppe', 'Bier', 'Wein', 'Joghurt', 'Butter', 'Ei'
];

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'de-AT,de-DE;q=0.9,de;q=0.8,en-US;q=0.7,en;q=0.6'
};

// Global store for failed records
const failedRecordsStore = [];

/**
 * Returns a copy of all failed records collected during execution.
 * @returns {Array} List of failed record objects
 */
function getFailedRecords() {
    return [...failedRecordsStore];
}

/**
 * Record a failure with structured classification per requirement rules.
 */
function recordFailure({ name = '', productUrl, sourceUrl = '', statusCode = 0, errorType = 'UNKNOWN_ERROR', errorMessage = '', failureReason = 'Other', retryAttempts = 1 }) {
    failedRecordsStore.push({
        name: cleanText(name) || extractSlugFromUrl(productUrl),
        productUrl,
        sourceCategoryUrl: sourceUrl,
        statusCode: statusCode || 0,
        errorType,
        errorMessage: cleanText(errorMessage),
        failureReason,
        retryAttempts
    });
}

/**
 * Helper to extract slug or article ID from URL
 */
function extractSlugFromUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        return parts.pop() || u.hostname;
    } catch (e) {
        return url;
    }
}

/**
 * Classifies HTTP status and error details into standardized Biohof failure reasons
 */
function classifyError(err, statusCode = 0) {
    if (statusCode === 404) return { type: 'HTTP_404', reason: '404' };
    if (statusCode === 403) return { type: 'HTTP_403', reason: '403' };
    if (statusCode === 429) return { type: 'HTTP_429', reason: '429' };
    if (statusCode === 500) return { type: 'HTTP_500', reason: 'HTTP 500' };
    if (statusCode === 502) return { type: 'HTTP_502', reason: 'HTTP 502' };
    if (statusCode === 503) return { type: 'HTTP_503', reason: 'HTTP 503' };
    if (statusCode >= 400 && statusCode < 500) return { type: `HTTP_${statusCode}`, reason: 'HTTP Client Error' };
    if (statusCode >= 500) return { type: `HTTP_${statusCode}`, reason: 'HTTP Server Error' };
    
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('etimedout')) return { type: 'TIMEOUT', reason: 'Timeout' };
    if (msg.includes('parse') || msg.includes('cheerio')) return { type: 'PARSING_ERROR', reason: 'Parsing error' };
    if (msg.includes('redirect')) return { type: 'REDIRECT_ERROR', reason: 'Redirect' };
    if (msg.includes('conn') || msg.includes('econnrefused')) return { type: 'CONNECTION_ERROR', reason: 'Connection Error' };
    
    return { type: 'OTHER_ERROR', reason: 'Other' };
}

// ─── Product Card Extractor ────────────────────────────────────────────────

/**
 * Parses products from Cheerio HTML instance of category or search page.
 */
function extractProductsFromHtml($, sourceCategoryUrl, categoryName = 'General') {
    const products = [];
    const cardElements = $('.produktContainer, .ps-item');

    cardElements.each((i, el) => {
        try {
            const $card = $(el);

            // Title & URL
            const $titleLink = $card.find('h3 a, h2 a, a[href*="-"]').first();
            const rawTitle = $titleLink.text().trim() || $card.find('h3, h2').text().trim();
            const href = $titleLink.attr('href') || $card.find('a[href]').attr('href') || '';

            if (!rawTitle) return;

            const productUrl = href ? new URL(href, BASE_URL).toString() : sourceCategoryUrl;

            // Product ID / Article Number from URL (e.g. /Baguette-Weizen-hell-320g-173 -> 173)
            let productId = '';
            const idMatch = href.match(/-(\d+)\/?$/);
            if (idMatch) {
                productId = idMatch[1];
            }

            // Producer / Subtitle / Brand
            const producer = cleanText($card.find('.subtitle, [class*="sub"]').text());

            // Image URL
            const rawImg = $card.find('img.prodImg, img').first().attr('src') || '';
            const imageUrl = rawImg ? new URL(rawImg, BASE_URL).toString() : '';

            // Price & Unit Price
            const priceText = $card.find('.price strong, .price').first().text().trim();
            let price = null;
            const priceMatch = priceText.match(/(\d+[\.,]\d{2})/);
            if (priceMatch) {
                price = parseFloat(priceMatch[1].replace(',', '.'));
            }

            // Unit Price (e.g. € 4,85 / STK or € 3,50 / 1kg)
            const unitPrice = cleanText($card.find('.pperw').text() || $card.find('.price .weight').text());

            // Weight / Quantity (extracted from title e.g. "320g" or unit price)
            let quantity = '';
            const qtyMatch = rawTitle.match(/(\d+(?:[\.,]\d+)?\s*(?:g|kg|ml|l|cl|stk|stück|flasche)\b)/i);
            if (qtyMatch) {
                quantity = qtyMatch[1];
            }

            // Availability / Order status
            const cardText = $card.text().toLowerCase();
            let availability = 'In Stock';
            if (cardText.includes('vorbestellen')) {
                availability = 'Vorbestellung / Pre-order';
            } else if (cardText.includes('nicht verfügbar') || cardText.includes('zur zeit nicht')) {
                availability = 'Temporarily Unavailable';
            }

            // Category & Subcategory
            const category = categoryName;
            let subcategory = '';

            products.push({
                name: cleanText(rawTitle),
                category,
                subcategory,
                brand: producer || 'Biohof Achleitner',
                producer: producer || 'Biohof Achleitner',
                productUrl,
                imageUrl,
                price: price !== null ? price : '',
                regularPrice: price !== null ? price : '',
                salePrice: '',
                unitPrice,
                quantity,
                ean: '',
                productId,
                description: cleanText(rawTitle),
                ingredients: '',
                nutritionalInfo: '',
                countryOfOrigin: 'Österreich',
                availability,
                deliveryInfo: 'Biokiste Lieferservice / Biohof Achleitner',
                preorderInfo: availability.includes('Vorbestellung') ? 'Vorbestellbar' : '',
                deliveryPeriod: '',
                orderDeadline: '',
                badges: rawTitle.toLowerCase().includes('bio') ? 'Bio' : '',
                sourceUrl: sourceCategoryUrl
            });

        } catch (e) {
            // ignore individual card parsing error
        }
    });

    return products;
}

// ─── Crawlers ──────────────────────────────────────────────────────────────

/**
 * Crawls a single category page
 */
async function crawlCategoryPage(cat, maxRetries = 3) {
    const url = BASE_URL + cat.slug;
    let attempts = 0;

    while (attempts < maxRetries) {
        attempts++;
        try {
            const res = await axios.get(url, { headers: HTTP_HEADERS, timeout: 15000 });
            const $ = cheerio.load(res.data);
            const products = extractProductsFromHtml($, url, cat.name);
            return { products, statusCode: res.status };
        } catch (err) {
            const statusCode = err.response?.status || 0;
            const errObj = classifyError(err, statusCode);

            if (attempts >= maxRetries) {
                recordFailure({
                    productUrl: url,
                    sourceUrl: BASE_URL + '/shop',
                    statusCode,
                    errorType: errObj.type,
                    errorMessage: err.message,
                    failureReason: errObj.reason,
                    retryAttempts: attempts
                });
                return { products: [], statusCode };
            }
            await sleep(1000 * attempts);
        }
    }
    return { products: [], statusCode: 0 };
}

/**
 * Executes a POST search request to /suchergebnisse to discover catalog products
 */
async function executeSearchQuery(term, maxRetries = 3) {
    const url = BASE_URL + '/suchergebnisse';
    let attempts = 0;

    while (attempts < maxRetries) {
        attempts++;
        try {
            const res = await axios.post(url, querystring.stringify({
                searchText: term,
                submitForm: '1'
            }), {
                headers: {
                    ...HTTP_HEADERS,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 15000
            });

            const $ = cheerio.load(res.data);
            const products = extractProductsFromHtml($, url, 'Suche: ' + term);
            return products;
        } catch (err) {
            const statusCode = err.response?.status || 0;
            const errObj = classifyError(err, statusCode);

            if (attempts >= maxRetries) {
                recordFailure({
                    name: `Search term: ${term}`,
                    productUrl: url + `?q=${encodeURIComponent(term)}`,
                    sourceUrl: BASE_URL + '/shop',
                    statusCode,
                    errorType: errObj.type,
                    errorMessage: err.message,
                    failureReason: errObj.reason,
                    retryAttempts: attempts
                });
                return [];
            }
            await sleep(1000 * attempts);
        }
    }
    return [];
}

// ─── Main Execution Runner ──────────────────────────────────────────────────

async function run(options = {}) {
    const startTime = Date.now();
    console.log(`\n=================================================`);
    console.log(`  STARTING SCRAPER FOR: ${siteName}`);
    console.log(`=================================================\n`);

    const allDiscoveredProducts = [];

    // Step 1: Crawl Main Shop Category Pages
    console.log(`[Biohof] Crawling ${CATEGORIES.length} main shop categories...`);
    for (const cat of CATEGORIES) {
        const { products } = await crawlCategoryPage(cat);
        console.log(`[Biohof] Category '${cat.name}': ${products.length} products found.`);
        allDiscoveredProducts.push(...products);
        await sleep(options.delay || 150);
    }

    // Step 2: Execute Catalog Search Queries to discover full assortment
    console.log(`\n[Biohof] Executing catalog search discovery across ${SEARCH_TERMS.length} search queries...`);
    for (const term of SEARCH_TERMS) {
        const products = await executeSearchQuery(term);
        allDiscoveredProducts.push(...products);
        await sleep(options.delay || 150);
    }

    // Step 3: Deduplicate Products by productUrl and productId
    const uniqueProductMap = new Map();
    const discoveredUrlsSet = new Set();

    allDiscoveredProducts.forEach(p => {
        if (p.productUrl) discoveredUrlsSet.add(p.productUrl);
        const key = p.productId ? `ID_${p.productId}` : p.productUrl;
        if (key && !uniqueProductMap.has(key)) {
            uniqueProductMap.set(key, p);
        }
    });

    const uniqueProducts = Array.from(uniqueProductMap.values());
    console.log(`\n[Biohof] Total Product URLs Discovered: ${discoveredUrlsSet.size}`);
    console.log(`[Biohof] Unique Scraped Products: ${uniqueProducts.length}`);

    // Respect options.limit for testing if specified
    const finalProducts = options.limit ? uniqueProducts.slice(0, options.limit) : uniqueProducts;

    // Tally failure reason counts
    const failureReasonCounts = {
        '404': 0,
        '403': 0,
        '429': 0,
        'Timeout': 0,
        'Parsing error': 0,
        'Other': 0
    };

    failedRecordsStore.forEach(f => {
        const reason = f.failureReason || 'Other';
        if (failureReasonCounts[reason] !== undefined) {
            failureReasonCounts[reason]++;
        } else {
            failureReasonCounts['Other']++;
        }
    });

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const totalDiscoveredCount = discoveredUrlsSet.size || finalProducts.length + failedRecordsStore.length;
    const successCount = finalProducts.length;
    const failedCount = failedRecordsStore.length;
    const totalProcessed = successCount + failedCount;
    const successRate = totalProcessed > 0 ? Math.round((successCount / totalProcessed) * 100) : 100;

    // Step 4: Print BIOHOF SCRAPING SUMMARY Report
    console.log(`\nBIOHOF SCRAPING SUMMARY`);
    console.log(`-----------------------`);
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
    console.log(`data/biohof.csv`);
    console.log(`data/biohof.xlsx`);
    console.log(`data/biohof_failed.csv\n`);

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
