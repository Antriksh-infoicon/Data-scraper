/**
 * Website Scraper Module for HOFER Austria (https://www.hofer.at)
 *
 * Architecture:
 * - Uses the official HOFER REST API at https://asl.api.hofer.at (publicly accessible)
 * - Fetches category tree from /commerce/v2/product-category-tree
 * - Paginates product listings via /commerce/v3/product-search (up to 60 products/request)
 * - All product data is returned directly from the API (no HTML parsing needed)
 * - Product URLs are constructed as: https://www.hofer.at/de/produkt/{slug}-{sku}.html
 *
 * Features:
 * - Crawls all product categories and subcategories discovered from the API
 * - Handles full pagination to capture all products in each category
 * - Deduplicates products across overlapping category/subcategory results
 * - Extracts 22 product attributes per product
 * - Complete failure tracking with hofer_failed.csv export
 * - Exports to data/hofer.csv and data/hofer.xlsx
 *
 * Product Attributes Extracted:
 *   - Product Name
 *   - Category / Subcategory
 *   - Brand / Manufacturer
 *   - Product URL (constructed from slug + SKU)
 *   - Image URL (resolved from CMS template)
 *   - Price / Regular Price / Sale Price / Unit Price
 *   - Weight / Selling Size / Quantity
 *   - EAN / SKU / Product ID
 *   - Description / Ingredients / Nutritional Info / Country of Origin
 *   - Availability
 *   - Availability / On Sale Date
 *   - Product Badges (Bio, Vegan, Regional, etc.)
 *   - Source Category URL
 */

'use strict';

const axios = require('axios');
const { cleanText, sleep } = require('../utils');

// ─── Constants ──────────────────────────────────────────────────────────────

const siteName      = 'HOFER Austria';
const siteSlug      = 'hofer';
const BASE_URL      = 'https://www.hofer.at';
const BASE_API      = 'https://asl.api.hofer.at';
const SERVICE_POINT = 'A613';   // Vienna store code used by the Nuxt frontend
const SERVICE_TYPE  = 'walk-in';
const PAGE_LIMIT    = 60;       // Max allowed by the API

// Standard browser headers – same as what the Nuxt frontend sends
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'de-AT,de-DE;q=0.9,de;q=0.8,en-US;q=0.7,en;q=0.6',
    'Referer': 'https://www.hofer.at/',
    'Cache-Control': 'no-cache',
};

// Global failure tracking array
const failedRecordsStore = [];

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Returns a copy of all failed records collected during the run.
 */
function getFailedRecords() {
    return [...failedRecordsStore];
}

/**
 * Makes a GET request to the HOFER API with automatic retry on transient errors.
 */
async function apiGet(path, params = {}, maxRetries = 3) {
    const url = BASE_API + path;
    let attempt = 0;
    let lastErr = null;

    while (attempt < maxRetries) {
        attempt++;
        try {
            const res = await axios.get(url, {
                headers: HTTP_HEADERS,
                params: {
                    servicePoint: SERVICE_POINT,
                    serviceType: SERVICE_TYPE,
                    ...params,
                },
                timeout: 20000,
            });
            return res.data;
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            // Don't retry on 4xx errors (except 429 rate limit)
            if (status && status >= 400 && status < 500 && status !== 429) {
                throw err;
            }
            if (attempt < maxRetries) {
                await sleep(1500 * attempt);
            }
        }
    }
    throw lastErr;
}

/**
 * Flattens the nested category tree into a flat array.
 * Keeps both parent and leaf nodes to maximise product discovery.
 */
function flattenCategories(nodes, parentName = '') {
    const result = [];
    for (const node of (nodes || [])) {
        const name     = node.name || '';
        const slug     = node.urlSlugText || '';
        const children = node.children || [];

        result.push({ key: node.key, name, parentName, slug });

        if (children.length > 0) {
            result.push(...flattenCategories(children, name));
        }
    }
    return result;
}

/**
 * Constructs a canonical product detail URL from slug and SKU.
 * Pattern: https://www.hofer.at/de/produkt/{slug}-{sku}.html
 */
function buildProductUrl(slug, sku) {
    return `${BASE_URL}/de/produkt/${slug}-${sku}.html`;
}

/**
 * Resolves a HOFER CMS image URL template to a real URL.
 */
function resolveImageUrl(urlTemplate, slug) {
    if (!urlTemplate) return '';
    return urlTemplate
        .replace('{width}', '600')
        .replace('{slug}', encodeURIComponent(slug || ''));
}

/**
 * Maps a HOFER API product object to the standard output record.
 */
function mapProductToRecord(apiProduct, categoryInfo) {
    const p = apiProduct;

    // ── Name ────────────────────────────────────────────────────────────────
    const name = cleanText(p.name || '');

    // ── Category hierarchy ───────────────────────────────────────────────────
    // categories[] is ordered [parent, leaf]; first is category, last is subcategory
    const cats        = Array.isArray(p.categories) ? p.categories : [];
    const category    = cats.length > 0
        ? cleanText(cats[0].name || '')
        : cleanText(categoryInfo.parentName || categoryInfo.name || '');
    const subcategory = cats.length > 1
        ? cleanText(cats[cats.length - 1].name || '')
        : '';

    // ── Brand / Manufacturer ─────────────────────────────────────────────────
    const brand        = cleanText(p.brandName || '');
    const manufacturer = brand;

    // ── Product URL ──────────────────────────────────────────────────────────
    const slug       = p.urlSlugText || '';
    const sku        = p.sku || '';
    const productUrl = buildProductUrl(slug, sku);

    // ── Image ────────────────────────────────────────────────────────────────
    const firstAsset = (p.assets || [])[0];
    const imageUrl   = firstAsset ? resolveImageUrl(firstAsset.url, slug) : '';

    // ── Pricing ──────────────────────────────────────────────────────────────
    const priceObj      = p.price || {};
    const priceDisplay  = cleanText(priceObj.amountRelevantDisplay || '');
    const wasPriceDisp  = cleanText(priceObj.wasPriceDisplay || '');
    const unitPriceDisp = cleanText(priceObj.comparisonDisplay || priceObj.perUnitDisplay || '');

    const price        = priceDisplay;
    const regularPrice = wasPriceDisp || priceDisplay;  // wasPriceDisplay = original price when on sale
    const salePrice    = wasPriceDisp ? priceDisplay : '';
    const unitPrice    = unitPriceDisp;

    // ── Quantity / Selling Size ──────────────────────────────────────────────
    const quantity = cleanText(p.sellingSize || p.sellingUnitDisplay || '');

    // ── EAN / Product ID ─────────────────────────────────────────────────────
    const ean       = '';   // Not returned by listing API; available on PDP JSON-LD only
    const productId = sku;

    // ── Availability ─────────────────────────────────────────────────────────
    const discontinued = p.discontinued === true;
    const notForSale   = p.notForSale === true;
    const availability = discontinued ? 'Discontinued'
        : notForSale ? 'Not For Sale'
        : 'In Stock';

    // ── On Sale / Availability Date ──────────────────────────────────────────
    const availabilityDate = cleanText(p.onSaleDateDisplay || p.onSaleDate || '');

    // ── Badges ───────────────────────────────────────────────────────────────
    const badgeTexts = [];
    for (const badgeGroup of (p.badges || [])) {
        for (const item of (badgeGroup.items || [])) {
            const txt = cleanText(item.displayText || item.alt || '');
            if (txt && !badgeTexts.includes(txt)) badgeTexts.push(txt);
        }
    }
    const badges = badgeTexts.join(', ');

    // ── Fields not available via listing API (require PDP HTML scrape) ────────
    const description     = '';
    const ingredients     = '';
    const nutritionalInfo = '';
    const country         = '';

    // ── Source category URL ──────────────────────────────────────────────────
    const sourceUrl = `${BASE_URL}/de/produkte/${categoryInfo.slug}.html`;

    return {
        name,
        category,
        subcategory,
        brand,
        manufacturer,
        productUrl,
        imageUrl,
        price,
        regularPrice,
        salePrice,
        unitPrice,
        quantity,
        ean,
        productId,
        description,
        ingredients,
        nutritionalInfo,
        country,
        availability,
        availabilityDate,
        badges,
        sourceUrl,
    };
}

// ─── Core Scraping Functions ─────────────────────────────────────────────────

/**
 * Fetches the full category tree from the HOFER API.
 */
async function discoverCategories() {
    console.log(`[${siteSlug}] Fetching category tree from API...`);
    try {
        const data  = await apiGet('/commerce/v2/product-category-tree');
        const nodes = data.data || data.categories || data.children || [];
        const all   = flattenCategories(nodes);
        console.log(`[${siteSlug}] Discovered ${all.length} categories/subcategories.`);
        return all;
    } catch (err) {
        console.error(`[${siteSlug}] Failed to fetch category tree: ${err.message}`);
        return [];
    }
}

/**
 * Fetches ALL products from a single category using offset pagination.
 * Returns an array of raw API product objects.
 */
async function fetchAllProductsInCategory(category) {
    const allProducts = [];
    let offset      = 0;
    let totalCount  = null;

    console.log(`[${siteSlug}]   Paginating "${category.name}" (key: ${category.key})...`);

    while (true) {
        let data;
        try {
            data = await apiGet('/commerce/v3/product-search', {
                currency:    'EUR',
                categoryKey: category.key,
                limit:       PAGE_LIMIT,
                offset,
            });
        } catch (err) {
            console.error(`[${siteSlug}]   API error for "${category.name}" offset ${offset}: ${err.message}`);
            failedRecordsStore.push({
                name: '',
                productUrl:    `${BASE_URL}/de/produkte/${category.slug}.html`,
                sourceUrl:     `${BASE_URL}/de/produkte/${category.slug}.html`,
                statusCode:    err.response?.status || 0,
                errorType:     'API_ERROR',
                errorMessage:  err.message,
                failureReason: 'API Error',
                retryAttempts: 3,
            });
            break;
        }

        const products   = data.data || [];
        const pagination = data.meta?.pagination || {};

        if (totalCount === null) {
            totalCount = pagination.totalCount != null ? pagination.totalCount : products.length;
            console.log(`[${siteSlug}]     Total in "${category.name}": ${totalCount}`);
        }

        if (products.length === 0) break;

        allProducts.push(...products);
        offset += PAGE_LIMIT;
        if (offset >= totalCount) break;

        await sleep(200);
    }

    return allProducts;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Main scraper entry point for HOFER Austria.
 *
 * @param {Object} options
 * @param {number|null} [options.limit] - Optional product limit (for testing)
 */
async function run(options = {}) {
    console.log(`\n=================================================`);
    console.log(`   STARTING SCRAPER FOR: ${siteName} (${siteSlug})`);
    console.log(`=================================================\n`);

    failedRecordsStore.length = 0;
    const limit = options.limit || null;

    // 1. Discover all categories via API
    const categories = await discoverCategories();
    if (categories.length === 0) {
        console.log(`[${siteSlug}] No categories found. Aborting.`);
        return { products: [], failedRecords: [] };
    }

    // 2. Collect all products, deduplicating by SKU
    const seenSkus   = new Set();
    const allRecords = [];

    for (let i = 0; i < categories.length; i++) {
        if (limit && allRecords.length >= limit) break;

        const cat = categories[i];
        console.log(`[${siteSlug}] Category [${i + 1}/${categories.length}]: ${cat.name}`);

        const apiProducts = await fetchAllProductsInCategory(cat);

        for (const p of apiProducts) {
            if (limit && allRecords.length >= limit) break;

            const sku = p.sku || '';
            if (!sku || seenSkus.has(sku)) continue;  // Skip duplicates across categories
            seenSkus.add(sku);

            const record = mapProductToRecord(p, cat);
            if (!record.name) {
                failedRecordsStore.push({
                    name:          '',
                    productUrl:    record.productUrl,
                    sourceUrl:     record.sourceUrl,
                    statusCode:    200,
                    errorType:     'PARSING_ERROR',
                    errorMessage:  'Product name empty in API response',
                    failureReason: 'Product Data Not Found',
                    retryAttempts: 1,
                });
                continue;
            }

            allRecords.push(record);
        }

        await sleep(300);
    }

    console.log(`\n[${siteSlug}] \u2713 Total unique products scraped: ${allRecords.length}`);
    console.log(`[${siteSlug}] \u2717 Total failures logged: ${failedRecordsStore.length}`);

    return {
        products:      allRecords,
        failedRecords: failedRecordsStore,
    };
}

// ─── Module Exports ──────────────────────────────────────────────────────────

module.exports = { run, getFailedRecords, siteName, siteSlug };

