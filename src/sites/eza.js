/**
 * Website Scraper Module for EZA Fairer Handel (https://shop.eza.cc)
 * 
 * Features & Architecture:
 * 1. Crawls the complete publicly accessible EZA online product shop at https://shop.eza.cc across all product categories:
 *    - Lebensmittel (/pg.php?pg=1)
 *      - Kaffeegenuss, Teegenuss, Kakao & Zucker, Schokolade, Snacks, Honig & Aufstriche, Gewürze, Saucen & Öle, Getreide & Körndl, Getränke & Spirituosen, Geschenkpakete, Werbemittel
 *    - Bio-Kosmetik (/pg.php?pg=4)
 *      - Biosfair
 *    - Fair Fashion (/pg.php?pg=5)
 *      - Anukoo, Veraluna
 *    - Fair & Handgemacht (/pg.php?pg=6)
 *      - Outdoor & Pflanzen, Wohnen & Dekoration, Küche & Tisch, Bad & Pflege, Körbe, Düfte, Räuchern & Klang, Schenken & Verpacken, Papier & Büro, Spiel & Sport, Musikinstrumente
 *    - Modeaccessoires (/pg.php?pg=7)
 *      - Tücher & Schals, Schmuck, Accessoires, Taschen
 * 2. Crawls category and subcategory listing pages (pg.php, wg.php, produkte.php) using pagesize=10000 parameter to discover all product URLs.
 * 3. Extracts extensive product metadata from product detail pages (artikel.php) and ingredient/nutritional data endpoints (zutaten.php):
 *    - Product Name, Category, Subcategory, Brand ("EZA Fairer Handel" / specific line)
 *    - Product URL, Image URL, Source Category URL
 *    - Price, Regular Price, Unit / Pack Quantity, Stock / Availability
 *    - Article Number / SKU, Ingredients, Nutritional Info, Fair Trade & Organic Certifications
 * 4. Deduplicates product records by unique Article Number (artnr) and Product URL.
 * 5. Failure tracking store & getFailedRecords() method logging failed URLs into data/eza_failed.csv.
 * 6. Exports successful items to data/eza.csv and data/eza.xlsx managed by orchestrator index.js.
 * 7. Prints formatted EZA SCRAPING SUMMARY at end of run execution.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { cleanText, sleep } = require('../utils');

// ─── Constants & Metadata ───────────────────────────────────────────────────

const siteName = 'EZA';
const siteSlug = 'eza';
const BASE_URL = 'https://shop.eza.cc';

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
};

const MAIN_CATEGORY_PAGES = [
    { name: 'Lebensmittel', pg: 1, url: `${BASE_URL}/pg.php?pg=1` },
    { name: 'Bio-Kosmetik', pg: 4, url: `${BASE_URL}/pg.php?pg=4` },
    { name: 'Fair Fashion', pg: 5, url: `${BASE_URL}/pg.php?pg=5` },
    { name: 'Fair & Handgemacht', pg: 6, url: `${BASE_URL}/pg.php?pg=6` },
    { name: 'Modeaccessoires', pg: 7, url: `${BASE_URL}/pg.php?pg=7` }
];

let failedRecordsStore = [];

/**
 * Returns failed records store for exporter
 */
function getFailedRecords() {
    return failedRecordsStore;
}

/**
 * Categorizes HTTP or parsing errors into standard failure reason strings
 */
function determineFailureReason(statusCode, errorType, errorMessage) {
    if (statusCode === 404) return '404';
    if (statusCode === 403) return '403';
    if (statusCode === 429) return '429';
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
                timeout: 12000
            });
            return { response, attempts, error: null };
        } catch (err) {
            lastError = err;
            const statusCode = err.response ? err.response.status : null;
            if (statusCode === 404) {
                // Don't retry 404 Not Found
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
 * Main scraper execution function for EZA
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
    const agUrlsMap = new Map(); // agUrl -> categoryName info

    const failureReasonCounts = {
        '404': 0,
        '403': 0,
        '429': 0,
        'Timeout': 0,
        'Parsing error': 0,
        'Other': 0
    };

    // Step 1: Discover category and product group listing URLs (produkte.php?pg=X&ag=Y)
    console.log(`[${siteSlug}] Discovering category and subcategory links from EZA shop...`);

    const navPagesToVisit = new Set();
    MAIN_CATEGORY_PAGES.forEach(c => navPagesToVisit.add(c.url));

    // Crawl main category pages to extract subcategory links (wg.php) and group links (produkte.php)
    for (const mainCat of MAIN_CATEGORY_PAGES) {
        try {
            const { response } = await fetchWithRetry(mainCat.url);
            if (!response || !response.data) continue;

            const $ = cheerio.load(response.data);

            $('a[href*="wg.php"]').each((i, el) => {
                let href = $(el).attr('href');
                if (href) {
                    if (!href.startsWith('http')) {
                        href = href.startsWith('/') ? `${BASE_URL}${href}` : `${BASE_URL}/${href}`;
                    }
                    navPagesToVisit.add(href);
                }
            });

            $('a[href*="produkte.php"]').each((i, el) => {
                let href = $(el).attr('href');
                const text = cleanText($(el).text());
                if (href) {
                    if (!href.startsWith('http')) {
                        href = href.startsWith('/') ? `${BASE_URL}${href}` : `${BASE_URL}/${href}`;
                    }
                    if (!agUrlsMap.has(href)) {
                        agUrlsMap.set(href, { category: mainCat.name, subcategory: text });
                    }
                }
            });
        } catch (e) {
            console.error(`[${siteSlug}] Error exploring main category ${mainCat.url}:`, e.message);
        }
    }

    // Explore secondary navigation pages (wg.php)
    for (const navUrl of navPagesToVisit) {
        if (navUrl.includes('pg.php')) continue; // Already crawled
        try {
            const { response } = await fetchWithRetry(navUrl);
            if (!response || !response.data) continue;

            const $ = cheerio.load(response.data);
            const parentCatName = $('#breadcrumbs a').eq(1).text().trim() || 'Sortiment';
            const subCatName = $('#breadcrumbs a').eq(2).text().trim() || '';

            $('a[href*="produkte.php"]').each((i, el) => {
                let href = $(el).attr('href');
                const text = cleanText($(el).text());
                if (href) {
                    if (!href.startsWith('http')) {
                        href = href.startsWith('/') ? `${BASE_URL}${href}` : `${BASE_URL}/${href}`;
                    }
                    if (!agUrlsMap.has(href)) {
                        agUrlsMap.set(href, { category: parentCatName, subcategory: text || subCatName });
                    }
                }
            });
        } catch (e) {
            console.error(`[${siteSlug}] Error exploring navigation subpage ${navUrl}:`, e.message);
        }
    }

    console.log(`[${siteSlug}] Discovered ${agUrlsMap.size} product group endpoints.`);

    // Step 2: Extract product detail URLs from product group listing pages
    const productUrlMetaMap = new Map(); // productUrl -> { artnr, category, subcategory, sourceCategoryUrl }

    for (const [agUrl, catMeta] of agUrlsMap.entries()) {
        if (limit && productUrlMetaMap.size >= limit * 2) break;

        // Append pagesize=10000 to retrieve all products for this group on 1 page
        const fullAgUrl = agUrl.includes('pagesize=') ? agUrl : `${agUrl}&pagesize=10000`;

        try {
            const { response, error } = await fetchWithRetry(fullAgUrl);
            if (!response || !response.data) {
                console.warn(`[${siteSlug}] Failed to fetch group listing ${fullAgUrl}: ${error ? error.message : 'No data'}`);
                continue;
            }

            const $ = cheerio.load(response.data);

            $('.beitrag-standard.beitrag-liste.artikelgruppe').each((i, el) => {
                const $card = $(el);
                const mehrHref = $card.find('.mehrlink a').attr('href') || $card.find('a[href*="artikel.php"]').attr('href');

                if (mehrHref && mehrHref.includes('artnr=')) {
                    let productUrl = mehrHref.startsWith('http')
                        ? mehrHref
                        : (mehrHref.startsWith('/') ? `${BASE_URL}${mehrHref}` : `${BASE_URL}/${mehrHref}`);

                    const artnrMatch = productUrl.match(/artnr=([0-9a-zA-Z_-]+)/);
                    const artnr = artnrMatch ? artnrMatch[1] : '';

                    discoveredUrlsSet.add(productUrl);

                    if (!productUrlMetaMap.has(productUrl)) {
                        // Extract inline listing data fallback
                        const listingTitle = cleanText($card.find('.beschreibung h2').text());
                        const listingPriceStr = $card.find('.beschreibung p strong').text();
                        let listingPrice = null;
                        if (listingPriceStr) {
                            const pMatch = listingPriceStr.replace(',', '.').match(/[\d.]+/);
                            if (pMatch) listingPrice = parseFloat(pMatch[0]);
                        }

                        productUrlMetaMap.set(productUrl, {
                            artnr,
                            category: catMeta.category,
                            subcategory: catMeta.subcategory,
                            sourceCategoryUrl: fullAgUrl,
                            listingTitle,
                            listingPrice
                        });
                    }
                }
            });

            await sleep(150);

        } catch (e) {
            console.error(`[${siteSlug}] Error fetching group page ${fullAgUrl}:`, e.message);
        }
    }

    console.log(`[${siteSlug}] Total product URLs discovered: ${discoveredUrlsSet.size}`);

    // Step 3: Fetch and parse Product Detail Pages (PDP) & Zutaten endpoints
    const productEntries = Array.from(productUrlMetaMap.entries());

    for (let i = 0; i < productEntries.length; i++) {
        if (limit && productsMap.size >= limit) {
            console.log(`[${siteSlug}] Reached requested limit of ${limit} products. Stopping extraction.`);
            break;
        }

        const [productUrl, meta] = productEntries[i];
        const artnr = meta.artnr;

        if (i > 0 && i % 50 === 0) {
            console.log(`[${siteSlug}] Processed ${i}/${productEntries.length} products...`);
        }

        const { response, attempts, error } = await fetchWithRetry(productUrl);

        if (!response || !response.data) {
            const statusCode = error && error.response ? error.response.status : null;
            const errorType = error ? error.name : 'FetchError';
            const errorMessage = error ? error.message : 'No response body received';
            const failureReason = determineFailureReason(statusCode, errorType, errorMessage);

            failedRecordsStore.push({
                name: meta.listingTitle || `Product ${artnr}`,
                productUrl: productUrl,
                sourceCategoryUrl: meta.sourceCategoryUrl,
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

            const title = cleanText($('.detailtext .beschreibung h1').text() || $('.beschreibung h2').text() || meta.listingTitle);
            if (!title) {
                throw new Error('Missing product title on PDP');
            }

            // Price parsing
            const priceText = $('.detailtext .beschreibung p strong').text() || `${meta.listingPrice || ''}`;
            let price = meta.listingPrice || null;
            if (priceText) {
                const pMatch = priceText.replace(',', '.').match(/[\d.]+/);
                if (pMatch) price = parseFloat(pMatch[0]);
            }

            // Image URL
            let imageUrl = '';
            const imgRel = $('.detailbild .grossbild img').attr('src') || $('.detailbild figure a').attr('href') || $('.detailbild img').first().attr('src');
            if (imgRel) {
                imageUrl = imgRel.startsWith('http')
                    ? imgRel
                    : (imgRel.startsWith('/') ? `${BASE_URL}${imgRel}` : `${BASE_URL}/${imgRel}`);
            }

            // Description
            const descLines = [];
            $('.js-faq-content ul.stwul li').each((j, el) => {
                const txt = cleanText($(el).text());
                if (txt) descLines.push(txt);
            });
            const description = descLines.length > 0 ? descLines.join('; ') : cleanText($('.js-faq-content').text());

            // Quantity & Stock
            const packSizeText = cleanText($('.bestellung .anzahl').text()); // e.g. "Menge: PKG"
            const logistikText = cleanText($('.logistik').text()); // e.g. "Großverpackung: 6 PKG Lagerbestand: 1532"
            
            let stockStatus = 'in_stock';
            const stockMatch = logistikText.match(/Lagerbestand:\s*(\d+)/i);
            if (stockMatch && parseInt(stockMatch[1], 10) === 0) {
                stockStatus = 'out_of_stock';
            }

            // Certifications / Badges
            const certifications = [];
            if ($('img[src*="logo-FT"], img[alt*="FT_Logo"]').length > 0) certifications.push('Fair Trade');
            if ($('img[src*="Organic"], img[alt*="EU_Organic"]').length > 0) certifications.push('BIO / Organic');

            // Category breadcrumbs fallback
            let category = meta.category;
            let subcategory = meta.subcategory;
            const breadcrumbs = [];
            $('#breadcrumbs a').each((bIdx, bEl) => {
                const bTxt = cleanText($(bEl).text());
                if (bTxt && bTxt !== 'Home') breadcrumbs.push(bTxt);
            });
            if (breadcrumbs.length > 0) {
                category = breadcrumbs[0] || category;
                if (breadcrumbs.length > 1) subcategory = breadcrumbs[1];
            }

            // Ingredients & Nutritional values from zutaten.php endpoint if available
            let ingredients = '';
            let nutritionInfo = '';

            if (artnr) {
                const zutatenUrl = `${BASE_URL}/zutaten.php?artnr=${artnr}`;
                try {
                    const zutResp = await axios.get(zutatenUrl, { headers: HTTP_HEADERS, timeout: 6000 });
                    if (zutResp && zutResp.data) {
                        const $z = cheerio.load(zutResp.data);
                        const ingParts = [];
                        const nutParts = [];

                        $z('#container_bestandteile table tr').each((rIdx, rEl) => {
                            const tds = $z(rEl).find('td').map((cIdx, cEl) => cleanText($z(cEl).text())).get();
                            if (tds.length >= 2) {
                                const type = tds[0];
                                const name = tds[1];
                                const val = tds[2] || '';

                                if (type.includes('Zutaten')) {
                                    ingParts.push(name);
                                } else if (type.includes('Nährwerte')) {
                                    nutParts.push(`${name}: ${val}`);
                                } else if (type.includes('Zusatzinfo') || type.includes('Spuren')) {
                                    if (val && val !== '0,00') {
                                        ingParts.push(`${name} (${val})`);
                                    } else {
                                        ingParts.push(name);
                                    }
                                }
                            }
                        });

                        if (ingParts.length > 0) ingredients = ingParts.join(', ');
                        if (nutParts.length > 0) nutritionInfo = nutParts.join('; ');
                    }
                } catch (zErr) {
                    // Non-fatal if zutaten page missing or fails
                }
            }

            const uniqueKey = artnr || productUrl;

            if (!productsMap.has(uniqueKey)) {
                productsMap.set(uniqueKey, {
                    name: title,
                    category: category,
                    subcategory: subcategory,
                    price: price,
                    regularPrice: price,
                    salePrice: null,
                    quantity: packSizeText || logistikText,
                    brand: 'EZA Fairer Handel',
                    description: description,
                    ingredients: ingredients,
                    nutritionInfo: nutritionInfo,
                    sku: artnr,
                    ean: artnr,
                    stockStatus: stockStatus,
                    certifications: certifications.join(', '),
                    productUrl: productUrl,
                    imageUrl: imageUrl,
                    sourceCategoryUrl: meta.sourceCategoryUrl
                });
            }

            await sleep(100);

        } catch (parseErr) {
            const failureReason = determineFailureReason(200, 'ParsingError', parseErr.message);

            failedRecordsStore.push({
                name: meta.listingTitle || `Product ${artnr}`,
                productUrl: productUrl,
                sourceCategoryUrl: meta.sourceCategoryUrl,
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

    // Step 4: Print EZA SCRAPING SUMMARY Report
    console.log(`\nEZA SCRAPING SUMMARY`);
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
    console.log(`data/eza.csv`);
    console.log(`data/eza.xlsx`);
    console.log(`data/eza_failed.csv\n`);

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
