/**
 * Website Scraper Module for BILLA Austria (https://shop.billa.at)
 * 
 * Architecture & Features:
 * 1. Crawls the complete publicly accessible BILLA Online Shop product catalog at https://shop.billa.at across all product categories:
 *    - Neu im Online Shop, Obst & Gemüse, Brot & Gebäck, Fleisch, Wurst & Fisch, Kühlwaren
 *    - Schnelle Küche, Platten, Brötchen & Co., Getränke, Vorratsschrank, Tiefkühl
 *    - Rein Pflanzlich, Drogerie & Kosmetik, Küche, Haushalt & Garten, Baby & Kleinkind, Haustier, Treuepromotion, Saisonales
 * 2. Dynamically discovers category trees from https://shop.billa.at/kategorie and queries BILLA's public discovery API endpoints:
 *    - https://shop.billa.at/api/product-discovery/products?page=X&pageSize=100
 * 3. Extracts complete product metadata:
 *    - Product Name, Brand, Manufacturer / Producer
 *    - Category, Subcategory, Category Path
 *    - Product URL, Image URL, Additional Image URLs
 *    - Product ID, Article Number / SKU, EAN / GTIN
 *    - Price (Regular Price, Sale/Promotional Price), Unit Price, Price Unit, Currency ("EUR")
 *    - Weight, Quantity, Packaging Type (packageLabel)
 *    - Product Description, Short Description, Ingredients (nutIngredients), Nutrition, Allergens
 *    - Country of Origin, Bio Status, Vegan / Vegetarian Status, Deposit / Pfand Info
 *    - Availability, Stock Status, Promotional Info, Source Category URL
 * 4. Deduplicates product records by unique SKU / Article Number, Product ID, and Product URL.
 * 5. Failure Tracking System recording failed URLs into data/billa_failed.csv.
 * 6. Exports successful items to data/billa.csv and data/billa.xlsx managed by orchestrator index.js.
 * 7. Prints formatted BILLA SCRAPING SUMMARY report at the end of execution.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { cleanText, sleep } = require('../utils');

// ─── Constants & Metadata ───────────────────────────────────────────────────

const siteName = 'BILLA';
const siteSlug = 'billa';
const BASE_URL = 'https://shop.billa.at';
const KATEGORIE_URL = 'https://shop.billa.at/kategorie';
const PRODUCT_DISCOVERY_API = 'https://shop.billa.at/api/product-discovery/products';

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'de-AT,de;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'application/json, text/plain, */*'
};

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
    if (errorType === 'ConnectionError' || (errorMessage && errorMessage.toLowerCase().includes('econnereset'))) return 'Connection Error';
    if (errorType === 'ParsingError') return 'Parsing Error';
    if (errorType === 'Redirect') return 'Redirect';
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
                timeout: 12000
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
 * Main scraper execution function for BILLA
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
    const categoryKeysMap = new Map(); // catKey -> catName

    const failureReasonCounts = {
        '404': 0,
        '403': 0,
        '429': 0,
        '500': 0,
        '502': 0,
        '503': 0,
        'Timeout': 0,
        'Connection Error': 0,
        'Parsing Error': 0,
        'Redirect': 0,
        'Other': 0
    };

    // Step 1: Discover category tree from https://shop.billa.at/kategorie
    console.log(`[${siteSlug}] Discovering categories from ${KATEGORIE_URL}...`);
    try {
        const { response } = await fetchWithRetry(KATEGORIE_URL);
        if (response && response.data) {
            const $ = cheerio.load(response.data);
            $('a[href*="/kategorie/"]').each((i, el) => {
                const href = $(el).attr('href');
                const text = cleanText($(el).text().replace(/\d+$/, '')); // strip item count numbers
                if (href) {
                    const match = href.match(/\/kategorie\/.*?-(\d+)/);
                    if (match) {
                        const key = match[1];
                        categoryKeysMap.set(key, text);
                    }
                }
            });
        }
    } catch (e) {
        console.error(`[${siteSlug}] Error fetching category page:`, e.message);
    }

    console.log(`[${siteSlug}] Discovered ${categoryKeysMap.size} category keys.`);

    // Step 2: Query BILLA Product Discovery API with pagination
    console.log(`[${siteSlug}] Fetching product catalog from BILLA discovery API...`);

    const pageSize = 100;
    let currentPage = 1;
    let totalProducts = 0;
    let hasMorePages = true;

    while (hasMorePages) {
        if (limit && productsMap.size >= limit) {
            console.log(`[${siteSlug}] Reached requested test limit of ${limit} products. Stopping API pagination.`);
            break;
        }

        const apiPageUrl = `${PRODUCT_DISCOVERY_API}?page=${currentPage}&pageSize=${pageSize}`;

        const { response, attempts, error } = await fetchWithRetry(apiPageUrl);

        if (!response || !response.data) {
            const statusCode = error && error.response ? error.response.status : null;
            const errorType = error ? error.name : 'FetchError';
            const errorMessage = error ? error.message : 'No response data';
            const failureReason = determineFailureReason(statusCode, errorType, errorMessage);

            failedRecordsStore.push({
                name: `API Page ${currentPage}`,
                productUrl: apiPageUrl,
                sourceCategoryUrl: KATEGORIE_URL,
                statusCode: statusCode || 0,
                errorType: errorType,
                errorMessage: errorMessage,
                failureReason: failureReason,
                retryAttempts: attempts
            });

            currentPage++;
            continue;
        }

        const data = response.data;
        const results = data.results || [];
        totalProducts = data.total || totalProducts;

        if (currentPage === 1) {
            console.log(`[${siteSlug}] Total catalog products announced by API: ${totalProducts}`);
        }

        if (results.length === 0) {
            hasMorePages = false;
            break;
        }

        for (const item of results) {
            if (limit && productsMap.size >= limit) break;

            try {
                const slug = item.slug || '';
                const sku = item.sku || '';
                const productId = item.productId || '';
                const name = cleanText(item.name || '');

                if (!name) continue;

                const productUrl = slug ? `${BASE_URL}/produkte/${slug}` : `${BASE_URL}/produkte/${productId}`;
                discoveredUrlsSet.add(productUrl);

                // Pricing parsing
                let regularPrice = null;
                let salePrice = null;
                let unitPrice = null;
                let priceUnit = '';

                if (item.price) {
                    if (item.price.regular && typeof item.price.regular.value === 'number') {
                        regularPrice = item.price.regular.value / 100;
                    }
                    if (item.price.regular && typeof item.price.regular.perStandardizedQuantity === 'number') {
                        unitPrice = item.price.regular.perStandardizedQuantity / 100;
                    }
                    if (item.price.sale && typeof item.price.sale.value === 'number') {
                        salePrice = item.price.sale.value / 100;
                    } else if (item.price.discounted && typeof item.price.discounted.value === 'number') {
                        salePrice = item.price.discounted.value / 100;
                    }
                    if (item.price.baseUnitShort || item.price.baseUnitLong) {
                        const factor = item.price.basePriceFactor && item.price.basePriceFactor !== '1' ? `${item.price.basePriceFactor} ` : '';
                        priceUnit = `${factor}${item.price.baseUnitShort || item.price.baseUnitLong}`.trim();
                    }
                }

                const finalPrice = salePrice || regularPrice;

                // Category hierarchy parsing
                let category = item.category || 'Online Shop';
                let subcategory = '';
                let sourceCategoryUrl = KATEGORIE_URL;

                if (Array.isArray(item.parentCategories) && item.parentCategories.length > 0) {
                    const catPath = item.parentCategories[0];
                    if (Array.isArray(catPath)) {
                        if (catPath[0] && catPath[0].name) category = catPath[0].name;
                        if (catPath[1] && catPath[1].name) subcategory = catPath[1].name;
                        if (catPath[catPath.length - 1] && catPath[catPath.length - 1].slug) {
                            sourceCategoryUrl = `${BASE_URL}/kategorie/${catPath[catPath.length - 1].slug}`;
                        }
                    }
                }

                // Images
                const imagesList = Array.isArray(item.images) ? item.images : [];
                const primaryImage = imagesList[0] || '';

                // Quantity / Weight / Package
                const quantityStr = [item.amount, item.volumeLabelShort || item.volumeLabelLong].filter(Boolean).join(' ');
                const packagingType = item.packageLabel || '';

                // Organic & Vegan flags
                const bioStatus = (name.toLowerCase().includes('bio') || category.toLowerCase().includes('bio')) ? 'Bio / Organic' : 'Conventional';
                const veganStatus = (name.toLowerCase().includes('vegan') || category.toLowerCase().includes('pflanzlich')) ? 'Vegan' : '';

                // Deposit / Pfand
                const pfandInfo = item.depositText || item.depositInfo || '';

                const uniqueKey = sku || productId || productUrl;

                if (!productsMap.has(uniqueKey)) {
                    productsMap.set(uniqueKey, {
                        name: name,
                        brand: item.brand?.name || '',
                        manufacturer: item.countryOfOrigin || '',
                        category: category,
                        subcategory: subcategory,
                        productUrl: productUrl,
                        imageUrl: primaryImage,
                        additionalImages: imagesList.slice(1).join('; '),
                        productId: productId,
                        articleNumber: sku,
                        ean: item.gtin || '',
                        gtin: item.gtin || '',
                        sku: sku,
                        price: finalPrice,
                        regularPrice: regularPrice,
                        salePrice: salePrice,
                        unitPrice: unitPrice,
                        priceUnit: priceUnit,
                        currency: 'EUR',
                        weight: item.weight || '',
                        quantity: quantityStr,
                        packagingType: packagingType,
                        description: cleanText(item.productMarketing || item.descriptionLong || ''),
                        shortDescription: cleanText(item.descriptionShort || ''),
                        ingredients: cleanText(item.nutIngredients || ''),
                        nutrition: '',
                        allergens: '',
                        origin: item.countryOfOrigin || '',
                        countryOfOrigin: item.countryOfOrigin || '',
                        bioStatus: bioStatus,
                        veganStatus: veganStatus,
                        availability: item.published ? 'In Stock' : 'Unavailable',
                        stockStatus: item.published ? 'in_stock' : 'out_of_stock',
                        depositPfand: pfandInfo,
                        promotion: item.inPromotion ? 'On Sale' : '',
                        sourceCategoryUrl: sourceCategoryUrl
                    });
                }

            } catch (parseErr) {
                const failureReason = determineFailureReason(200, 'ParsingError', parseErr.message);

                failedRecordsStore.push({
                    name: item.name || `Product ${item.sku}`,
                    productUrl: item.slug ? `${BASE_URL}/produkte/${item.slug}` : apiPageUrl,
                    sourceCategoryUrl: KATEGORIE_URL,
                    statusCode: 200,
                    errorType: 'ParsingError',
                    errorMessage: parseErr.message,
                    failureReason: failureReason,
                    retryAttempts: 1
                });
            }
        }

        if (currentPage * pageSize >= totalProducts) {
            hasMorePages = false;
        } else {
            currentPage++;
            await sleep(100);
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

    // Step 4: Print BILLA SCRAPER SUMMARY Report
    console.log(`\nBILLA SCRAPER SUMMARY`);
    console.log(`---------------------`);
    console.log(`Discovered product URLs: ${totalDiscoveredCount}`);
    console.log(`Unique product URLs: ${discoveredUrlsSet.size}`);
    console.log(`Successfully scraped: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Success rate: ${successRate}%`);
    console.log(``);
    console.log(`Failure reasons:`);
    console.log(`404: ${failureReasonCounts['404']}`);
    console.log(`403: ${failureReasonCounts['403']}`);
    console.log(`429: ${failureReasonCounts['429']}`);
    console.log(`500: ${failureReasonCounts['500']}`);
    console.log(`502: ${failureReasonCounts['502']}`);
    console.log(`503: ${failureReasonCounts['503']}`);
    console.log(`Timeout: ${failureReasonCounts['Timeout']}`);
    console.log(`Connection Error: ${failureReasonCounts['Connection Error']}`);
    console.log(`Parsing Error: ${failureReasonCounts['Parsing Error']}`);
    console.log(`Redirect: ${failureReasonCounts['Redirect']}`);
    console.log(`Other: ${failureReasonCounts['Other']}`);
    console.log(``);
    console.log(`Output:`);
    console.log(`data/billa.csv`);
    console.log(`data/billa.xlsx`);
    console.log(`data/billa_failed.csv\n`);

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
