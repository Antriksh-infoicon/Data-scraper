/**
 * Website Scraper Module for dm-drogerie markt Österreich (https://www.dm.at)
 * 
 * Features:
 * - Crawls https://www.dm.at across all main product categories & subcategories:
 *   - Make-up
 *   - Pflege & Parfum
 *   - Haare
 *   - Männerpflege
 *   - Gesundheit
 *   - Ernährung
 *   - Baby & Kind
 *   - Haushalt
 *   - Tier
 *   - Foto
 *   - Other categories discovered during navigation crawling
 * - Handles category pagination, dynamic listing pages, and load-more parameters
 * - Deep multi-layered data extraction from:
 *   - JSON-LD structured data (@type: Product / BreadcrumbList / AggregateRating)
 *   - Embedded JSON (__NEXT_DATA__ / data attributes)
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
 *   - Brand
 *   - Manufacturer
 *   - Product Description
 *   - Product Weight / Quantity
 *   - Unit Price / Grundpreis
 *   - Ingredients
 *   - EAN / GTIN
 *   - Product / Article Number
 *   - Availability
 *   - Online availability
 *   - Store availability
 *   - Rating
 *   - Review Count
 *   - Product Badges (e.g. NEW, Online-Exklusiv, dm-Marke)
 *   - Source Category URL
 * - Automatic deduplication by EAN, Product ID, and canonical Product URL
 * - Exports results to data/dm.csv and data/dm.xlsx via engine exporter
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

const siteName = 'dm-drogerie markt Austria';
const siteSlug = 'dm';
const BASE_URL = 'https://www.dm.at';

// Standard HTTP headers to emulate modern browser requests
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'de-AT,de-DE;q=0.9,de;q=0.8,en-US;q=0.7,en;q=0.6',
    'Cache-Control': 'no-cache'
};

// Seed categories as per requirements
const SEED_CATEGORIES = [
    { name: 'Make-up', url: 'https://www.dm.at/make-up' },
    { name: 'Pflege & Parfum', url: 'https://www.dm.at/pflege-und-parfum' },
    { name: 'Haare', url: 'https://www.dm.at/haare' },
    { name: 'Männerpflege', url: 'https://www.dm.at/maennerpflege' },
    { name: 'Gesundheit', url: 'https://www.dm.at/gesundheit' },
    { name: 'Ernährung', url: 'https://www.dm.at/ernaehrung' },
    { name: 'Baby & Kind', url: 'https://www.dm.at/baby-und-kind' },
    { name: 'Haushalt', url: 'https://www.dm.at/haushalt' },
    { name: 'Tier', url: 'https://www.dm.at/tier' },
    { name: 'Foto', url: 'https://www.dm.at/foto' }
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
 * Normalizes relative or absolute URLs into canonical dm.at URLs
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
        await new Promise(r => setTimeout(r, 3000));

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
                fullUrl.startsWith(BASE_URL) &&
                !fullUrl.includes('-p') &&
                !fullUrl.includes('/mein-dm/') &&
                !fullUrl.includes('/warenkorb') &&
                !fullUrl.includes('/service/') &&
                !fullUrl.includes('.pdf') &&
                !fullUrl.includes('.jpg')
            ) {
                const isCat = SEED_CATEGORIES.some(s => fullUrl.includes(s.url) || fullUrl.split('/')[3] === s.url.split('/')[3]);
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
            : `${categoryUrl}${categoryUrl.includes('?') ? '&' : '?'}page=${currentPage}&pageSize=60`;

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

        // Strategy 1: Find product links by href pattern (-p[gtin].html or /p/[gtin])
        $('a[href*="-p"], a[href*="/p/"], a[data-product-gtin], .product-card a').each((_, el) => {
            const href = $(el).attr('href');
            if (href) {
                const fullProductUrl = normalizeUrl(href);
                if (fullProductUrl.match(/-p\d+\.html/i) || fullProductUrl.match(/\/p\d+/i) || fullProductUrl.includes('-p')) {
                    if (!productUrls.has(fullProductUrl)) {
                        productUrls.add(fullProductUrl);
                        foundOnPage++;
                    }
                }
            }
        });

        // Strategy 2: Embedded JSON / __NEXT_DATA__ on dm.at page
        const nextDataScript = $('#__NEXT_DATA__').html();
        if (nextDataScript) {
            try {
                const nextData = JSON.parse(nextDataScript);
                const productsList = nextData?.props?.pageProps?.searchResult?.products || 
                                     nextData?.props?.pageProps?.products || [];
                productsList.forEach(p => {
                    if (p.relativeProductUrl || p.productUrl || p.gtin) {
                        const rel = p.relativeProductUrl || p.productUrl || `/product-p${p.gtin}.html`;
                        const u = normalizeUrl(rel);
                        if (!productUrls.has(u)) {
                            productUrls.add(u);
                            foundOnPage++;
                        }
                    }
                });
            } catch (e) {}
        }

        // Strategy 3: JSON-LD ItemList
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).html() || '{}');
                if (Array.isArray(json.itemListElement)) {
                    json.itemListElement.forEach(item => {
                        const u = normalizeUrl(item.url || item.item?.url || '');
                        if (u && (u.includes('-p') || u.includes('.html'))) {
                            productUrls.add(u);
                            foundOnPage++;
                        }
                    });
                }
            } catch (e) {}
        });

        const hasPagination = $('.pagination, [data-testid="pagination"]').length > 0;
        const nextButton = $('a[rel="next"], [data-testid="pagination-next"]');

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
 * Extracts comprehensive details from an individual dm.at product page
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

    if (!html) {
        // Retain URL and basic information as per requirement #14
        return {
            name: '',
            category: '',
            subcategory: '',
            productUrl,
            imageUrl: '',
            price: '',
            regularPrice: '',
            salePrice: '',
            brand: '',
            manufacturer: '',
            description: '',
            quantity: '',
            unitPrice: '',
            ingredients: '',
            ean: '',
            productId: '',
            availability: 'Unavailable / Fetch Error',
            onlineAvailability: '',
            storeAvailability: '',
            rating: '',
            reviewCount: '',
            badges: '',
            sourceUrl: sourceCategoryUrl
        };
    }

    const $ = cheerio.load(html);

    // ── 1. Embedded JSON (__NEXT_DATA__) & JSON-LD Extraction ────────────────
    let productJsonLd = null;
    let breadcrumbData = null;
    let nextPropsProduct = null;

    // Check __NEXT_DATA__
    const nextDataRaw = $('#__NEXT_DATA__').html();
    if (nextDataRaw) {
        try {
            const parsedNext = JSON.parse(nextDataRaw);
            nextPropsProduct = parsedNext?.props?.pageProps?.product || parsedNext?.props?.pageProps?.initialState?.product;
        } catch (e) {}
    }

    // Check JSON-LD
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
    if (nextPropsProduct && nextPropsProduct.title) {
        name = decodeHtmlEntities(nextPropsProduct.title);
    }
    if (!name && productJsonLd && productJsonLd.name) {
        name = decodeHtmlEntities(productJsonLd.name);
    }
    if (!name) {
        name = cleanText($('h1[data-testid="product-name"], h1.product-name, h1').first().text());
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
        $('[aria-label="Breadcrumb"] a, .breadcrumb a, nav a').each((_, el) => {
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

    if (nextPropsProduct && nextPropsProduct.brandName) {
        brand = decodeHtmlEntities(nextPropsProduct.brandName);
    }
    if (!brand && productJsonLd && productJsonLd.brand) {
        brand = typeof productJsonLd.brand === 'object' 
            ? decodeHtmlEntities(productJsonLd.brand.name || '') 
            : decodeHtmlEntities(productJsonLd.brand);
    }
    if (!brand) {
        brand = cleanText($('[data-testid="product-brand"], .product-brand').first().text());
    }
    manufacturer = brand;

    // ── 5. Pricing (Price, Regular Price, Sale Price, Unit Price) ──────────────
    let price = '';
    let regularPrice = '';
    let salePrice = '';
    let unitPrice = '';

    if (nextPropsProduct && nextPropsProduct.price) {
        const pVal = nextPropsProduct.price.formatted || nextPropsProduct.price.current;
        if (pVal) price = typeof pVal === 'number' ? `${pVal.toFixed(2)} €` : `${pVal}`;
    }

    const offer = productJsonLd?.offers 
        ? (Array.isArray(productJsonLd.offers) ? productJsonLd.offers[0] : productJsonLd.offers) 
        : null;

    if (!price && offer && offer.price !== undefined && offer.price !== null) {
        price = typeof offer.price === 'number' ? `${offer.price.toFixed(2)} €` : `${offer.price} €`;
    }

    const currentPriceText = cleanText($('[data-testid="price-formatted"], .price-current, .price').first().text());
    const oldPriceText = cleanText($('.price-old, .price-strike, .regular-price').first().text());
    const basePriceText = cleanText($('[data-testid="base-price"], .base-price, .unit-price').first().text());

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

    // ── 6. EAN / GTIN / Product ID ────────────────────────────────────────────
    let ean = '';
    let productId = '';

    if (nextPropsProduct) {
        gtin = nextPropsProduct.gtin || '';
        ean = gtin;
        productId = nextPropsProduct.dan || nextPropsProduct.id || gtin;
    }

    if (!ean && productJsonLd) {
        ean = productJsonLd.gtin13 || productJsonLd.gtin8 || productJsonLd.gtin || productJsonLd.sku || '';
        productId = productJsonLd.sku || productJsonLd.productID || '';
    }

    // Fallback URL pattern for GTIN (e.g. /product-name-p4066447231234.html)
    if (!ean || !productId) {
        const matchGtin = productUrl.match(/-p(\d{8,14})/i);
        if (matchGtin) {
            if (!ean) ean = matchGtin[1];
            if (!productId) productId = matchGtin[1];
        }
    }

    const fullText = $.text();
    if (!ean) {
        const eanMatch = fullText.match(/(?:EAN|GTIN):?\s*(\d{8,14})/i);
        if (eanMatch) ean = eanMatch[1];
    }

    // ── 7. Image URL ──────────────────────────────────────────────────────────
    let imageUrl = '';
    if (nextPropsProduct && nextPropsProduct.imageUrl) {
        imageUrl = nextPropsProduct.imageUrl;
    }
    if (!imageUrl && productJsonLd && productJsonLd.image) {
        imageUrl = Array.isArray(productJsonLd.image) ? productJsonLd.image[0] : productJsonLd.image;
    }
    if (!imageUrl) {
        imageUrl = $('meta[property="og:image"]').attr('content') || 
                   $('[data-testid="product-image"] img, img.product-image').first().attr('src') || '';
    }
    imageUrl = normalizeUrl(imageUrl);

    // ── 8. Product Weight / Quantity & Ingredients ────────────────────────────
    let quantity = '';
    let ingredients = '';

    if (nextPropsProduct && nextPropsProduct.netQuantity) {
        quantity = cleanText(nextPropsProduct.netQuantity);
    }

    const qtyMatch = fullText.match(/(?:Inhalt|Füllmenge|Gewicht|Nettofüllmenge):?\s*([\d,\.]+\s*(?:g|kg|l|ml|cl|Stück|Stk\.?|Pck\.?))/i);
    if (!quantity && qtyMatch) {
        quantity = cleanText(qtyMatch[1]);
    }

    const ingMatch = fullText.match(/(?:Inhaltsstoffe|Zutaten|Ingredients):?\s*([\s\S]{5,800}?)(?:\s*(?:Verwendungshinweise|Aufbewahrung|Hersteller|EAN|Art\.-Nr\.|$))/i);
    if (ingMatch) {
        ingredients = cleanText(ingMatch[1]);
    }

    // ── 9. Availability (Online & Store) ──────────────────────────────────────
    let availability = 'In Stock';
    let onlineAvailability = 'Available online';
    let storeAvailability = 'Check store availability';

    if (nextPropsProduct) {
        if (nextPropsProduct.purchasable === false) {
            availability = 'Out of Stock';
            onlineAvailability = 'Not available online';
        }
    } else if (offer && offer.availability) {
        const availStr = offer.availability.toString();
        if (availStr.includes('OutOfStock')) {
            availability = 'Out of Stock';
            onlineAvailability = 'Out of stock online';
        }
    }

    // ── 10. Rating & Review Count ─────────────────────────────────────────────
    let rating = '';
    let reviewCount = '';

    if (nextPropsProduct && nextPropsProduct.rating) {
        rating = nextPropsProduct.rating.ratingValue ? `${nextPropsProduct.rating.ratingValue}/5` : '';
        reviewCount = nextPropsProduct.rating.ratingCount || nextPropsProduct.rating.reviewCount || '';
    }

    if (!rating && productJsonLd && productJsonLd.aggregateRating) {
        const r = productJsonLd.aggregateRating;
        if (r.ratingValue) rating = `${r.ratingValue}/5`;
        if (r.reviewCount || r.ratingCount) reviewCount = `${r.reviewCount || r.ratingCount}`;
    }

    // ── 11. Product Badges ───────────────────────────────────────────────────
    let badges = '';
    const badgeList = [];
    $('[data-testid="badge"], .product-badge, .badge').each((_, el) => {
        const b = cleanText($(el).text());
        if (b) badgeList.push(b);
    });
    if (badgeList.length > 0) {
        badges = Array.from(new Set(badgeList)).join(', ');
    }

    // ── 12. Description ───────────────────────────────────────────────────────
    let description = '';
    if (nextPropsProduct && nextPropsProduct.description) {
        description = decodeHtmlEntities(nextPropsProduct.description);
    }
    if (!description && productJsonLd && productJsonLd.description) {
        description = decodeHtmlEntities(productJsonLd.description);
    }
    if (!description) {
        description = cleanText($('meta[name="description"]').attr('content') || '');
    }
    if (!description) {
        description = cleanText($('[data-testid="product-description"], .product-description, #description').text());
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
        brand,
        manufacturer,
        description,
        quantity,
        unitPrice,
        ingredients,
        ean,
        productId,
        availability,
        onlineAvailability,
        storeAvailability,
        rating,
        reviewCount,
        badges,
        sourceUrl: sourceCategoryUrl || category
    };
}

/**
 * Main scraper entry point for dm-drogerie markt Austria
 * 
 * @param {Object} options - Scraper run options
 * @param {number|null} [options.limit] - Limit total scraped products for testing
 */
async function run(options = {}) {
    console.log(`\n=================================================`);
    console.log(`   STARTING SCRAPER FOR: ${siteName} (${siteSlug})`);
    console.log(`=================================================\n`);

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
