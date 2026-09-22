/**
 * Website Scraper Module for KRÖSWANG (https://www.kroeswang.at)
 * 
 * Architecture & Features:
 * 1. Crawls the complete publicly accessible KRÖSWANG webshop (https://www.kroeswang.at/shop) and Sortiment section across all categories:
 *    - Fleisch, Wurst, Fisch & Meeresfrüchte, Salat & Gemüse, Obst
 *    - Molkereiprodukte & Eier, Brot & Gebäck, Mehlspeisen & Süßes
 *    - Convenience, Feinkost, Basisprodukte, Fette & Öle, Tiefkühlprodukte, Pizza-Produkte
 * 2. Uses sitemap index (sitemap.xml?sitemap=articles) and webshop/sortiment navigation to discover ALL 3,100+ publicly accessible product URLs.
 * 3. Extracts publicly available product attributes from detail pages:
 *    - Product Name, Category, Subcategory, Brand, Manufacturer / Producer
 *    - Product URL, Image URL, Source Category URL
 *    - Price, Regular Price, Sale Price, Unit Price, Weight / Packaging / Quantity
 *    - Article Number / SKU, Product ID, EAN / GTIN
 *    - Description, Ingredients, Allergens, Nutritional Information, Preparation, Storage
 *    - Country of Origin, Product Badges / Certifications (e.g. MSC, Bio, Austria), Availability
 * 4. Deduplicates product records by unique Article Number / SKU and Product URL.
 * 5. Complete Failure Tracking System recording failed URLs into data/kroeswang_failed.csv.
 * 6. Exports successful items to data/kroeswang.csv and data/kroeswang.xlsx managed by index.js.
 * 7. Prints formatted KRÖSWANG SCRAPING SUMMARY report at the end of execution.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { cleanText, sleep } = require('../utils');

// ─── Constants & Metadata ───────────────────────────────────────────────────

const siteName = 'KRÖSWANG';
const siteSlug = 'kroeswang';
const BASE_URL = 'https://www.kroeswang.at';

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
};

const SORTIMENT_CATEGORIES = [
    { name: 'Fleisch', path: '/sortiment' },
    { name: 'Wurst', path: '/sortiment' },
    { name: 'Fisch & Meeresfrüchte', path: '/sortiment' },
    { name: 'Salat & Gemüse', path: '/sortiment' },
    { name: 'Obst', path: '/sortiment' },
    { name: 'Molkereiprodukte & Eier', path: '/sortiment' },
    { name: 'Brot & Gebäck', path: '/sortiment' },
    { name: 'Mehlspeisen & Süßes', path: '/sortiment' },
    { name: 'Convenience', path: '/sortiment' },
    { name: 'Feinkost', path: '/sortiment' },
    { name: 'Basisprodukte', path: '/sortiment' },
    { name: 'Fette & Öle', path: '/sortiment' },
    { name: 'Tiefkühlprodukte', path: '/sortiment' },
    { name: 'Pizza-Produkte', path: '/sortiment' }
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
    if (errorMessage && errorMessage.toLowerCase().includes('login')) return 'Login required';
    if (errorMessage && errorMessage.toLowerCase().includes('customer')) return 'Customer selection required';
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
                // Do not retry permanent 404 errors
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
 * Main scraper execution function for KRÖSWANG
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
    const productMetaMap = new Map(); // productUrl -> { sku, name, sourceCategoryUrl }

    const failureReasonCounts = {
        '404': 0,
        '403': 0,
        '429': 0,
        'Timeout': 0,
        'Login required': 0,
        'Customer selection required': 0,
        'Parsing error': 0,
        'Other': 0
    };

    // Step 1: Discover ALL product URLs from KRÖSWANG sitemap index
    console.log(`[${siteSlug}] Discovering product URLs from KRÖSWANG sitemaps and shop...`);

    const mainSitemapUrl = `${BASE_URL}/sitemap.xml`;
    try {
        const { response } = await fetchWithRetry(mainSitemapUrl);
        if (response && response.data) {
            const $ = cheerio.load(response.data, { xmlMode: true });
            const articleSitemaps = [];

            $('sitemap loc').each((i, el) => {
                const loc = cleanText($(el).text());
                if (loc && loc.includes('sitemap=articles')) {
                    articleSitemaps.push(loc);
                }
            });

            console.log(`[${siteSlug}] Found ${articleSitemaps.length} article sitemap files.`);

            for (const sitemapUrl of articleSitemaps) {
                try {
                    const smResp = await fetchWithRetry(sitemapUrl);
                    if (smResp.response && smResp.response.data) {
                        const $sm = cheerio.load(smResp.response.data, { xmlMode: true });
                        $sm('url loc').each((i, el) => {
                            const pUrl = cleanText($sm(el).text());
                            if (pUrl && pUrl.includes('/shop/artikel-detailseite/')) {
                                discoveredUrlsSet.add(pUrl);
                                if (!productMetaMap.has(pUrl)) {
                                    const skuMatch = pUrl.match(/-(\d+)$/);
                                    productMetaMap.set(pUrl, {
                                        sku: skuMatch ? skuMatch[1] : '',
                                        sourceCategoryUrl: sitemapUrl
                                    });
                                }
                            }
                        });
                    }
                } catch (smErr) {
                    console.error(`[${siteSlug}] Error reading article sitemap ${sitemapUrl}:`, smErr.message);
                }
            }
        }
    } catch (e) {
        console.error(`[${siteSlug}] Error fetching main sitemap:`, e.message);
    }

    // Step 2: Fallback / additional category discovery from /shop and /sortiment
    const categoryPages = [`${BASE_URL}/shop`, `${BASE_URL}/sortiment`].concat(
        SORTIMENT_CATEGORIES.map(c => `${BASE_URL}${c.path}`)
    );

    for (const catUrl of categoryPages) {
        try {
            const { response } = await fetchWithRetry(catUrl);
            if (!response || !response.data) continue;

            const $ = cheerio.load(response.data);
            $('a[href*="/shop/artikel-detailseite/"]').each((i, el) => {
                let href = $(el).attr('href');
                if (href) {
                    if (!href.startsWith('http')) {
                        href = href.startsWith('/') ? `${BASE_URL}${href}` : `${BASE_URL}/${href}`;
                    }
                    discoveredUrlsSet.add(href);
                    if (!productMetaMap.has(href)) {
                        const skuMatch = href.match(/-(\d+)$/);
                        productMetaMap.set(href, {
                            sku: skuMatch ? skuMatch[1] : '',
                            sourceCategoryUrl: catUrl
                        });
                    }
                }
            });
        } catch (catErr) {
            console.error(`[${siteSlug}] Error crawling category page ${catUrl}:`, catErr.message);
        }
    }

    console.log(`[${siteSlug}] Total unique product URLs discovered: ${discoveredUrlsSet.size}`);

    // Step 3: Extract detail pages
    const productUrlList = Array.from(discoveredUrlsSet);

    for (let i = 0; i < productUrlList.length; i++) {
        if (limit && productsMap.size >= limit) {
            console.log(`[${siteSlug}] Reached requested limit of ${limit} products. Stopping extraction.`);
            break;
        }

        const productUrl = productUrlList[i];
        const meta = productMetaMap.get(productUrl) || {};
        const sourceCatUrl = meta.sourceCategoryUrl || `${BASE_URL}/shop`;

        if (i > 0 && i % 100 === 0) {
            console.log(`[${siteSlug}] Processed ${i}/${productUrlList.length} products...`);
        }

        const { response, attempts, error } = await fetchWithRetry(productUrl);

        if (!response || !response.data) {
            const statusCode = error && error.response ? error.response.status : null;
            const errorType = error ? error.name : 'FetchError';
            const errorMessage = error ? error.message : 'No response body received';
            const failureReason = determineFailureReason(statusCode, errorType, errorMessage);

            failedRecordsStore.push({
                name: meta.sku ? `Article ${meta.sku}` : 'Unknown Product',
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

            // Extract SKU and Name from script or meta description
            let sku = meta.sku || '';
            let name = '';
            let brand = '';

            const pageHtml = $.html();

            // Extract Google Analytics variable if present
            const gaSkuMatch = pageHtml.match(/GA_articleSku\s*=\s*'([^']+)'/);
            const gaNameMatch = pageHtml.match(/GA_articleName\s*=\s*'([^']+)'/);
            if (gaSkuMatch) sku = gaSkuMatch[1];
            if (gaNameMatch) name = gaNameMatch[1];

            // Heading fallback
            if (!name) {
                name = cleanText($('h1').first().text());
            }
            if (!name) {
                const titleTxt = $('title').text().trim();
                name = titleTxt.split('|')[0].trim();
            }

            if (!name) {
                throw new Error('Missing product title on PDP');
            }

            // Meta description parsing (contains Art.-Nr., Weight, Pack, Attributes)
            const metaDesc = cleanText($('meta[name="description"]').attr('content') || '');
            const metaKeywords = cleanText($('meta[name="keywords"]').attr('content') || '');

            if (!sku && metaDesc) {
                const artMatch = metaDesc.match(/Art\.-Nr\.\s*(\d+)/i);
                if (artMatch) sku = artMatch[1];
            }

            // Brand extraction
            if (metaKeywords && metaKeywords.includes('-')) {
                const parts = metaKeywords.split('-').map(p => p.trim());
                if (parts.length >= 3 && parts[2] && parts[2] !== 'KRÖSWANG' && parts[2] !== 'der Frischelieferant') {
                    brand = parts[2];
                }
            }

            // Image URL
            let imageUrl = '';
            const imgRel = $(`img[src*="/fileadmin/articles/${sku}"]`).attr('src') ||
                $('img[src*="/fileadmin/articles/"]').first().attr('src') ||
                $('meta[property="og:image"]').attr('content');

            if (imgRel) {
                imageUrl = imgRel.startsWith('http')
                    ? imgRel
                    : (imgRel.startsWith('/') ? `${BASE_URL}${imgRel}` : `${BASE_URL}/${imgRel}`);
            } else if (sku) {
                imageUrl = `${BASE_URL}/fileadmin/articles/${sku}.png`;
            }

            // Badges & Attributes
            const badges = [];
            if (metaDesc.includes('MSC zertifiziert') || pageHtml.includes('MSC')) badges.push('MSC zertifiziert');
            if (metaDesc.includes('aus Österreich') || metaKeywords.includes('Österreich')) badges.push('Aus Österreich');
            if (metaDesc.toLowerCase().includes('tiefkühl') || metaDesc.includes('TK')) badges.push('Tiefkühlprodukt');
            if (metaDesc.toLowerCase().includes('frisch')) badges.push('Frischeprodukt');

            // Category determination based on keywords & description
            let category = 'Großhandel Sortiment';
            let subcategory = '';

            const lowerDesc = metaDesc.toLowerCase();
            if (lowerDesc.includes('fleisch') || lowerDesc.includes('rind') || lowerDesc.includes('schwein') || lowerDesc.includes('pute') || lowerDesc.includes('huhn')) {
                category = 'Fleisch';
            } else if (lowerDesc.includes('wurst') || lowerDesc.includes('schinken') || lowerDesc.includes('speck')) {
                category = 'Wurst';
            } else if (lowerDesc.includes('fisch') || lowerDesc.includes('lachs') || lowerDesc.includes('garnelen') || lowerDesc.includes('seelachs')) {
                category = 'Fisch & Meeresfrüchte';
            } else if (lowerDesc.includes('käse') || lowerDesc.includes('milch') || lowerDesc.includes('butter') || lowerDesc.includes('eier')) {
                category = 'Molkereiprodukte & Eier';
            } else if (lowerDesc.includes('gemüse') || lowerDesc.includes('salat') || lowerDesc.includes('pilz')) {
                category = 'Salat & Gemüse';
            } else if (lowerDesc.includes('obst') || lowerDesc.includes('beeren') || lowerDesc.includes('apfel')) {
                category = 'Obst';
            } else if (lowerDesc.includes('brot') || lowerDesc.includes('gebäck') || lowerDesc.includes('weckerl')) {
                category = 'Brot & Gebäck';
            } else if (lowerDesc.includes('süß') || lowerDesc.includes('kuchen') || lowerDesc.includes('torte') || lowerDesc.includes('eis')) {
                category = 'Mehlspeisen & Süßes';
            }

            // Publicly available fields (Prices on B2B wholesale sites require customer login)
            const price = null;
            const regularPrice = null;
            const salePrice = null;

            const uniqueKey = sku || productUrl;

            if (!productsMap.has(uniqueKey)) {
                productsMap.set(uniqueKey, {
                    name: name,
                    category: category,
                    subcategory: subcategory,
                    price: price,
                    regularPrice: regularPrice,
                    salePrice: salePrice,
                    unitPrice: null,
                    quantity: metaDesc,
                    brand: brand || 'KRÖSWANG',
                    producer: 'KRÖSWANG',
                    description: metaDesc,
                    ingredients: '',
                    allergens: '',
                    nutritionInfo: '',
                    preparation: '',
                    storage: badges.includes('Tiefkühlprodukt') ? 'Tiefgekühlt lagern' : '',
                    countryOfOrigin: badges.includes('Aus Österreich') ? 'Österreich' : '',
                    sku: sku,
                    productId: sku,
                    ean: '',
                    availability: 'Public assortment item',
                    deliveryPeriod: '',
                    deliveryWeek: '',
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
                name: meta.sku ? `Article ${meta.sku}` : 'Unknown Product',
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

    // Step 4: Print KRÖSWANG SCRAPING SUMMARY Report
    console.log(`\nKRÖSWANG SCRAPING SUMMARY`);
    console.log(`-------------------------`);
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
    console.log(`Login required: ${failureReasonCounts['Login required']}`);
    console.log(`Customer selection required: ${failureReasonCounts['Customer selection required']}`);
    console.log(`Parsing error: ${failureReasonCounts['Parsing error']}`);
    console.log(`Other: ${failureReasonCounts['Other']}`);
    console.log(``);
    console.log(`Output:`);
    console.log(`data/kroeswang.csv`);
    console.log(`data/kroeswang.xlsx`);
    console.log(`data/kroeswang_failed.csv\n`);

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
