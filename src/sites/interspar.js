/**
 * Website Scraper Module for INTERSPAR Austria (https://www.interspar.at)
 *
 * Requirements & Architecture:
 * 1. Crawls https://www.interspar.at across all 3 online shopping areas:
 *    - Lebensmittel: https://www.interspar.at/shop/lebensmittel/
 *    - Haushalt & Freizeit: https://www.interspar.at/shop/haushalt/
 *    - Weinwelt: https://www.interspar.at/shop/weinwelt/
 * 2. Uses XML Sitemaps (https://www.interspar.at/shop/{shopType}/sitemap.xml) for complete
 *    and exhaustive URL discovery across all categories and subcategories (20,000+ products).
 * 3. Uses Puppeteer with Stealth Plugin to bypass Cloudflare WAF protection on PDP pages.
 * 4. Extracts 20+ product attributes:
 *    - Product Name, Category, Subcategory, Brand, Manufacturer
 *    - Price, Regular Price, Sale Price, UVP, Unit Price, Weight / Quantity
 *    - Product URL, Image URL, Source Category URL, Shop Type
 *    - Description, Short Description, Ingredients, Nutritional Info, Country of Origin
 *    - EAN / GTIN / Article Number / Product ID, Availability, Badges
 * 5. Complete Failure Tracking System recording failed URLs into interspar_failed.csv:
 *    - Records failure details including 'Shop Type'
 *    - Categorizes failures (4xx, 5xx, Timeout, Cloudflare, Invalid JSON-LD, Empty Data)
 * 6. Outputs data to data/interspar.csv and data/interspar.xlsx managed by orchestrator index.js.
 */

'use strict';

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { cleanText, sleep } = require('../utils');

// Require Puppeteer with Stealth plugin
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

// ─── Constants & Metadata ───────────────────────────────────────────────────

const siteName = 'INTERSPAR Austria';
const siteSlug = 'interspar';
const BASE_URL = 'https://www.interspar.at';

const SHOPS = [
    {
        type: 'Lebensmittel',
        sitemapUrl: 'https://www.interspar.at/shop/lebensmittel/sitemap.xml',
        baseUrl: 'https://www.interspar.at/shop/lebensmittel/'
    },
    {
        type: 'Haushalt & Freizeit',
        sitemapUrl: 'https://www.interspar.at/shop/haushalt/sitemap.xml',
        baseUrl: 'https://www.interspar.at/shop/haushalt/'
    },
    {
        type: 'Weinwelt',
        sitemapUrl: 'https://www.interspar.at/shop/weinwelt/sitemap.xml',
        baseUrl: 'https://www.interspar.at/shop/weinwelt/'
    }
];

// Global failure tracking store
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
function recordFailure({ name = '', productUrl, sourceUrl = '', shopType = 'Lebensmittel', statusCode = 0, errorType = 'UNKNOWN_ERROR', errorMessage = '', failureReason = 'Unknown Error', retryAttempts = 1 }) {
    failedRecordsStore.push({
        name: cleanText(name) || extractSlugFromUrl(productUrl),
        productUrl,
        sourceUrl,
        shopType,
        statusCode: statusCode || 0,
        errorType,
        errorMessage: cleanText(errorMessage),
        failureReason,
        retryAttempts
    });
}

/**
 * Helper to extract a readable slug/name from a product URL
 */
function extractSlugFromUrl(url) {
    if (!url) return '';
    try {
        const parts = url.split('/p/')[0].split('/');
        return parts[parts.length - 1] || '';
    } catch (e) {
        return url;
    }
}

/**
 * Classifies an error into standard failure reasons
 */
function classifyError(err, statusCode = 0) {
    if (statusCode >= 400 && statusCode < 500) {
        if (statusCode === 403) return { type: 'CLOUDFLARE_BLOCKED', reason: 'Cloudflare / WAF Blocked' };
        return { type: `HTTP_${statusCode}`, reason: 'HTTP Client Error (4xx)' };
    }
    if (statusCode >= 500) {
        return { type: `HTTP_${statusCode}`, reason: 'HTTP Server Error (5xx)' };
    }
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('navigation')) {
        return { type: 'TIMEOUT', reason: 'Navigation Timeout' };
    }
    if (msg.includes('json-ld') || msg.includes('schema')) {
        return { type: 'INVALID_JSON_LD', reason: 'Invalid / Missing JSON-LD' };
    }
    if (msg.includes('empty') || msg.includes('missing')) {
        return { type: 'EMPTY_DATA', reason: 'Empty Product Data' };
    }
    return { type: 'NETWORK_ERROR', reason: 'Network / Connection Error' };
}

// ─── Sitemap Discovery ──────────────────────────────────────────────────────

/**
 * Fetches and parses sitemap index to discover all product page URLs.
 * Returns an array of objects: { url, shopType, sourceSitemap }
 */
async function discoverProductUrlsFromSitemaps(shopConfig) {
    console.log(`[INTERSPAR] Fetching sitemap index for ${shopConfig.type}...`);
    const parser = new XMLParser();
    const urls = [];

    try {
        const res = await axios.get(shopConfig.sitemapUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            },
            timeout: 15000
        });

        const parsed = parser.parse(res.data);
        const subSitemaps = parsed.sitemapindex?.sitemap || [];
        const sitemapList = Array.isArray(subSitemaps) ? subSitemaps : [subSitemaps];

        // Filter for product sub-sitemaps (usually contains 'Product-de-EUR')
        const productSitemaps = sitemapList.filter(s => s.loc && s.loc.includes('Product-de-EUR'));
        console.log(`[INTERSPAR] Found ${productSitemaps.length} product sub-sitemaps for ${shopConfig.type}.`);

        for (const sitemapObj of productSitemaps) {
            const subUrl = sitemapObj.loc;
            try {
                const subRes = await axios.get(subUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                    timeout: 15000
                });
                const subParsed = parser.parse(subRes.data);
                const urlNodes = subParsed.urlset?.url || [];
                const list = Array.isArray(urlNodes) ? urlNodes : [urlNodes];

                for (const node of list) {
                    if (node.loc && node.loc.includes('/p/')) {
                        urls.push({
                            url: node.loc,
                            shopType: shopConfig.type,
                            sourceSitemap: subUrl
                        });
                    }
                }
            } catch (err) {
                console.error(`[INTERSPAR] Error reading sub-sitemap ${subUrl}:`, err.message);
            }
        }
    } catch (err) {
        console.error(`[INTERSPAR] Failed to fetch sitemap index for ${shopConfig.type}:`, err.message);
    }

    console.log(`[INTERSPAR] Total discovered product URLs for ${shopConfig.type}: ${urls.length}`);
    return urls;
}

// ─── Product Page Data Extractor ───────────────────────────────────────────

/**
 * Scrapes a single product detail page using Puppeteer
 */
async function scrapeProductPage(page, itemTarget, maxRetries = 3) {
    const { url, shopType, sourceSitemap } = itemTarget;
    let attempts = 0;
    let lastError = null;

    while (attempts < maxRetries) {
        attempts++;
        try {
            const response = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            const statusCode = response ? response.status() : 0;
            if (statusCode === 403 || statusCode >= 400) {
                const errObj = classifyError(new Error(`HTTP status ${statusCode}`), statusCode);
                if (attempts >= maxRetries) {
                    recordFailure({
                        productUrl: url,
                        sourceUrl: sourceSitemap,
                        shopType,
                        statusCode,
                        errorType: errObj.type,
                        errorMessage: `Server returned status code ${statusCode}`,
                        failureReason: errObj.reason,
                        retryAttempts: attempts
                    });
                    return null;
                }
                await sleep(1000 * attempts);
                continue;
            }

            // Wait briefly for hydration
            await new Promise(r => setTimeout(r, 2000));

            // Extract page data inside evaluate context
            const extractedData = await page.evaluate(() => {
                // 1. Parse JSON-LD scripts
                const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                let productSchema = null;
                let breadcrumbSchema = null;

                for (const script of jsonLdScripts) {
                    try {
                        const data = JSON.parse(script.textContent);
                        if (data['@type'] === 'Product') {
                            productSchema = data;
                        } else if (data['@type'] === 'BreadcrumbList') {
                            breadcrumbSchema = data;
                        }
                    } catch (e) {
                        // ignore JSON parse error
                    }
                }

                // 2. DOM extraction for extra fields
                const h1 = document.querySelector('h1')?.innerText?.trim() || '';
                const priceText = document.querySelector('.productDetailsPrice, [class*="price"]')?.innerText?.trim() || '';
                const articleNumText = document.querySelector('.productDetailsArticleNumber, [class*="ArticleNumber"]')?.innerText?.trim() || '';
                const bodyText = document.body.innerText || '';

                // Ingredients
                const ingredientEl = document.querySelector('.ingredientInformation, [class*="ingredient"]');
                const ingredients = ingredientEl ? ingredientEl.innerText.trim() : '';

                // Price details / Unit price
                const priceContainer = document.querySelector('.productMainDetailsPriceLabels, [class*="PriceLabels"]');
                const priceContainerText = priceContainer ? priceContainer.innerText.trim() : '';

                return {
                    productSchema,
                    breadcrumbSchema,
                    h1,
                    priceText,
                    articleNumText,
                    ingredients,
                    priceContainerText,
                    bodyTextSnippet: bodyText.substring(0, 3000)
                };
            });

            const { productSchema, breadcrumbSchema, h1, ingredients, priceContainerText, bodyTextSnippet } = extractedData;

            if (!productSchema && !h1) {
                const errObj = classifyError(new Error('Missing Product Schema and H1 title'), 200);
                if (attempts >= maxRetries) {
                    recordFailure({
                        productUrl: url,
                        sourceUrl: sourceSitemap,
                        shopType,
                        statusCode: 200,
                        errorType: 'MISSING_DATA',
                        errorMessage: 'Product page loaded but contained no product schema or title',
                        failureReason: errObj.reason,
                        retryAttempts: attempts
                    });
                    return null;
                }
                await sleep(1000 * attempts);
                continue;
            }

            // ─── Attribute Normalization & Extraction ─────────────────────

            // Name
            const rawName = productSchema?.name || h1 || extractSlugFromUrl(url);
            const name = cleanText(rawName.replace(/\n+/g, ' '));

            // Product ID / Article Number / EAN / GTIN
            const productId = productSchema?.sku || productSchema?.gtin13 || (extractedData.articleNumText.match(/\d+/) ? extractedData.articleNumText.match(/\d+/)[0] : '');
            const ean = productSchema?.gtin13 || productSchema?.gtin8 || productId;

            // Brand
            const brand = cleanText(productSchema?.brand?.name || productSchema?.brand || '');

            // Category & Subcategory from BreadcrumbList
            let category = shopType;
            let subcategory = '';

            if (breadcrumbSchema?.itemListElement && Array.isArray(breadcrumbSchema.itemListElement)) {
                const crumbs = breadcrumbSchema.itemListElement
                    .sort((a, b) => (parseInt(a.position) || 0) - (parseInt(b.position) || 0))
                    .map(item => cleanText(item.name))
                    .filter(name => name && name !== 'Startseite' && name !== 'Home' && name !== 'Produkte');

                if (crumbs.length > 0) {
                    category = crumbs[0];
                }
                if (crumbs.length > 1) {
                    subcategory = crumbs.slice(1, -1).join(' > ') || crumbs[1];
                }
            }

            // Price
            let price = null;
            let regularPrice = null;
            let salePrice = null;

            if (productSchema?.offers?.price) {
                price = parseFloat(productSchema.offers.price);
            } else {
                const priceMatch = extractedData.priceText.match(/(\d+[\.,]\d{2})/);
                if (priceMatch) {
                    price = parseFloat(priceMatch[1].replace(',', '.'));
                }
            }

            // Check for UVP / regular price in page text
            const stattMatch = bodyTextSnippet.match(/statt\s+(\d+[\.,]\d{2})/i);
            if (stattMatch) {
                regularPrice = parseFloat(stattMatch[1].replace(',', '.'));
                salePrice = price;
            } else {
                regularPrice = price;
            }

            // Unit Price (e.g. 5,69 €/kg or 17,99 €/l)
            let unitPrice = '';
            const unitMatch = priceContainerText.match(/(\d+[\.,]\d{2}\s*€\s*\/\s*\w+)/i) || bodyTextSnippet.match(/(\d+[\.,]\d{2}\s*€\s*\/\s*\w+)/i);
            if (unitMatch) {
                unitPrice = cleanText(unitMatch[1]);
            }

            // Weight / Quantity (e.g., "350 G" or "1 L")
            let quantity = '';
            const qtyMatch = name.match(/(\d+(?:[\.,]\d+)?\s*(?:g|kg|ml|l|cl|stk|stück|packung|beutel)\b)/i);
            if (qtyMatch) {
                quantity = qtyMatch[1];
            }

            // Description
            const description = cleanText(productSchema?.description || '');

            // Images
            let imageUrl = '';
            if (Array.isArray(productSchema?.image)) {
                imageUrl = productSchema.image[0];
            } else if (typeof productSchema?.image === 'string') {
                imageUrl = productSchema.image;
            }

            // Availability
            const availabilitySchema = productSchema?.offers?.availability || '';
            const availability = availabilitySchema.includes('InStock') ? 'In Stock' : 'Out of Stock';

            // Country of Origin
            let country = '';
            const countryMatch = bodyTextSnippet.match(/Ursprungsland\/Herkunftsort:\s*([^\n\t]+)/i) || bodyTextSnippet.match(/Hergestellt in\s*([^\n\t]+)/i);
            if (countryMatch) {
                country = cleanText(countryMatch[1]);
            }

            // Badges (Bio, Vegan, etc.)
            const badgesList = [];
            if (name.toLowerCase().includes('bio') || bodyTextSnippet.toLowerCase().includes('bio-kontrollstelle')) badgesList.push('Bio');
            if (name.toLowerCase().includes('vegan')) badgesList.push('Vegan');
            if (name.toLowerCase().includes('ohne zuckerzusatz')) badgesList.push('Ohne Zuckerzusatz');
            const badges = badgesList.join(', ');

            // Source Category URL
            const sourceCategoryUrl = sourceSitemap || shopType;

            return {
                name,
                category,
                subcategory,
                price: price !== null ? price : '',
                regularPrice: regularPrice !== null ? regularPrice : '',
                salePrice: salePrice !== null ? salePrice : '',
                uvp: regularPrice && salePrice && regularPrice > salePrice ? regularPrice : '',
                brand,
                manufacturer: brand,
                description,
                productUrl: url,
                imageUrl,
                sourceUrl: sourceCategoryUrl,
                quantity,
                unitPrice,
                ingredients: cleanText(ingredients),
                ean,
                availability,
                onlineAvailability: availability,
                storeAvailability: availability,
                productId,
                badges,
                country,
                shopType
            };

        } catch (err) {
            lastError = err;
            const errObj = classifyError(err);
            if (attempts >= maxRetries) {
                recordFailure({
                    productUrl: url,
                    sourceUrl: sourceSitemap,
                    shopType,
                    statusCode: 0,
                    errorType: errObj.type,
                    errorMessage: err.message,
                    failureReason: errObj.reason,
                    retryAttempts: attempts
                });
                return null;
            }
            await sleep(1000 * attempts);
        }
    }

    return null;
}

// ─── Main Execution Runner ──────────────────────────────────────────────────

/**
 * Main scraper entry point required by project orchestrator.
 */
async function run(options = {}) {
    const startTime = Date.now();
    console.log(`\n=================================================`);
    console.log(`  STARTING SCRAPER FOR: ${siteName}`);
    console.log(`=================================================\n`);

    if (!puppeteer) {
        throw new Error('Puppeteer is required to run the INTERSPAR scraper but could not be loaded.');
    }

    // Step 1: Discover all product URLs from XML sitemaps
    const allDiscoveredUrls = [];
    const urlStats = {
        'Lebensmittel': 0,
        'Haushalt & Freizeit': 0,
        'Weinwelt': 0
    };

    for (const shop of SHOPS) {
        const urls = await discoverProductUrlsFromSitemaps(shop);
        urlStats[shop.type] = urls.length;
        allDiscoveredUrls.push(...urls);
    }

    console.log(`\n[INTERSPAR] Total unique product URLs discovered across all shop areas: ${allDiscoveredUrls.length}`);

    // If options.limit is passed (e.g. testing), respect limit
    const targetUrls = options.limit ? allDiscoveredUrls.slice(0, options.limit) : allDiscoveredUrls;

    // Step 2: Launch browser for PDP scraping
    console.log(`[INTERSPAR] Launching stealth browser...`);
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
        ]
    });

    const products = [];
    const shopSuccessStats = { 'Lebensmittel': 0, 'Haushalt & Freizeit': 0, 'Weinwelt': 0 };
    const shopFailedStats = { 'Lebensmittel': 0, 'Haushalt & Freizeit': 0, 'Weinwelt': 0 };

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        let index = 0;
        for (const item of targetUrls) {
            index++;
            if (index % 100 === 0 || index === targetUrls.length) {
                console.log(`[INTERSPAR] Processing product ${index}/${targetUrls.length} (${Math.round((index / targetUrls.length) * 100)}%)...`);
            }

            const product = await scrapeProductPage(page, item);
            if (product) {
                products.push(product);
                shopSuccessStats[item.shopType] = (shopSuccessStats[item.shopType] || 0) + 1;
            } else {
                shopFailedStats[item.shopType] = (shopFailedStats[item.shopType] || 0) + 1;
            }

            // Brief delay between requests
            await sleep(options.delay || 150);
        }

    } finally {
        await browser.close();
    }

    const durationSec = Math.round((Date.now() - startTime) / 1000);

    // Step 3: Print detailed execution summary block
    console.log(`\n=================================================`);
    console.log(`  INTERSPAR AUSTRIA SCRAPE SUMMARY REPORT`);
    console.log(`=================================================`);
    console.log(`Total Execution Time: ${durationSec} seconds`);
    console.log(`Total URLs Discovered: ${allDiscoveredUrls.length}`);
    console.log(`  - Lebensmittel URLs:         ${urlStats['Lebensmittel']}`);
    console.log(`  - Haushalt & Freizeit URLs:  ${urlStats['Haushalt & Freizeit']}`);
    console.log(`  - Weinwelt URLs:             ${urlStats['Weinwelt']}`);
    console.log(`-------------------------------------------------`);
    console.log(`Total Successful Products Extracted: ${products.length}`);
    console.log(`  - Lebensmittel Products:         ${shopSuccessStats['Lebensmittel']}`);
    console.log(`  - Haushalt & Freizeit Products:  ${shopSuccessStats['Haushalt & Freizeit']}`);
    console.log(`  - Weinwelt Products:             ${shopSuccessStats['Weinwelt']}`);
    console.log(`-------------------------------------------------`);
    console.log(`Total Failed Product URLs: ${failedRecordsStore.length}`);
    console.log(`  - Lebensmittel Failures:         ${shopFailedStats['Lebensmittel']}`);
    console.log(`  - Haushalt & Freizeit Failures:  ${shopFailedStats['Haushalt & Freizeit']}`);
    console.log(`  - Weinwelt Failures:             ${shopFailedStats['Weinwelt']}`);
    console.log(`=================================================\n`);

    return {
        products,
        failedRecords: failedRecordsStore
    };
}

module.exports = {
    run,
    getFailedRecords,
    siteName,
    siteSlug
};
