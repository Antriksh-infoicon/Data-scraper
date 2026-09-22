/**
 * Website Scraper Module for Müller Austria (https://www.mueller.at)
 * 
 * Features:
 * - Crawls https://www.mueller.at across all main product categories & subcategories:
 *   - Drogerie
 *   - Parfümerie
 *   - Spielwaren
 *   - Schreibwaren
 *   - Multi-Media
 *   - Naturshop
 *   - Haushalt
 *   - Tiershop
 *   - Sale
 *   - Marken
 *   - Other categories discovered during navigation crawling
 * - Employs Puppeteer stealth headless browser automation to bypass initial WAF challenge walls
 * - Handles category pagination and dynamic product listings (?p=N / page=N / listing pages)
 * - Deep multi-layered data extraction from:
 *   - JSON-LD structured data (@type: Product / BreadcrumbList)
 *   - Embedded JSON (__PRELOADED_STATE__ / data attributes)
 *   - HTML DOM elements & Meta tags
 * - Extracts complete product schema:
 *   - Product Name
 *   - Category
 *   - Subcategory
 *   - Product URL
 *   - Image URL
 *   - Price
 *   - Regular Price
 *   - Sale Price
 *   - UVP / Recommended Retail Price
 *   - Brand
 *   - Manufacturer
 *   - Product Description
 *   - Product Weight / Quantity
 *   - Unit Price
 *   - Ingredients
 *   - EAN / GTIN
 *   - Availability
 *   - Online availability
 *   - Store availability
 *   - Product ID / Article Number
 *   - Source Category URL
 * - Automatic deduplication by EAN, Product ID, and canonical Product URL
 * - Exports results to data/mueller.csv and data/mueller.xlsx via engine exporter
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { cleanText, sleep } = require('../utils');

// Try importing puppeteer-extra with stealth plugin if available
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

const siteName = 'Müller Austria';
const siteSlug = 'mueller';
const BASE_URL = 'https://www.mueller.at';

// Standard HTTP headers to emulate modern browser requests
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'de-AT,de-DE;q=0.9,de;q=0.8,en-US;q=0.7,en;q=0.6',
    'Cache-Control': 'no-cache'
};

// Seed categories as per requirements
const SEED_CATEGORIES = [
    { name: 'Drogerie', url: 'https://www.mueller.at/drogerie/' },
    { name: 'Parfümerie', url: 'https://www.mueller.at/parfuemerie/' },
    { name: 'Spielwaren', url: 'https://www.mueller.at/spielwaren/' },
    { name: 'Schreibwaren', url: 'https://www.mueller.at/schreibwaren/' },
    { name: 'Multi-Media', url: 'https://www.mueller.at/multi-media/' },
    { name: 'Naturshop', url: 'https://www.mueller.at/naturshop/' },
    { name: 'Haushalt', url: 'https://www.mueller.at/haushalt/' },
    { name: 'Tiershop', url: 'https://www.mueller.at/tiershop/' },
    { name: 'Sale', url: 'https://www.mueller.at/sale/' },
    { name: 'Marken', url: 'https://www.mueller.at/marken/' }
];

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
 * Normalizes relative or absolute URLs into canonical mueller.at URLs
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
 * Launches stealth browser instance to fetch HTML content from protected pages
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
            // Use system Google Chrome if present
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
        await new Promise(r => setTimeout(r, 4000));

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
 * Crawls landing page to discover category and subcategory links
 */
async function discoverCategories(browser = null) {
    console.log(`[${siteSlug}] Discovering category and subcategory links from ${BASE_URL}...`);
    const categoryMap = new Map();

    // Register seed categories first
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
        // Fallback to browser rendering if HTTP 403 or WAF encountered
        html = await fetchWithBrowser(BASE_URL, browser);
    }

    if (html && !html.includes('Client Challenge') && !html.includes('captchaImage')) {
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            const title = cleanText($(el).text());
            if (!href || !title) return;

            const fullUrl = normalizeUrl(href);
            if (
                fullUrl.startsWith(BASE_URL) &&
                !fullUrl.includes('/p/') &&
                !fullUrl.includes('/kundenkonto/') &&
                !fullUrl.includes('/warenkorb/') &&
                !fullUrl.includes('/service/') &&
                !fullUrl.includes('.pdf') &&
                !fullUrl.includes('.jpg')
            ) {
                const isCat = SEED_CATEGORIES.some(s => fullUrl.includes(s.name.toLowerCase()) || fullUrl.includes(s.url));
                if (isCat && !categoryMap.has(fullUrl)) {
                    categoryMap.set(fullUrl, title);
                }
            }
        });
    }

    console.log(`[${siteSlug}] Registered ${categoryMap.size} category/subcategory URLs.`);
    return Array.from(categoryMap.entries()).map(([url, name]) => ({ url, name }));
}

/**
 * Crawls a category listing page and handles pagination to collect all product URLs
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

        if (!html || html.includes('Client Challenge') || html.includes('captchaImage')) {
            hasNextPage = false;
            break;
        }

        const $ = cheerio.load(html);
        let foundOnPage = 0;

        // Strategy 1: Find product links by href pattern (/p/ or product slug)
        $('a[href*="/p/"], a.product-tile__link, a[data-product-id], .product-item a').each((_, el) => {
            const href = $(el).attr('href');
            if (href) {
                const fullProductUrl = normalizeUrl(href);
                if (fullProductUrl.includes('/p/') || fullProductUrl.match(/\/p\/[a-z0-9-]+/i)) {
                    if (!productUrls.has(fullProductUrl)) {
                        productUrls.add(fullProductUrl);
                        foundOnPage++;
                    }
                }
            }
        });

        // Strategy 2: Embedded JSON / Data attributes on product grid items
        $('[data-product], [data-json], script[type="application/ld+json"]').each((_, el) => {
            const rawJson = $(el).attr('data-product') || $(el).attr('data-json') || $(el).html();
            if (rawJson && rawJson.includes('"url"')) {
                try {
                    const parsed = JSON.parse(rawJson);
                    if (parsed.url) {
                        const u = normalizeUrl(parsed.url);
                        if (u.includes('/p/')) {
                            productUrls.add(u);
                            foundOnPage++;
                        }
                    } else if (Array.isArray(parsed.itemListElement)) {
                        parsed.itemListElement.forEach(item => {
                            if (item.url || item.item?.url) {
                                const u = normalizeUrl(item.url || item.item.url);
                                if (u.includes('/p/')) {
                                    productUrls.add(u);
                                    foundOnPage++;
                                }
                            }
                        });
                    }
                } catch (e) {}
            }
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
        await sleep(200);
    }

    return Array.from(productUrls);
}

/**
 * Extracts comprehensive details from an individual Müller product page
 * 
 * @param {string} productUrl 
 * @param {string} sourceCategoryUrl 
 * @param {Object} [browser]
 */
async function scrapeProductDetail(productUrl, sourceCategoryUrl = '', browser = null) {
    let html = null;
    try {
        const res = await axios.get(productUrl, {
            headers: HTTP_HEADERS,
            timeout: 15000,
            validateStatus: status => status < 500
        });

        if (res.status === 404) return null;
        html = res.data;
    } catch (err) {
        html = await fetchWithBrowser(productUrl, browser);
    }

    if (!html || html.includes('Client Challenge') || html.includes('captchaImage')) {
        // Retain URL and basic information as per requirement #13
        return {
            name: '',
            category: '',
            subcategory: '',
            productUrl,
            imageUrl: '',
            price: '',
            regularPrice: '',
            salePrice: '',
            uvp: '',
            brand: '',
            manufacturer: '',
            description: '',
            quantity: '',
            unitPrice: '',
            ingredients: '',
            ean: '',
            availability: 'Protected by WAF / CAPTCHA',
            onlineAvailability: '',
            storeAvailability: '',
            productId: '',
            sourceUrl: sourceCategoryUrl
        };
    }

    const $ = cheerio.load(html);

    // ── 1. Structured Data (JSON-LD) Extraction ──────────────────────────────
    let productJsonLd = null;
    let breadcrumbData = null;

    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const content = $(el).html();
            if (!content) return;
            const json = JSON.parse(content);
            const items = Array.isArray(json) ? json : [json];

            items.forEach(item => {
                if (item['@type'] === 'Product') {
                    productJsonLd = item;
                }
                if (item['@type'] === 'BreadcrumbList') {
                    breadcrumbData = item;
                }
            });
        } catch (e) {}
    });

    // ── 2. Product Name ───────────────────────────────────────────────────────
    let name = '';
    if (productJsonLd && productJsonLd.name) {
        name = decodeHtmlEntities(productJsonLd.name);
    }
    if (!name) {
        name = cleanText($('h1.product-detail__title, h1.product-title, h1').first().text());
    }
    name = decodeHtmlEntities(name);

    if (!name) return null; // Invalid product page

    // ── 3. Category & Subcategory ─────────────────────────────────────────────
    let category = '';
    let subcategory = '';

    if (breadcrumbData && Array.isArray(breadcrumbData.itemListElement)) {
        const crumbs = breadcrumbData.itemListElement
            .map(c => decodeHtmlEntities(c?.item?.name || c?.name || ''))
            .filter(c => c && c.toLowerCase() !== 'home' && c.toLowerCase() !== 'startseite');
        
        if (crumbs.length >= 2) {
            category = crumbs[0];
            subcategory = crumbs[1];
        } else if (crumbs.length === 1) {
            category = crumbs[0];
        }
    }

    if (!category) {
        const crumbsHtml = [];
        $('.breadcrumb a, .breadcrumbs a, nav[aria-label="breadcrumb"] a').each((_, el) => {
            const txt = cleanText($(el).text());
            if (txt && txt.toLowerCase() !== 'home' && txt.toLowerCase() !== 'startseite') {
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

    // ── 4. Brand & Manufacturer ───────────────────────────────────────────────
    let brand = '';
    let manufacturer = '';

    if (productJsonLd && productJsonLd.brand) {
        brand = typeof productJsonLd.brand === 'object' 
            ? decodeHtmlEntities(productJsonLd.brand.name || '') 
            : decodeHtmlEntities(productJsonLd.brand);
    }
    if (productJsonLd && productJsonLd.manufacturer) {
        manufacturer = typeof productJsonLd.manufacturer === 'object' 
            ? decodeHtmlEntities(productJsonLd.manufacturer.name || '') 
            : decodeHtmlEntities(productJsonLd.manufacturer);
    }

    if (!brand) {
        brand = cleanText($('.product-detail__brand, .product-brand, [data-brand]').first().text());
    }
    if (!manufacturer) {
        manufacturer = brand;
    }

    // ── 5. Pricing (Price, Regular Price, Sale Price, UVP, Unit Price) ────────
    let price = '';
    let regularPrice = '';
    let salePrice = '';
    let uvp = '';
    let unitPrice = '';

    const offer = productJsonLd?.offers 
        ? (Array.isArray(productJsonLd.offers) ? productJsonLd.offers[0] : productJsonLd.offers) 
        : null;

    if (offer && offer.price !== undefined && offer.price !== null) {
        price = typeof offer.price === 'number' ? `${offer.price.toFixed(2)} €` : `${offer.price} €`;
    }

    const currentPriceText = cleanText($('.product-price__current, .price--current, .price, [data-price]').first().text());
    const oldPriceText = cleanText($('.product-price__old, .price--old, .price-strike, .uvp').first().text());
    const uvpText = cleanText($('.product-price__uvp, .uvp-price, span:contains("UVP")').first().text());
    const basePriceText = cleanText($('.product-price__base, .base-price, .unit-price').first().text());

    if (!price && currentPriceText) {
        price = currentPriceText;
    }

    if (oldPriceText) {
        regularPrice = oldPriceText;
        salePrice = price;
    } else {
        regularPrice = price;
    }

    if (uvpText) {
        uvp = uvpText.replace(/uvp:?/i, '').trim();
    }

    if (basePriceText) {
        unitPrice = basePriceText;
    }

    // ── 6. EAN / GTIN / Product ID ────────────────────────────────────────────
    let ean = '';
    let productId = '';

    if (productJsonLd) {
        ean = productJsonLd.gtin13 || productJsonLd.gtin8 || productJsonLd.gtin || productJsonLd.sku || '';
        productId = productJsonLd.productID || productJsonLd.sku || productJsonLd.mpn || '';
    }

    const fullText = $.text();
    if (!ean) {
        const eanMatch = fullText.match(/(?:EAN|GTIN):?\s*(\d{8,14})/i);
        if (eanMatch) ean = eanMatch[1];
    }
    if (!productId) {
        const artMatch = fullText.match(/(?:Artikel-?Nr\.|Art\.-Nr\.|Artikelnummer):?\s*([A-Za-z0-9-]+)/i);
        if (artMatch) productId = artMatch[1];
    }

    // ── 7. Image URL ──────────────────────────────────────────────────────────
    let imageUrl = '';
    if (productJsonLd && productJsonLd.image) {
        imageUrl = Array.isArray(productJsonLd.image) ? productJsonLd.image[0] : productJsonLd.image;
    }
    if (!imageUrl) {
        imageUrl = $('meta[property="og:image"]').attr('content') || 
                   $('.product-detail__image img, .product-image img').first().attr('src') || '';
    }
    imageUrl = normalizeUrl(imageUrl);

    // ── 8. Product Weight / Quantity & Ingredients ────────────────────────────
    let quantity = '';
    let ingredients = '';

    const qtyMatch = fullText.match(/(?:Inhalt|Füllmenge|Gewicht|Grammatur):?\s*([\d,\.]+\s*(?:g|kg|l|ml|cl|Stück|Stk\.?|Pck\.?))/i);
    if (qtyMatch) {
        quantity = cleanText(qtyMatch[1]);
    }

    const ingMatch = fullText.match(/(?:Inhaltsstoffe|Zutaten|Ingredients):?\s*([\s\S]{5,800}?)(?:\s*(?:Anwendung|Hinweis|Hersteller|EAN|Art\.-Nr\.|$))/i);
    if (ingMatch) {
        ingredients = cleanText(ingMatch[1]);
    }

    // ── 9. Availability (Online & Store) ──────────────────────────────────────
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

    const outOfStockEl = $('.out-of-stock, .product-unavailable, span:contains("nicht lieferbar")');
    if (outOfStockEl.length > 0) {
        availability = 'Out of Stock';
        onlineAvailability = 'Not available online';
    }

    // ── 10. Description ───────────────────────────────────────────────────────
    let description = '';
    if (productJsonLd && productJsonLd.description) {
        description = decodeHtmlEntities(productJsonLd.description);
    }
    if (!description) {
        description = cleanText($('meta[name="description"]').attr('content') || '');
    }
    if (!description) {
        description = cleanText($('.product-detail__description, .product-description, #description').text());
    }

    return {
        name,
        category,
        subcategory,
        productUrl,
        imageUrl,
        price,
        regularPrice,
        salePrice,
        uvp,
        brand,
        manufacturer,
        description,
        quantity,
        unitPrice,
        ingredients,
        ean,
        availability,
        onlineAvailability,
        storeAvailability,
        productId,
        sourceUrl: sourceCategoryUrl || category
    };
}

/**
 * Main scraper entry point for Müller Austria
 * 
 * @param {Object} options - Scraper run options
 * @param {number|null} [options.limit] - Limit total scraped products for testing
 */
async function run(options = {}) {
    console.log(`\n=================================================`);
    console.log(`   STARTING SCRAPER FOR: ${siteName} (${siteSlug})`);
    console.log(`=================================================\n`);

    const limit = options.limit || null;

    // Initialize browser for WAF handling
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
            console.warn(`[${siteSlug}] Stealth browser launch warning: ${err.message}`);
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
        console.log(`[${siteSlug}] Note: mueller.at is currently protected by Fastly WAF / CAPTCHA challenge on automated requests.`);
        console.log(`[${siteSlug}] Direct headless scrapers are redirected to an interactive CAPTCHA image challenge.`);
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
        return [];
    }

    // 2. Scrape product detail pages using worker concurrency pool
    const CONCURRENCY = 5;
    const productsMap = new Map();
    let processedCount = 0;

    console.log(`[${siteSlug}] Scraping ${uniqueProductUrls.length} product pages with ${CONCURRENCY} concurrent workers...\n`);

    async function worker(workerId, taskQueue) {
        while (taskQueue.length > 0) {
            const task = taskQueue.shift();
            if (!task) break;

            const [pUrl, srcCat] = task;
            const product = await scrapeProductDetail(pUrl, srcCat, browser);

            processedCount++;
            if (processedCount % 50 === 0 || processedCount === uniqueProductUrls.length) {
                const pct = Math.round((processedCount / uniqueProductUrls.length) * 100);
                console.log(`[${siteSlug}] Progress: [${processedCount}/${uniqueProductUrls.length}] (${pct}%) — Worker #${workerId}`);
            }

            if (product && (product.name || product.productUrl)) {
                const dedupeKey = product.ean || product.productId || product.productUrl;
                if (!productsMap.has(dedupeKey)) {
                    productsMap.set(dedupeKey, product);
                }
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

    const finalProducts = Array.from(productsMap.values());

    console.log(`\n=================================================`);
    console.log(`   SCRAPE SUMMARY FOR ${siteName}`);
    console.log(`=================================================`);
    console.log(`- Total Product URLs Found:       ${uniqueProductUrls.length}`);
    console.log(`- Total Unique Products Scraped:  ${finalProducts.length}`);
    console.log(`=================================================\n`);

    return finalProducts;
}

module.exports = {
    siteName,
    siteSlug,
    run
};
