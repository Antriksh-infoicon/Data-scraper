/**
 * Website Scraper Module for BIOGENA Austria (https://biogena.com/de-at/)
 * 
 * Features:
 * - Crawls https://biogena.com/de-at/ across all main product categories & subcategories:
 *   - Vitamine
 *   - Mineralstoffe
 *   - Spurenelemente
 *   - Aminosäuren
 *   - Darmbakterien
 *   - Omega-3-Fettsäuren
 *   - Ballaststoffe
 *   - Kollagen
 *   - Hyaluron
 *   - Coenzym Q10
 *   - Enzyme
 *   - Antioxidantien
 *   - Pflanzenstoffe
 *   - Algen
 *   - Vitalpilze
 *   - Greens
 *   - MSM
 *   - Melatonin
 *   - Bio Öle & Zieh-Öle
 *   - Functional Food & Drinks
 *   - Specials
 *   - Zubehör
 *   - All products overview (~299 products across all pagination pages)
 * - Handles category pagination (?p=N) ensuring all ~299 products are collected
 * - Deep multi-layered data extraction from:
 *   - JSON-LD structured data (@type: Product / ProductGroup / BreadcrumbList)
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
 *   - Unit Price
 *   - Brand / Product Line
 *   - Product Description
 *   - Short Description
 *   - Product Weight / Quantity
 *   - Ingredients
 *   - Nutritional Information
 *   - Recommended Usage / Dosage
 *   - EAN / GTIN
 *   - Product Number / SKU
 *   - Availability
 *   - Product Badges (e.g. Bestseller, Vegan, Neu, Reinsubstanzen)
 *   - Source Category URL
 * - Automatic deduplication by EAN, Product ID / SKU, and canonical Product URL
 * - Exports results to data/biogena.csv and data/biogena.xlsx via engine exporter
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

const siteName = 'BIOGENA Austria';
const siteSlug = 'biogena';
const BASE_URL = 'https://biogena.com';

// Standard HTTP headers to emulate modern browser requests
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'de-AT,de-DE;q=0.9,de;q=0.8,en-US;q=0.7,en;q=0.6',
    'Cache-Control': 'no-cache'
};

// Seed categories pointing to BIOGENA category URLs (/de-at/kategorien/produkte/...)
const SEED_CATEGORIES = [
    { name: 'Alle Produkte', url: 'https://biogena.com/de-at/kategorien/produkte-1' },
    { name: 'Neuheiten', url: 'https://biogena.com/de-at/kategorien/produkte/neuheiten-116' },
    { name: 'Bestseller', url: 'https://biogena.com/de-at/kategorien/produkte/bestseller-112' },
    { name: 'Vitamine', url: 'https://biogena.com/de-at/kategorien/produkte/vitamine-9' },
    { name: 'Mineralstoffe', url: 'https://biogena.com/de-at/kategorien/produkte/mineralstoffe-15' },
    { name: 'Spurenelemente', url: 'https://biogena.com/de-at/kategorien/produkte/spurenelemente-19' },
    { name: 'Aminosäuren', url: 'https://biogena.com/de-at/kategorien/produkte/aminosaeuren-21' },
    { name: 'Darmbakterien', url: 'https://biogena.com/de-at/kategorien/produkte/darmbakterien-23' },
    { name: 'Omega-3-Fettsäuren', url: 'https://biogena.com/de-at/kategorien/produkte/omega-3-fettsaeuren-25' },
    { name: 'Ballaststoffe', url: 'https://biogena.com/de-at/kategorien/produkte/ballaststoffe-27' },
    { name: 'Kollagen', url: 'https://biogena.com/de-at/kategorien/produkte/kollagen-125' },
    { name: 'Hyaluron', url: 'https://biogena.com/de-at/kategorien/produkte/hyaluron-126' },
    { name: 'Coenzym Q10', url: 'https://biogena.com/de-at/kategorien/produkte/coenzym-q10-29' },
    { name: 'Enzyme', url: 'https://biogena.com/de-at/kategorien/produkte/enzyme-31' },
    { name: 'Antioxidantien', url: 'https://biogena.com/de-at/kategorien/produkte/antioxidantien-33' },
    { name: 'Pflanzenstoffe', url: 'https://biogena.com/de-at/kategorien/produkte/pflanzenstoffe-35' },
    { name: 'Algen', url: 'https://biogena.com/de-at/kategorien/produkte/algen-37' },
    { name: 'Vitalpilze', url: 'https://biogena.com/de-at/kategorien/produkte/vitalpilze-39' },
    { name: 'Greens', url: 'https://biogena.com/de-at/kategorien/produkte/greens-41' },
    { name: 'MSM', url: 'https://biogena.com/de-at/kategorien/produkte/msm-43' },
    { name: 'Melatonin', url: 'https://biogena.com/de-at/kategorien/produkte/melatonin-45' },
    { name: 'Bio Öle & Zieh-Öle', url: 'https://biogena.com/de-at/kategorien/produkte/bio-oele-zieh-oele-47' },
    { name: 'Functional Food & Drinks', url: 'https://biogena.com/de-at/kategorien/produkte/functional-food-drinks-49' },
    { name: 'Specials', url: 'https://biogena.com/de-at/kategorien/produkte/specials-51' },
    { name: 'Zubehör', url: 'https://biogena.com/de-at/kategorien/produkte/zubehoer-53' }
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
 * Normalizes relative or absolute URLs into canonical biogena.com URLs
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
 * Crawls landing page to discover category and subcategory links
 */
async function discoverCategories(browser = null) {
    console.log(`[${siteSlug}] Discovering category and subcategory links from ${BASE_URL}/de-at/produkte/...`);
    const categoryMap = new Map();

    for (const seed of SEED_CATEGORIES) {
        categoryMap.set(seed.url, seed.name);
    }

    let html = null;
    try {
        const res = await axios.get('https://biogena.com/de-at/produkte/', {
            headers: HTTP_HEADERS,
            timeout: 15000
        });
        html = res.data;
    } catch (err) {
        html = await fetchWithBrowser('https://biogena.com/de-at/produkte/', browser);
    }

    if (html) {
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            const title = cleanText($(el).text());
            if (!href || !title) return;

            const fullUrl = normalizeUrl(href);
            if (
                fullUrl.includes('/de-at/kategorien/produkte/') &&
                !categoryMap.has(fullUrl)
            ) {
                categoryMap.set(fullUrl, title);
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

        if (!html) {
            hasNextPage = false;
            break;
        }

        const $ = cheerio.load(html);
        let foundOnPage = 0;

        // Extract individual product detail URLs:
        // BIOGENA product URLs start with /de-at/produkte/ and do NOT contain /kategorien/
        $('a[href*="/de-at/produkte/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && !href.includes('/kategorien/')) {
                const fullProductUrl = normalizeUrl(href);
                // Ensure it is a valid product slug URL (e.g. /de-at/produkte/siebensalz-magnesium-komplex-3)
                if (fullProductUrl !== 'https://biogena.com/de-at/produkte/' && !fullProductUrl.endsWith('/produkte/')) {
                    if (!productUrls.has(fullProductUrl)) {
                        productUrls.add(fullProductUrl);
                        foundOnPage++;
                    }
                }
            }
        });

        // Strategy 2: Embedded JSON / JSON-LD ItemList
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).html() || '{}');
                if (Array.isArray(json.itemListElement)) {
                    json.itemListElement.forEach(item => {
                        const u = normalizeUrl(item.url || item.item?.url || '');
                        if (u && u.includes('/de-at/produkte/') && !u.includes('/kategorien/')) {
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
 * Extracts comprehensive details from an individual BIOGENA product page
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
            unitPrice: '',
            brand: 'BIOGENA',
            description: '',
            shortDescription: '',
            quantity: '',
            ingredients: '',
            nutritionalInfo: '',
            usage: '',
            ean: '',
            productId: '',
            availability: 'Unavailable / Fetch Error',
            badges: '',
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
                // BIOGENA uses ProductGroup or Product for schema.org products
                if (item['@type'] === 'Product' || item['@type'] === 'ProductGroup') {
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
        name = cleanText($('h1').first().text());
    }
    name = decodeHtmlEntities(name);

    if (!name) return null; // Invalid product page

    // ── 3. Category & Subcategory ─────────────────────────────────────────────
    let category = '';
    let subcategory = '';

    if (breadcrumbData && Array.isArray(breadcrumbData.itemListElement)) {
        const crumbs = breadcrumbData.itemListElement
            .map(c => decodeHtmlEntities(c?.item?.name || c?.name || ''))
            .filter(c => c && c.toLowerCase() !== 'home' && c.toLowerCase() !== 'startseite' && c.toLowerCase() !== 'produkte');
        
        if (crumbs.length >= 2) {
            category = crumbs[0];
            subcategory = crumbs[1];
        } else if (crumbs.length === 1) {
            category = crumbs[0];
        }
    }

    if (!category) {
        const crumbsHtml = [];
        $('.breadcrumb a, nav[aria-label="breadcrumb"] a, .breadcrumbs a').each((_, el) => {
            const txt = cleanText($(el).text());
            if (txt && txt.toLowerCase() !== 'home' && txt.toLowerCase() !== 'startseite' && txt.toLowerCase() !== 'produkte') {
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

    // ── 4. Brand / Product Line ───────────────────────────────────────────────
    let brand = 'BIOGENA';
    if (productJsonLd && productJsonLd.brand) {
        const b = typeof productJsonLd.brand === 'object' ? productJsonLd.brand.name : productJsonLd.brand;
        if (b) brand = decodeHtmlEntities(b);
    }

    // ── 5. Pricing (Price, Regular Price, Sale Price, Unit Price) ──────────────
    let price = '';
    let regularPrice = '';
    let salePrice = '';
    let unitPrice = '';

    // Extract offer from JSON-LD Product / ProductGroup
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

    const currentPriceText = cleanText($('.product-detail__price, .price, [class*="price"]').first().text());
    const oldPriceText = cleanText($('.price--old, .price-strike, .regular-price').first().text());
    const basePriceText = cleanText($('.product-detail__base-price, .base-price, .unit-price').first().text());

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

    // ── 6. EAN / GTIN / Product Number / SKU ──────────────────────────────────
    let ean = '';
    let productId = '';

    if (productJsonLd) {
        ean = productJsonLd.gtin13 || productJsonLd.gtin8 || productJsonLd.gtin || productJsonLd.sku || '';
        productId = productJsonLd.sku || productJsonLd.productID || productJsonLd.mpn || '';
    }

    // Extract ID from product URL slug (e.g. /produkte/siebensalz-magnesium-komplex-3 -> "3")
    const matchId = productUrl.match(/-(\d+)$/);
    if (matchId) {
        if (!productId) productId = matchId[1];
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

    // ── 7. Image URL ──────────────────────────────────────────────────────────
    let imageUrl = '';
    if (productJsonLd && productJsonLd.image) {
        imageUrl = Array.isArray(productJsonLd.image) ? productJsonLd.image[0] : productJsonLd.image;
    }
    if (!imageUrl) {
        imageUrl = $('meta[property="og:image"]').attr('content') || 
                   $('.product-detail__image img, .product-image img, img[src*="products"]').first().attr('src') || '';
    }
    imageUrl = normalizeUrl(imageUrl);

    // ── 8. Product Weight / Quantity, Ingredients, Nutritional Info, Usage ────
    let quantity = '';
    let shortDescription = '';
    let ingredients = '';
    let nutritionalInfo = '';
    let usage = '';

    // Short Description / Subtitle
    shortDescription = cleanText($('.product-detail__subtitle, .short-description, .product-subtitle, meta[name="description"]').first().attr('content') || '');

    // Quantity (e.g. 60 Kapseln, 180 g, 100 ml)
    const qtyMatch = fullText.match(/(?:Inhalt|Packungsgröße|Füllmenge|Gewicht):?\s*([\d,\.]+\s*(?:Kapseln|Tabletten|g|kg|l|ml|cl|Stück|Stk\.?|Pck\.?))/i);
    if (qtyMatch) {
        quantity = cleanText(qtyMatch[1]);
    }

    // Ingredients / Inhaltsstoffe
    const ingMatch = fullText.match(/(?:Inhaltsstoffe|Zutaten|Zusammensetzung):?\s*([\s\S]{5,1000}?)(?:\s*(?:Verzehrempfehlung|Nährwerte|Hinweise|EAN|Art\.-Nr\.|$))/i);
    if (ingMatch) {
        ingredients = cleanText(ingMatch[1]);
    }

    // Recommended Usage / Dosage
    const usageMatch = fullText.match(/(?:Verzehrempfehlung|Dosierung|Einnahme):?\s*([\s\S]{5,600}?)(?:\s*(?:Inhaltsstoffe|Hinweise|Nährwerte|EAN|$))/i);
    if (usageMatch) {
        usage = cleanText(usageMatch[1]);
    }

    // Nutritional Info / Nährwertangaben / Reinsubstanzen
    const nutriText = cleanText($('.product-detail__nutritional-info, .nutritional-info, table.nutrition-table').text());
    if (nutriText) {
        nutritionalInfo = nutriText;
    }

    // ── 9. Availability ───────────────────────────────────────────────────────
    let availability = 'In Stock';
    if (offer && offer.availability) {
        const availStr = offer.availability.toString();
        if (availStr.includes('OutOfStock')) {
            availability = 'Out of Stock';
        }
    }

    const outOfStockEl = $('.out-of-stock, .product-unavailable, span:contains("nicht lieferbar")');
    if (outOfStockEl.length > 0) {
        availability = 'Out of Stock';
    }

    // ── 10. Product Badges ────────────────────────────────────────────────────
    let badges = '';
    const badgeList = [];
    $('.product-badge, .badge, [data-badge]').each((_, el) => {
        const b = cleanText($(el).text());
        if (b) badgeList.push(b);
    });
    if (badgeList.length > 0) {
        badges = Array.from(new Set(badgeList)).join(', ');
    }

    // ── 11. Description ───────────────────────────────────────────────────────
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
        unitPrice,
        brand,
        description,
        shortDescription,
        quantity,
        ingredients,
        nutritionalInfo,
        usage,
        ean,
        productId,
        availability,
        badges,
        sourceUrl: sourceCategoryUrl || category
    };
}

/**
 * Main scraper entry point for BIOGENA Austria
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

    // 1. Discover product URLs across all categories and pagination pages (~299 products)
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
                // Deduplicate by EAN, Product ID, or canonical Product URL
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
