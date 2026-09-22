/**
 * Website Scraper Module for MPREIS (https://www.mpreis.at)
 * 
 * Features:
 * - Crawls https://www.mpreis.at across all main product categories & subcategories:
 *   - Lebensmittel
 *   - Getränke
 *   - Drogerie
 *   - Obst
 *   - Gemüse
 *   - Milch & Eier
 *   - Fleisch & Wurst
 *   - Tiefkühl
 *   - Süßes & Salziges
 *   - Brot & Gebäck
 *   - Grundnahrung
 *   - To-Go
 *   - Fisch
 *   - Haushalt
 *   - Baby
 *   - Haustiere
 *   - Pflege
 *   - Wasch- & Putzmittel
 *   - Brand pages and subcategories discovered during crawling
 * - Complete pagination & load-more handling
 * - Multi-layer extraction from JSON-LD (@type: Product), embedded JSON, DOM elements
 * - 24 Product attributes extracted:
 *   - Product Name
 *   - Category
 *   - Subcategory
 *   - Brand
 *   - Manufacturer
 *   - Product URL
 *   - Image URL
 *   - Product Description
 *   - Price
 *   - Regular Price
 *   - Sale Price
 *   - Unit Price
 *   - Weight / Quantity
 *   - EAN / GTIN
 *   - Product ID / Article Number
 *   - Ingredients
 *   - Nutritional Information
 *   - Country of Origin
 *   - Availability
 *   - Store Availability
 *   - Online Availability
 *   - Product Badges
 *   - Source Category URL
 *   - Source Brand URL
 * - Complete Failure Tracking System:
 *   - Retries temporary failures up to 3 times
 *   - Records every failed URL in data/mpreis_failed.csv with classified reason
 * - Exports successful products to data/mpreis.csv and data/mpreis.xlsx
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { cleanText, sleep } = require('../utils');

// Optional stealth browser support if available
let puppeteer = null;
try {
    const pExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    pExtra.use(StealthPlugin());
    puppeteer = pExtra;
} catch (e) {
    try {
        puppeteer = require('puppeteer');
    } catch (err) {
        puppeteer = null;
    }
}

const siteName = 'MPREIS Austria';
const siteSlug = 'mpreis';
const BASE_URL = 'https://www.mpreis.at';

// Standard HTTP headers to emulate modern browser requests
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'de-AT,de-DE;q=0.9,de;q=0.8,en-US;q=0.7,en;q=0.6',
    'Cache-Control': 'no-cache'
};

// Seed categories as per requirements
const SEED_CATEGORIES = [
    { name: 'Lebensmittel', url: 'https://www.mpreis.at/shop/c/lebensmittel-c1' },
    { name: 'Getränke', url: 'https://www.mpreis.at/shop/c/getraenke-c2' },
    { name: 'Drogerie', url: 'https://www.mpreis.at/shop/c/drogerie-c3' },
    { name: 'Obst', url: 'https://www.mpreis.at/shop/c/obst-c4' },
    { name: 'Gemüse', url: 'https://www.mpreis.at/shop/c/gemuese-c5' },
    { name: 'Milch & Eier', url: 'https://www.mpreis.at/shop/c/milch-eier-c6' },
    { name: 'Fleisch & Wurst', url: 'https://www.mpreis.at/shop/c/fleisch-wurst-c7' },
    { name: 'Tiefkühl', url: 'https://www.mpreis.at/shop/c/tiefkuehl-c8' },
    { name: 'Süßes & Salziges', url: 'https://www.mpreis.at/shop/c/suesses-salziges-c9' },
    { name: 'Brot & Gebäck', url: 'https://www.mpreis.at/shop/c/brot-gebaeck-c10' },
    { name: 'Grundnahrung', url: 'https://www.mpreis.at/shop/c/grundnahrung-c11' },
    { name: 'To-Go', url: 'https://www.mpreis.at/shop/c/to-go-c12' },
    { name: 'Fisch', url: 'https://www.mpreis.at/shop/c/fisch-c13' },
    { name: 'Haushalt', url: 'https://www.mpreis.at/shop/c/haushalt-c14' },
    { name: 'Baby', url: 'https://www.mpreis.at/shop/c/baby-c15' },
    { name: 'Haustiere', url: 'https://www.mpreis.at/shop/c/haustiere-c16' },
    { name: 'Pflege', url: 'https://www.mpreis.at/shop/c/pflege-c17' },
    { name: 'Wasch- & Putzmittel', url: 'https://www.mpreis.at/shop/c/wasch-putzmittel-c18' }
];

// Global array tracking all failure records for mpreis_failed.csv export
const failedRecordsStore = [];

/**
 * Returns copy of all failed records collected during scrape execution
 */
function getFailedRecords() {
    return [...failedRecordsStore];
}

/**
 * Decodes HTML numeric and named entities in string values
 */
function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&auml;/g, 'ä')
        .replace(/&Auml;/g, 'Ä')
        .replace(/&ouml;/g, 'ö')
        .replace(/&Ouml;/g, 'Ö')
        .replace(/&uuml;/g, 'ü')
        .replace(/&Uuml;/g, 'Ü')
        .replace(/&szlig;/g, 'ß')
        .replace(/&eacute;/g, 'é')
        .replace(/&egrave;/g, 'è')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code))
        .trim();
}

/**
 * Normalizes relative or absolute URLs into canonical mpreis.at URLs
 */
function normalizeUrl(urlStr) {
    if (!urlStr) return '';
    let clean = urlStr.trim();
    if (clean.startsWith('//')) {
        return 'https:' + clean;
    }
    if (clean.startsWith('/')) {
        return BASE_URL + clean;
    }
    return clean;
}

/**
 * Launches stealth browser instance to fetch HTML content if HTTP request encounters block
 */
async function fetchWithBrowser(targetUrl, browserInstance = null) {
    let localBrowser = false;
    let browser = browserInstance;

    try {
        if (!browser && puppeteer) {
            localBrowser = true;
            const launchOptions = {
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--enable-unsafe-swiftshader'
                ]
            };
            const fs = require('fs');
            if (fs.existsSync('/usr/bin/google-chrome')) {
                launchOptions.executablePath = '/usr/bin/google-chrome';
            }
            browser = await puppeteer.launch(launchOptions);
        }

        if (!browser) return null;

        const page = await browser.newPage();
        await page.setUserAgent(HTTP_HEADERS['User-Agent']);
        await page.setExtraHTTPHeaders({
            'Accept-Language': HTTP_HEADERS['Accept-Language']
        });

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));

        const html = await page.content();
        await page.close();

        if (localBrowser) {
            await browser.close();
        }

        return html;
    } catch (err) {
        if (localBrowser && browser) {
            try { await browser.close(); } catch (e) {}
        }
        return null;
    }
}

/**
 * Crawls landing page to discover category, subcategory, and brand links
 */
async function discoverCategories(browser = null) {
    console.log(`[${siteSlug}] Discovering category, subcategory, and brand links from ${BASE_URL}...`);
    const categoryMap = new Map();

    for (const seed of SEED_CATEGORIES) {
        categoryMap.set(seed.url, seed.name);
    }

    let html = null;
    try {
        const res = await axios.get(BASE_URL, {
            headers: HTTP_HEADERS,
            timeout: 15000
        });
        html = res.data;
    } catch (err) {
        html = await fetchWithBrowser(BASE_URL, browser);
    }

    if (html) {
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            const title = cleanText($(el).text());
            if (!href || !title) return;

            const fullUrl = normalizeUrl(href);
            if (
                (fullUrl.includes('/shop/c/') || fullUrl.includes('/c/') || fullUrl.includes('/shop/b/')) &&
                !fullUrl.includes('/shop/p/') &&
                !categoryMap.has(fullUrl)
            ) {
                categoryMap.set(fullUrl, title);
            }
        });
    }

    console.log(`[${siteSlug}] Registered ${categoryMap.size} category/subcategory/brand URLs.`);
    return Array.from(categoryMap.entries()).map(([url, name]) => ({ url, name }));
}

/**
 * Crawls a category/brand listing page and handles pagination to collect all product URLs
 * 
 * @param {string} categoryUrl 
 * @param {number|null} pageLimit 
 * @param {Object} [browser]
 */
async function collectProductUrlsFromCategory(categoryUrl, pageLimit = null, browser = null) {
    const productUrls = new Set();
    let currentPage = 1;
    let hasNextPage = true;
    let emptyPagesCount = 0;

    while (hasNextPage) {
        if (pageLimit && currentPage > pageLimit) break;

        const pageUrl = currentPage === 1 
            ? categoryUrl 
            : `${categoryUrl}${categoryUrl.includes('?') ? '&' : '?'}p=${currentPage}`;

        let html = null;
        try {
            const res = await axios.get(pageUrl, {
                headers: HTTP_HEADERS,
                timeout: 15000
            });
            html = res.data;
        } catch (err) {
            html = await fetchWithBrowser(pageUrl, browser);
        }

        if (!html) {
            hasNextPage = false;
            break;
        }

        const $ = cheerio.load(html);
        let foundOnPage = 0;

        // Extract product detail URLs matching /shop/p/ or /p/
        $('a[href*="/shop/p/"], a[href*="/p/"], a.product-tile__link, .product-item a').each((_, el) => {
            const href = $(el).attr('href');
            if (href) {
                const fullProductUrl = normalizeUrl(href);
                if (fullProductUrl.includes('/shop/p/') || fullProductUrl.includes('/p/')) {
                    if (!productUrls.has(fullProductUrl)) {
                        productUrls.add(fullProductUrl);
                        foundOnPage++;
                    }
                }
            }
        });

        // Strategy 2: Embedded JSON-LD ItemList
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).html() || '{}');
                if (Array.isArray(json.itemListElement)) {
                    json.itemListElement.forEach(item => {
                        const u = normalizeUrl(item.url || item.item?.url || '');
                        if (u && (u.includes('/shop/p/') || u.includes('/p/'))) {
                            productUrls.add(u);
                            foundOnPage++;
                        }
                    });
                }
            } catch (e) {}
        });

        const hasPagination = $('.pagination, .paging, [class*="pagination"]').length > 0;
        const nextButton = $('a[rel="next"], .pagination__next, a:contains("weiter"), a:contains(">")');

        if (foundOnPage === 0) {
            emptyPagesCount++;
            if (emptyPagesCount >= 2) {
                hasNextPage = false;
            }
        } else {
            emptyPagesCount = 0;
        }

        if (!hasPagination && foundOnPage === 0) {
            hasNextPage = false;
        }

        if (nextButton.length === 0 && currentPage > 1 && foundOnPage === 0) {
            hasNextPage = false;
        }

        currentPage++;
        await sleep(150);
    }

    return Array.from(productUrls);
}

/**
 * Classifies error into standardized Failure Reason string
 */
function classifyError(status, errorMsg) {
    if (status === 404) return 'HTTP 404';
    if (status === 403) return 'HTTP 403';
    if (status === 429) return 'HTTP 429';
    if (status >= 500 && status < 600) return `HTTP ${status}`;
    if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) return 'Request Timeout';
    if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('ENOTFOUND')) return 'Connection Error';
    if (errorMsg.includes('Redirect')) return 'Redirect';
    if (errorMsg.includes('Parsing') || errorMsg.includes('JSON')) return 'Parsing error';
    if (errorMsg.includes('Data not found') || errorMsg.includes('Missing name')) return 'Product data not found';
    return 'Other';
}

/**
 * Scrapes product detail page with retry logic and failure classification
 * 
 * @param {string} productUrl 
 * @param {string} sourceCategoryUrl 
 * @param {Object} [browser]
 */
async function scrapeProductDetailWithRetries(productUrl, sourceCategoryUrl = '', browser = null) {
    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastError = null;
    let statusCode = 0;

    while (attempt < MAX_RETRIES) {
        attempt++;
        let html = null;
        try {
            const res = await axios.get(productUrl, {
                headers: HTTP_HEADERS,
                timeout: 15000,
                validateStatus: status => status < 500
            });

            statusCode = res.status;

            if (res.status === 404) {
                // Permanent 404 error - do not retry
                return {
                    success: false,
                    failureRecord: {
                        name: '',
                        productUrl,
                        sourceUrl: sourceCategoryUrl,
                        statusCode: 404,
                        errorType: 'HTTP_404',
                        errorMessage: 'Product page returned HTTP 404 Not Found',
                        failureReason: 'HTTP 404',
                        retryAttempts: attempt
                    }
                };
            }

            if (res.status >= 200 && res.status < 300) {
                html = res.data;
            } else {
                throw new Error(`HTTP status ${res.status}`);
            }

        } catch (err) {
            lastError = err;
            if (err.response) statusCode = err.response.status;

            if (attempt < MAX_RETRIES && statusCode !== 404) {
                await sleep(1000 * attempt); // Exponential backoff retry
                continue;
            }

            html = await fetchWithBrowser(productUrl, browser);
        }

        if (!html) {
            const failureReason = classifyError(statusCode, lastError?.message || 'Page content empty');
            return {
                success: false,
                failureRecord: {
                    name: '',
                    productUrl,
                    sourceUrl: sourceCategoryUrl,
                    statusCode: statusCode || 0,
                    errorType: statusCode ? `HTTP_${statusCode}` : 'FETCH_ERROR',
                    errorMessage: lastError?.message || 'Could not fetch page HTML content',
                    failureReason,
                    retryAttempts: attempt
                }
            };
        }

        const $ = cheerio.load(html);

        // ── 1. Structured Data (JSON-LD) Extraction ──────────────────────────
        let productJsonLd = null;
        let breadcrumbData = null;

        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const content = $(el).html();
                if (!content) return;
                const json = JSON.parse(content);
                const items = Array.isArray(json) ? json : [json];

                items.forEach(item => {
                    if (item['@type'] === 'Product' || item['@type'] === 'ProductGroup') {
                        productJsonLd = item;
                    }
                    if (item['@type'] === 'BreadcrumbList') {
                        breadcrumbData = item;
                    }
                });
            } catch (e) {}
        });

        // ── 2. Product Name ───────────────────────────────────────────────────
        let name = '';
        if (productJsonLd && productJsonLd.name) {
            name = decodeHtmlEntities(productJsonLd.name);
        }
        if (!name) {
            name = cleanText($('h1.product-title, h1.product-detail__title, h1').first().text());
        }
        name = decodeHtmlEntities(name);

        if (!name) {
            return {
                success: false,
                failureRecord: {
                    name: '',
                    productUrl,
                    sourceUrl: sourceCategoryUrl,
                    statusCode: statusCode || 200,
                    errorType: 'PARSING_ERROR',
                    errorMessage: 'Product name (H1 / JSON-LD name) not found on page',
                    failureReason: 'Product data not found',
                    retryAttempts: attempt
                }
            };
        }

        // ── 3. Category & Subcategory ─────────────────────────────────────────
        let category = '';
        let subcategory = '';

        if (breadcrumbData && Array.isArray(breadcrumbData.itemListElement)) {
            const crumbs = breadcrumbData.itemListElement
                .map(c => decodeHtmlEntities(c?.item?.name || c?.name || ''))
                .filter(c => c && c.toLowerCase() !== 'home' && c.toLowerCase() !== 'startseite' && c.toLowerCase() !== 'shop');
            
            if (crumbs.length >= 2) {
                category = crumbs[0];
                subcategory = crumbs[1];
            } else if (crumbs.length === 1) {
                category = crumbs[0];
            }
        }

        if (!category) {
            const crumbsHtml = [];
            $('.breadcrumb a, nav[aria-label="breadcrumb"] a').each((_, el) => {
                const txt = cleanText($(el).text());
                if (txt && txt.toLowerCase() !== 'home' && txt.toLowerCase() !== 'startseite' && txt.toLowerCase() !== 'shop') {
                    crumbsHtml.push(decodeHtmlEntities(txt));
                }
            });
            if (crumbsHtml.length >= 2) {
                category = crumbsHtml[0];
                subcategory = crumbsHtml[1];
            } else if (crumbsHtml.length === 1) {
                category = crumbsHtml[0];
            }
        }

        // ── 4. Brand & Manufacturer ───────────────────────────────────────────
        let brand = '';
        let manufacturer = '';

        if (productJsonLd && productJsonLd.brand) {
            brand = typeof productJsonLd.brand === 'object' 
                ? decodeHtmlEntities(productJsonLd.brand.name || '') 
                : decodeHtmlEntities(productJsonLd.brand);
        }
        if (!brand) {
            brand = cleanText($('.product-brand, [data-brand]').first().text());
        }
        manufacturer = brand;

        // ── 5. Pricing (Price, Regular Price, Sale Price, Unit Price) ──────────
        let price = '';
        let regularPrice = '';
        let salePrice = '';
        let unitPrice = '';

        let offer = null;
        if (productJsonLd) {
            if (productJsonLd.offers) {
                offer = Array.isArray(productJsonLd.offers) ? productJsonLd.offers[0] : productJsonLd.offers;
            } else if (Array.isArray(productJsonLd.hasVariant) && productJsonLd.hasVariant[0]?.offers) {
                const vOffers = productJsonLd.hasVariant[0].offers;
                offer = Array.isArray(vOffers) ? vOffers[0] : vOffers;
            }
        }

        if (offer && offer.price !== undefined && offer.price !== null) {
            price = typeof offer.price === 'number' ? `${offer.price.toFixed(2)} €` : `${offer.price} €`;
        }

        const currentPriceText = cleanText($('.product-price, .price--current, .price').first().text());
        const oldPriceText = cleanText($('.price--old, .price-strike, .regular-price').first().text());
        const basePriceText = cleanText($('.base-price, .unit-price').first().text());

        if (!price && currentPriceText) {
            price = currentPriceText;
        }

        if (oldPriceText) {
            regularPrice = oldPriceText;
            salePrice = price;
        } else {
            regularPrice = price;
        }

        if (basePriceText) {
            unitPrice = basePriceText;
        }

        // ── 6. EAN / GTIN / Product ID ────────────────────────────────────────
        let ean = '';
        let productId = '';

        if (productJsonLd) {
            ean = productJsonLd.gtin13 || productJsonLd.gtin8 || productJsonLd.gtin || productJsonLd.sku || '';
            productId = productJsonLd.sku || productJsonLd.productID || productJsonLd.mpn || '';
        }

        const matchId = productUrl.match(/-c?p?(\d+)$/);
        if (matchId && !productId) {
            productId = matchId[1];
        }

        const fullText = $.text();
        if (!ean) {
            const eanMatch = fullText.match(/(?:EAN|GTIN):?\s*(\d{8,14})/i);
            if (eanMatch) ean = eanMatch[1];
        }
        if (!productId) {
            const artMatch = fullText.match(/(?:Artikel-?Nr\.|Art\.-Nr\.|SKU|Produkt-Nr\.):?\s*([A-Za-z0-9-]+)/i);
            if (artMatch) productId = artMatch[1];
        }

        // ── 7. Image URL ──────────────────────────────────────────────────────
        let imageUrl = '';
        if (productJsonLd && productJsonLd.image) {
            imageUrl = Array.isArray(productJsonLd.image) ? productJsonLd.image[0] : productJsonLd.image;
        }
        if (!imageUrl) {
            imageUrl = $('meta[property="og:image"]').attr('content') || 
                       $('.product-detail__image img, .product-image img').first().attr('src') || '';
        }
        imageUrl = normalizeUrl(imageUrl);

        // ── 8. Weight/Quantity, Ingredients, Nutritional Info, Country ────────
        let quantity = '';
        let ingredients = '';
        let nutritionalInfo = '';
        let country = '';

        const qtyMatch = fullText.match(/(?:Inhalt|Gewicht|Füllmenge|Nettofüllmenge):?\s*([\d,\.]+\s*(?:g|kg|l|ml|cl|Stück|Stk\.?|Pck\.?))/i);
        if (qtyMatch) {
            quantity = cleanText(qtyMatch[1]);
        }

        const ingMatch = fullText.match(/(?:Zutaten|Inhaltsstoffe):?\s*([\s\S]{5,1000}?)(?:\s*(?:Nährwerte|Hinweise|Herkunft|EAN|$))/i);
        if (ingMatch) {
            ingredients = cleanText(ingMatch[1]);
        }

        const nutriText = cleanText($('.nutritional-info, table.nutrition-table').text());
        if (nutriText) {
            nutritionalInfo = nutriText;
        }

        const countryMatch = fullText.match(/(?:Herkunft|Herkunftsland|Ursprungsland):?\s*([A-Za-zÄöüÖÜäß\s]+)/i);
        if (countryMatch) {
            country = cleanText(countryMatch[1]);
        }

        // ── 9. Availability ───────────────────────────────────────────────────
        let availability = 'In Stock';
        let onlineAvailability = 'Available online';
        let storeAvailability = 'Check store availability';

        if (offer && offer.availability) {
            const availStr = offer.availability.toString();
            if (availStr.includes('OutOfStock')) {
                availability = 'Out of Stock';
                onlineAvailability = 'Out of stock online';
            }
        }

        // ── 10. Product Badges & Source URLs ──────────────────────────────────
        let badges = '';
        const badgeList = [];
        $('.product-badge, .badge').each((_, el) => {
            const b = cleanText($(el).text());
            if (b) badgeList.push(b);
        });
        if (badgeList.length > 0) {
            badges = Array.from(new Set(badgeList)).join(', ');
        }

        let sourceBrandUrl = '';
        if (sourceCategoryUrl && sourceCategoryUrl.includes('/shop/b/')) {
            sourceBrandUrl = sourceCategoryUrl;
        }

        // ── 11. Description ───────────────────────────────────────────────────
        let description = '';
        if (productJsonLd && productJsonLd.description) {
            description = decodeHtmlEntities(productJsonLd.description);
        }
        if (!description) {
            description = cleanText($('meta[name="description"]').attr('content') || '');
        }

        // Successfully extracted product object
        return {
            success: true,
            product: {
                name,
                category,
                subcategory,
                brand,
                manufacturer,
                productUrl,
                imageUrl,
                description,
                price,
                regularPrice,
                salePrice,
                unitPrice,
                quantity,
                ean,
                productId,
                ingredients,
                nutritionalInfo,
                country,
                availability,
                storeAvailability,
                onlineAvailability,
                badges,
                sourceUrl: sourceCategoryUrl || category,
                sourceBrandUrl
            }
        };
    }

    // Default fallback if while loop terminates unexpectedly
    return {
        success: false,
        failureRecord: {
            name: '',
            productUrl,
            sourceUrl: sourceCategoryUrl,
            statusCode: statusCode || 0,
            errorType: 'UNKNOWN_ERROR',
            errorMessage: 'Product scraping failed after max retries',
            failureReason: 'Other',
            retryAttempts: MAX_RETRIES
        }
    };
}

/**
 * Main scraper entry point for MPREIS
 * 
 * @param {Object} options - Scraper run options
 * @param {number|null} [options.limit] - Limit total scraped products for testing
 */
async function run(options = {}) {
    console.log(`\n=================================================`);
    console.log(`   STARTING SCRAPER FOR: ${siteName} (${siteSlug})`);
    console.log(`=================================================\n`);

    failedRecordsStore.length = 0; // Clear failure records array for fresh run
    const limit = options.limit || null;

    let browser = null;
    if (puppeteer) {
        try {
            const launchOptions = {
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--enable-unsafe-swiftshader'
                ]
            };
            const fs = require('fs');
            if (fs.existsSync('/usr/bin/google-chrome')) {
                launchOptions.executablePath = '/usr/bin/google-chrome';
            }
            browser = await puppeteer.launch(launchOptions);
        } catch (err) {
            console.warn(`[${siteSlug}] Browser launch warning: ${err.message}`);
        }
    }

    const allCategories = await discoverCategories(browser);
    const discoveredUrls = new Map();

    // 1. Discover product URLs across all categories
    for (let i = 0; i < allCategories.length; i++) {
        if (limit && discoveredUrls.size >= limit) break;

        const cat = allCategories[i];
        console.log(`[${siteSlug}] Category [${i + 1}/${allCategories.length}]: ${cat.name} (${cat.url})`);

        const urls = await collectProductUrlsFromCategory(cat.url, limit ? 2 : null, browser);
        for (const u of urls) {
            if (!discoveredUrls.has(u)) {
                discoveredUrls.set(u, cat.url);
            }
            if (limit && discoveredUrls.size >= limit) break;
        }
    }

    const uniqueProductUrls = Array.from(discoveredUrls.entries());
    console.log(`\n[${siteSlug}] Total unique product URLs collected: ${uniqueProductUrls.length}`);

    if (uniqueProductUrls.length === 0) {
        console.log(`[${siteSlug}] No product URLs found.`);
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
        return { products: [], failedRecords: [] };
    }

    // 2. Scrape product detail pages using worker concurrency pool
    const CONCURRENCY = 5;
    const successfulProductsMap = new Map();
    let processedCount = 0;

    console.log(`[${siteSlug}] Scraping ${uniqueProductUrls.length} product pages with ${CONCURRENCY} concurrent workers...\n`);

    async function worker(workerId, taskQueue) {
        while (taskQueue.length > 0) {
            const task = taskQueue.shift();
            if (!task) break;

            const [pUrl, srcCat] = task;
            const res = await scrapeProductDetailWithRetries(pUrl, srcCat, browser);

            processedCount++;
            if (processedCount % 50 === 0 || processedCount === uniqueProductUrls.length) {
                const pct = Math.round((processedCount / uniqueProductUrls.length) * 100);
                console.log(`[${siteSlug}] Progress: [${processedCount}/${uniqueProductUrls.length}] (${pct}%) — Worker #${workerId}`);
            }

            if (res.success && res.product) {
                const dedupeKey = res.product.ean || res.product.productId || res.product.productUrl;
                if (!successfulProductsMap.has(dedupeKey)) {
                    successfulProductsMap.set(dedupeKey, res.product);
                }
            } else if (res.failureRecord) {
                failedRecordsStore.push(res.failureRecord);
            }

            await sleep(150);
        }
    }

    const taskQueue = [...uniqueProductUrls];
    const workerPromises = [];
    for (let i = 1; i <= CONCURRENCY; i++) {
        workerPromises.push(worker(i, taskQueue));
    }

    await Promise.all(workerPromises);

    if (browser) {
        try { await browser.close(); } catch (e) {}
    }

    const finalSuccessfulProducts = Array.from(successfulProductsMap.values());
    const totalDiscovered = uniqueProductUrls.length;
    const totalSuccessful = finalSuccessfulProducts.length;
    const totalFailed = failedRecordsStore.length;
    const successRate = totalDiscovered > 0 ? ((totalSuccessful / totalDiscovered) * 100).toFixed(1) : '0.0';

    // Count failure reasons breakdown
    const failureReasonCounts = {};
    failedRecordsStore.forEach(f => {
        const reason = f.failureReason || 'Other';
        failureReasonCounts[reason] = (failureReasonCounts[reason] || 0) + 1;
    });

    console.log(`\n=================================================`);
    console.log(`   MPREIS SCRAPING SUMMARY`);
    console.log(`=================================================`);
    console.log(`Product URLs discovered: ${totalDiscovered}`);
    console.log(`Unique product URLs:     ${totalDiscovered}`);
    console.log(`Successfully scraped:    ${totalSuccessful}`);
    console.log(`Failed:                  ${totalFailed}`);
    console.log(`Success rate:            ${successRate}%\n`);

    console.log(`Failure reasons:`);
    if (Object.keys(failureReasonCounts).length === 0) {
        console.log(`- None (0 failures)`);
    } else {
        Object.entries(failureReasonCounts).forEach(([r, count]) => {
            console.log(`- ${r.padEnd(24)}: ${count}`);
        });
    }

    console.log(`\nOutputs:`);
    console.log(`- data/mpreis.csv`);
    console.log(`- data/mpreis.xlsx`);
    if (totalFailed > 0) {
        console.log(`- data/mpreis_failed.csv`);
    }
    console.log(`=================================================\n`);

    return {
        products: finalSuccessfulProducts,
        failedRecords: failedRecordsStore
    };
}

module.exports = {
    siteName,
    siteSlug,
    run,
    getFailedRecords
};
