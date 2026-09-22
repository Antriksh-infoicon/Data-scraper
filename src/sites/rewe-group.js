/**
 * Website Scraper Module for REWE Group Austria (https://rewe-group.at)
 *
 * Requirements & Architecture:
 * 1. Crawls https://rewe-group.at/ and discovers all publicly accessible:
 *    - Product-related pages, brand pages, corporate newsroom articles
 *    - Public PDF documents linked from pages
 *    - Content mentioning retail brands: BILLA, BILLA PLUS, BIPA, PENNY, ADEG, Ja! Natürlich, Clever
 * 2. rewe-group.at is primarily a corporate website; does NOT manufacture fake e-commerce data.
 * 3. Extracts available metadata (title, description, brand, retail brand, image, campaign, etc.).
 * 4. Tracks failure details in data/rewe-group_failed.csv.
 * 5. Exports successful records to data/rewe-group.csv and data/rewe-group.xlsx.
 * 6. Prints formatted REWE GROUP SCRAPING SUMMARY at the end of execution.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { XMLParser } = require('fast-xml-parser');
const { cleanText, sleep } = require('../utils');

// Optional Puppeteer fallback if needed for JS rendering
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

const siteName = 'REWE Group Austria';
const siteSlug = 'rewe-group';
const BASE_URL = 'https://rewe-group.at';
const SITEMAP_INDEX = 'https://rewe-group.at/sitemap.xml';

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
 * Record a failed URL with full audit classification.
 */
function recordFailure({ name = '', productUrl, sourceUrl = '', retailBrand = 'REWE Group', statusCode = 0, errorType = 'UNKNOWN_ERROR', errorMessage = '', failureReason = 'Unknown Error', retryAttempts = 1 }) {
    failedRecordsStore.push({
        name: cleanText(name) || extractSlugFromUrl(productUrl),
        productUrl,
        sourceUrl,
        retailBrand,
        statusCode: statusCode || 0,
        errorType,
        errorMessage: cleanText(errorMessage),
        failureReason,
        retryAttempts
    });
}

/**
 * Helper to extract a readable slug/name from a URL
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
 * Classifies HTTP and network errors into standardized reasons
 */
function classifyError(err, statusCode = 0) {
    if (statusCode === 404) return { type: '404_NOT_FOUND', reason: '404' };
    if (statusCode === 403) return { type: '403_FORBIDDEN', reason: '403' };
    if (statusCode === 429) return { type: '429_RATE_LIMIT', reason: '429' };
    if (statusCode >= 400 && statusCode < 500) return { type: `HTTP_${statusCode}`, reason: '4xx Client Error' };
    if (statusCode >= 500) return { type: `HTTP_${statusCode}`, reason: '5xx Server Error' };
    
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('etimedout')) return { type: 'TIMEOUT', reason: 'Timeout' };
    if (msg.includes('parse') || msg.includes('json') || msg.includes('cheerio')) return { type: 'PARSING_ERROR', reason: 'Parsing error' };
    
    return { type: 'OTHER_ERROR', reason: 'Other' };
}

// ─── Retail Brand Detection ────────────────────────────────────────────────

function detectRetailBrand(text = '', url = '') {
    const combined = (text + ' ' + url).toUpperCase();
    if (combined.includes('BILLA PLUS') || combined.includes('BILLA-CORSO')) return 'BILLA PLUS';
    if (combined.includes('BILLA')) return 'BILLA';
    if (combined.includes('BIPA')) return 'BIPA';
    if (combined.includes('PENNY')) return 'PENNY';
    if (combined.includes('ADEG')) return 'ADEG';
    if (combined.includes('SUTTERLÜTY') || combined.includes('SUTTERLUETY')) return 'Sutterlüty';
    if (combined.includes('JA! NATÜRLICH') || combined.includes('JA NATUERLICH')) return 'Ja! Natürlich';
    if (combined.includes('CLEVER')) return 'Clever';
    return 'REWE Group';
}

// ─── Sitemap & Link Discovery ──────────────────────────────────────────────

/**
 * Discovers all publicly accessible URLs and linked PDF documents from rewe-group.at sitemaps.
 */
async function discoverUrlsFromSitemaps() {
    console.log(`[REWE-Group] Fetching sitemap index: ${SITEMAP_INDEX}...`);
    const parser = new XMLParser();
    const discovered = [];

    try {
        const res = await axios.get(SITEMAP_INDEX, { headers: HTTP_HEADERS, timeout: 15000 });
        const parsed = parser.parse(res.data);
        const subSitemaps = parsed.sitemapindex?.sitemap || [];
        const sitemapList = Array.isArray(subSitemaps) ? subSitemaps : [subSitemaps];

        console.log(`[REWE-Group] Discovered ${sitemapList.length} sub-sitemaps in index.`);

        for (const sitemapObj of sitemapList) {
            const subUrl = sitemapObj.loc;
            if (!subUrl) continue;
            try {
                const subRes = await axios.get(subUrl, { headers: HTTP_HEADERS, timeout: 15000 });
                const subParsed = parser.parse(subRes.data);
                const urlNodes = subParsed.urlset?.url || [];
                const list = Array.isArray(urlNodes) ? urlNodes : [urlNodes];

                for (const node of list) {
                    if (node.loc) {
                        discovered.push({
                            url: node.loc,
                            sourceUrl: subUrl,
                            isPdf: node.loc.toLowerCase().endsWith('.pdf')
                        });
                    }
                }
            } catch (err) {
                console.error(`[REWE-Group] Error fetching sub-sitemap ${subUrl}:`, err.message);
                recordFailure({
                    productUrl: subUrl,
                    sourceUrl: SITEMAP_INDEX,
                    retailBrand: 'REWE Group',
                    statusCode: err.response?.status || 0,
                    errorType: 'SITEMAP_ERROR',
                    errorMessage: err.message,
                    failureReason: classifyError(err, err.response?.status).reason,
                    retryAttempts: 1
                });
            }
        }

    } catch (err) {
        console.error(`[REWE-Group] Failed to fetch sitemap index:`, err.message);
        recordFailure({
            productUrl: SITEMAP_INDEX,
            sourceUrl: BASE_URL,
            retailBrand: 'REWE Group',
            statusCode: err.response?.status || 0,
            errorType: 'SITEMAP_INDEX_ERROR',
            errorMessage: err.message,
            failureReason: classifyError(err, err.response?.status).reason,
            retryAttempts: 1
        });
    }

    // Fallback seed URLs if sitemap yields few URLs
    if (discovered.length === 0) {
        const seedUrls = [
            'https://rewe-group.at/de/unternehmen',
            'https://rewe-group.at/de/nachhaltigkeit',
            'https://rewe-group.at/de/newsroom',
            'https://rewe-group.at/en/company',
            'https://rewe-group.at/en/sustainability',
            'https://rewe-group.at/en/newsroom'
        ];
        seedUrls.forEach(url => discovered.push({ url, sourceUrl: BASE_URL, isPdf: false }));
    }

    return discovered;
}

// ─── Single Page / PDF Processor ──────────────────────────────────────────

async function processUrl(item, maxRetries = 3) {
    const { url, sourceUrl, isPdf } = item;
    let attempts = 0;
    let lastError = null;

    while (attempts < maxRetries) {
        attempts++;
        try {
            // Handle PDF documents
            if (isPdf || url.toLowerCase().endsWith('.pdf')) {
                const pdfRes = await axios.head(url, { headers: HTTP_HEADERS, timeout: 15000 });
                const statusCode = pdfRes.status;
                const fileName = extractSlugFromUrl(url);
                const retailBrand = detectRetailBrand(fileName, url);

                return {
                    name: cleanText(fileName.replace(/[-_]/g, ' ')),
                    brand: 'REWE Group',
                    retailBrand,
                    category: 'PDF Document / Publication',
                    subcategory: 'Public Document',
                    productUrl: url,
                    sourceUrl: sourceUrl || BASE_URL,
                    imageUrl: '',
                    price: '',
                    regularPrice: '',
                    salePrice: '',
                    description: `Public PDF document: ${fileName}`,
                    quantity: '',
                    ingredients: '',
                    ean: '',
                    productId: '',
                    availability: 'Public Document',
                    characteristics: 'PDF, Corporate Document',
                    campaign: '',
                    sourceCompany: 'REWE Group Austria'
                };
            }

            // Handle HTML pages
            const res = await axios.get(url, { headers: HTTP_HEADERS, timeout: 15000 });
            const statusCode = res.status;
            
            if (statusCode >= 400) {
                const errObj = classifyError(new Error(`HTTP status ${statusCode}`), statusCode);
                if (attempts >= maxRetries) {
                    recordFailure({
                        productUrl: url,
                        sourceUrl,
                        retailBrand: detectRetailBrand('', url),
                        statusCode,
                        errorType: errObj.type,
                        errorMessage: `HTTP status code ${statusCode}`,
                        failureReason: errObj.reason,
                        retryAttempts: attempts
                    });
                    return null;
                }
                await sleep(1000 * attempts);
                continue;
            }

            const $ = cheerio.load(res.data);

            // Check for additional PDF links on the page
            $('a[href*=".pdf"]').each((i, el) => {
                const pdfHref = $(el).attr('href');
                if (pdfHref) {
                    try {
                        const fullPdfUrl = new URL(pdfHref, url).toString();
                        // store PDF reference for discovery if needed
                    } catch (e) {}
                }
            });

            // Extract page metadata
            const title = $('h1').first().text().trim() || $('title').text().trim() || extractSlugFromUrl(url);
            const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
            const ogImage = $('meta[property="og:image"]').attr('content') || '';
            const bodyText = $('body').text();

            // Detect brands mentioned
            const retailBrand = detectRetailBrand(title + ' ' + metaDesc + ' ' + bodyText, url);

            // Extract JSON-LD if present
            let jsonLdBrand = '';
            let jsonLdType = '';
            $('script[type="application/ld+json"]').each((i, el) => {
                try {
                    const data = JSON.parse($(el).text());
                    if (data['@type']) jsonLdType = data['@type'];
                    if (data.name) jsonLdBrand = data.name;
                } catch (e) {}
            });

            // Section / Category determination
            let category = 'Corporate Information';
            let subcategory = '';

            if (url.includes('/newsroom/')) {
                category = 'Newsroom Article';
            } else if (url.includes('/nachhaltigkeit/') || url.includes('/sustainability/')) {
                category = 'Sustainability';
            } else if (url.includes('/unternehmen/') || url.includes('/company/')) {
                category = 'Company Overview';
            }

            // Price / Promotion detection in article text if available (e.g., "1 Euro", "1,99 €")
            let price = '';
            const priceMatch = (title + ' ' + metaDesc).match(/(\d+(?:[\.,]\d{2})?\s*€|\b\d+\s*Euro\b)/i);
            if (priceMatch) {
                price = cleanText(priceMatch[1]);
            }

            return {
                name: cleanText(title),
                brand: jsonLdBrand || 'REWE Group',
                retailBrand,
                category,
                subcategory,
                productUrl: url,
                sourceUrl: sourceUrl || BASE_URL,
                imageUrl: ogImage ? new URL(ogImage, BASE_URL).toString() : '',
                price,
                regularPrice: '',
                salePrice: '',
                description: cleanText(metaDesc || title),
                quantity: '',
                ingredients: '',
                ean: '',
                productId: '',
                availability: 'Public Information',
                characteristics: jsonLdType || 'Corporate Page',
                campaign: price ? 'Promotional / Campaign Mention' : '',
                sourceCompany: 'REWE Group Austria'
            };

        } catch (err) {
            lastError = err;
            const statusCode = err.response?.status || 0;
            const errObj = classifyError(err, statusCode);

            if (attempts >= maxRetries) {
                recordFailure({
                    name: extractSlugFromUrl(url),
                    productUrl: url,
                    sourceUrl,
                    retailBrand: detectRetailBrand('', url),
                    statusCode,
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

async function run(options = {}) {
    const startTime = Date.now();
    console.log(`\n=================================================`);
    console.log(`  STARTING SCRAPER FOR: ${siteName}`);
    console.log(`=================================================\n`);
    console.log(`Note: rewe-group.at is primarily a corporate website for REWE Group in Austria.`);
    console.log(`Scanning publicly accessible pages, newsroom articles, PDFs, and brand content...\n`);

    // Step 1: Discover URLs from Sitemaps
    const discovered = await discoverUrlsFromSitemaps();

    // Deduplicate URLs
    const uniqueMap = new Map();
    discovered.forEach(item => {
        if (item.url && !uniqueMap.has(item.url)) {
            uniqueMap.set(item.url, item);
        }
    });

    const uniqueItems = Array.from(uniqueMap.values());
    console.log(`[REWE-Group] Total Discovered URLs: ${discovered.length} | Unique URLs: ${uniqueItems.length}`);

    const targetItems = options.limit ? uniqueItems.slice(0, options.limit) : uniqueItems;

    // Step 2: Process URLs
    const products = [];
    const brandCounts = {
        BILLA: 0,
        BIPA: 0,
        PENNY: 0,
        ADEG: 0,
        Other: 0
    };

    const failureReasonCounts = {
        '404': 0,
        '403': 0,
        '429': 0,
        'Timeout': 0,
        'Parsing error': 0,
        'Other': 0
    };

    let processedCount = 0;
    for (const item of targetItems) {
        processedCount++;
        if (processedCount % 50 === 0 || processedCount === targetItems.length) {
            console.log(`[REWE-Group] Processing URL ${processedCount}/${targetItems.length} (${Math.round((processedCount / targetItems.length) * 100)}%)...`);
        }

        const record = await processUrl(item);
        if (record) {
            products.push(record);

            // Track brand breakdown
            const rb = record.retailBrand;
            if (rb.includes('BILLA')) brandCounts.BILLA++;
            else if (rb.includes('BIPA')) brandCounts.BIPA++;
            else if (rb.includes('PENNY')) brandCounts.PENNY++;
            else if (rb.includes('ADEG')) brandCounts.ADEG++;
            else brandCounts.Other++;
        }

        await sleep(options.delay || 100);
    }

    // Tally failure reason counts
    failedRecordsStore.forEach(f => {
        const reason = f.failureReason || 'Other';
        if (failureReasonCounts[reason] !== undefined) {
            failureReasonCounts[reason]++;
        } else {
            failureReasonCounts['Other']++;
        }
    });

    const successCount = products.length;
    const failedCount = failedRecordsStore.length;
    const totalCount = uniqueItems.length;
    const successRate = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;

    // Step 3: Print REWE GROUP SCRAPING SUMMARY Report
    console.log(`\nREWE GROUP SCRAPING SUMMARY`);
    console.log(`---------------------------`);
    console.log(`Product/product-related URLs discovered: ${discovered.length}`);
    console.log(`Unique URLs: ${uniqueItems.length}`);
    console.log(`Successfully scraped: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Success rate: ${successRate}%`);
    console.log(``);
    console.log(`Retail brands discovered:`);
    console.log(`BILLA: ${brandCounts.BILLA}`);
    console.log(`BIPA: ${brandCounts.BIPA}`);
    console.log(`PENNY: ${brandCounts.PENNY}`);
    console.log(`ADEG: ${brandCounts.ADEG}`);
    console.log(`Other: ${brandCounts.Other}`);
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
    console.log(`data/rewe-group.csv`);
    console.log(`data/rewe-group.xlsx`);
    console.log(`data/rewe-group_failed.csv`);
    console.log(`\nNotice: rewe-group.at is primarily a corporate website and no direct e-commerce product catalog was found on the corporate domain.\n`);

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
