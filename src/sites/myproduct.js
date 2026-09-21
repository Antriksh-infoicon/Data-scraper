/**
 * Website Scraper Module for myProduct.at (https://www.myproduct.at)
 * 
 * Features:
 * - Category & Subcategory discovery (Lebensmittel, Mode, Geschenke, Wohnen & Freizeit, Gutscheine, etc.)
 * - Full pagination handling (?p=1, ?p=2, ... ?p=N)
 * - Complete product URL discovery & deduplication
 * - Deep Product Detail Page (PDP) extraction (18+ available fields)
 * - Request delays & rate limiting
 * - Outputs to data/myproduct.csv and data/myproduct.xlsx
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { cleanText, sleep } = require('../utils');

const siteName = 'myProduct.at';
const siteSlug = 'myproduct';

// User-Agent to avoid bot blocking
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
};

// Main root hub URLs to discover subcategories from
const ROOT_CATEGORIES = [
    { url: 'https://www.myproduct.at/lebensmittel', name: 'Lebensmittel' },
    { url: 'https://www.myproduct.at/mode', name: 'Mode' },
    { url: 'https://www.myproduct.at/geschenke', name: 'Geschenke' },
    { url: 'https://www.myproduct.at/wohnen-freizeit', name: 'Wohnen & Freizeit' },
    { url: 'https://www.myproduct.at/gutscheine', name: 'Gutscheine' }
];

/**
 * Step 1: Discover all valid category & subcategory listing URLs across myProduct.at
 */
async function discoverCategories() {
    console.log(`\n[${siteSlug}] Discovering category & subcategory URLs...`);
    const categoryMap = new Map(); // url -> name

    // Add root categories
    ROOT_CATEGORIES.forEach(c => categoryMap.set(c.url, c.name));

    // Crawl root pages and homepage to extract subcategory links
    const checkPages = ['https://www.myproduct.at/', ...ROOT_CATEGORIES.map(c => c.url)];

    for (const pageUrl of checkPages) {
        try {
            const res = await axios.get(pageUrl, { headers: HTTP_HEADERS, timeout: 10000 });
            const $ = cheerio.load(res.data);

            $('a[href]').each((i, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                let fullUrl = href.startsWith('/') ? 'https://www.myproduct.at' + href : href;
                fullUrl = fullUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');

                const linkText = cleanText($(el).text());

                // Filter out non-category paths
                if (
                    fullUrl.startsWith('https://www.myproduct.at/') &&
                    !fullUrl.includes('/customer/') &&
                    !fullUrl.includes('/checkout/') &&
                    !fullUrl.includes('/catalogsearch/') &&
                    !fullUrl.includes('/cart/') &&
                    !fullUrl.includes('.html') &&
                    !fullUrl.includes('datenschutz') &&
                    !fullUrl.includes('kontakt') &&
                    !fullUrl.includes('support') &&
                    !fullUrl.includes('ueberuns') &&
                    !fullUrl.includes('jobs') &&
                    !fullUrl.includes('b2b') &&
                    !fullUrl.includes('prime') &&
                    !fullUrl.includes('zahlungsarten') &&
                    !fullUrl.includes('agb') &&
                    !fullUrl.includes('impressum') &&
                    fullUrl !== 'https://www.myproduct.at'
                ) {
                    if (!categoryMap.has(fullUrl)) {
                        categoryMap.set(fullUrl, linkText || 'Kategorie');
                    }
                }
            });
        } catch (e) {
            // Ignore temporary page errors during link extraction
        }
    }

    // Validate category candidate URLs (must return 200 OK and not be a 404 dead link)
    const validCategories = [];
    console.log(`[${siteSlug}] Validating ${categoryMap.size} discovered category candidate URLs...`);

    for (const [url, name] of categoryMap.entries()) {
        try {
            const res = await axios.get(url, { headers: HTTP_HEADERS, timeout: 8000 });
            const $ = cheerio.load(res.data);
            
            // Check if page contains product listing cards or pagination
            const cardCount = $('.product-item, .product-item-info, li.item.product, .product-item-details').length;
            
            // Extract pagination max page if present
            let maxPage = 1;
            const pagText = $('.pages, .pagination').text().replace(/\s+/g, ' ');
            const match = pagText.match(/\/\s*(\d+)/);
            if (match) {
                maxPage = parseInt(match[1], 10);
            }

            if (cardCount > 0 || maxPage > 1) {
                validCategories.push({ url, name, maxPage });
            }
            await sleep(100);
        } catch (e) {
            // Ignore 404 or invalid subcategory links
        }
    }

    console.log(`[${siteSlug}] Found ${validCategories.length} active category listing URLs.`);
    return validCategories;
}

/**
 * Step 2: Collect & deduplicate product URLs across all category listing pages (with pagination handling)
 */
async function collectProductUrls(categories, limit = null) {
    console.log(`\n[${siteSlug}] Collecting product URLs from ${categories.length} category listings...`);
    const productUrlMap = new Map(); // productUrl -> categoryName

    for (let i = 0; i < categories.length; i++) {
        if (limit && productUrlMap.size >= limit) break;

        const cat = categories[i];
        console.log(`[${siteSlug}] Category [${i + 1}/${categories.length}]: ${cat.name} (${cat.url}) | Max Pages: ${cat.maxPage}`);

        let consecutiveEmptyPages = 0;

        for (let page = 1; page <= cat.maxPage; page++) {
            if (limit && productUrlMap.size >= limit) break;

            const pageUrl = page === 1 ? cat.url : `${cat.url}?p=${page}`;
            try {
                const res = await axios.get(pageUrl, { headers: HTTP_HEADERS, timeout: 10000 });
                const $ = cheerio.load(res.data);

                let pageProductsFound = 0;

                $('.product-item, .product-item-info, li.item.product, .product-item-details').each((idx, el) => {
                    if (limit && productUrlMap.size >= limit) return;

                    const a = $(el).find('a.product-item-link, a.product-item-photo, a').first();
                    const href = a.attr('href');
                    if (href) {
                        let fullUrl = href.startsWith('/') ? 'https://www.myproduct.at' + href : href;
                        fullUrl = fullUrl.split('?')[0].split('#')[0];

                        // Ensure it is a valid product detail page URL (not a search or category page)
                        if (
                            fullUrl.startsWith('https://myproduct.at/') ||
                            fullUrl.startsWith('https://www.myproduct.at/')
                        ) {
                            if (
                                !fullUrl.includes('/customer/') &&
                                !fullUrl.includes('/checkout/') &&
                                !fullUrl.includes('/catalog/') &&
                                !fullUrl.includes('?p=')
                            ) {
                                if (!productUrlMap.has(fullUrl)) {
                                    productUrlMap.set(fullUrl, {
                                        categoryName: cat.name,
                                        sourceCategoryUrl: pageUrl
                                    });
                                    pageProductsFound++;
                                }
                            }
                        }
                    }
                });

                console.log(`   Page ${page}/${cat.maxPage}: Found ${pageProductsFound} new products. Total unique so far: ${productUrlMap.size}`);
                
                if (pageProductsFound === 0) {
                    consecutiveEmptyPages++;
                    if (consecutiveEmptyPages >= 3 && page > 3) {
                        console.log(`   [Optimization] Skipping remaining pages for ${cat.name} after 3 consecutive pages with no new products.`);
                        break;
                    }
                } else {
                    consecutiveEmptyPages = 0;
                }

                await sleep(150);

            } catch (e) {
                console.error(`   Error scraping listing page ${pageUrl}:`, e.message);
            }
        }
    }

    console.log(`\n[${siteSlug}] Total unique product URLs discovered: ${productUrlMap.size}`);
    return productUrlMap;
}

/**
 * Step 3: Scrape individual Product Detail Page (PDP) for full attributes
 */
async function scrapeProductDetail(productUrl, categoryInfo) {
    try {
        const res = await axios.get(productUrl, { headers: HTTP_HEADERS, timeout: 12000 });
        const $ = cheerio.load(res.data);

        // 1. Product Name
        const name = cleanText($('.page-title span, h1.page-title, h1').first().text()) ||
                     cleanText($('meta[property="og:title"]').attr('content')) || '';

        if (!name) return null; // Skip if empty invalid page

        // 2. Category
        let category = categoryInfo ? categoryInfo.categoryName : 'General';
        const breadcrumbList = [];
        $('.breadcrumbs li, .breadcrumb li').each((i, el) => {
            const txt = cleanText($(el).text());
            if (txt && txt !== '/') breadcrumbList.push(txt);
        });
        if (breadcrumbList.length > 2) {
            category = breadcrumbList.slice(1, -1).join(' > ');
        }

        // 3. Image URL
        const imageUrl = $('meta[property="og:image"]').attr('content') ||
                         $('.fotorama__img, .gallery-placeholder img').first().attr('src') || '';

        // 4. Prices
        let price = '';
        let salePrice = '';
        let regularPrice = '';

        const specialPriceText = cleanText($('.special-price .price').first().text());
        const oldPriceText = cleanText($('.old-price .price').first().text());
        const normalPriceText = cleanText($('.price-final_price .price, .normal-price .price, .price-box .price').first().text());

        if (specialPriceText) {
            salePrice = specialPriceText;
            regularPrice = oldPriceText;
            price = salePrice;
        } else {
            price = normalPriceText || oldPriceText;
            regularPrice = price;
            salePrice = '';
        }

        // Unit Price (e.g. € 2,94 / kg)
        const unitPrice = cleanText($('.price-unit, .unit-price, .price-per-unit').first().text());

        // 5. Product Specification Table (Brand, EAN, SKU, Country, Weight, Manufacturer)
        let brand = '';
        let ean = '';
        let sku = '';
        let country = '';
        let quantity = '';
        let manufacturer = '';

        $('.data.table.additional-attributes tr, table.data.table tr, tr').each((i, el) => {
            const th = cleanText($(el).find('th').text()).toLowerCase();
            const td = cleanText($(el).find('td').text());

            if (th.includes('produzent') && !th.includes('land')) brand = td;
            if (th.includes('ean')) ean = td;
            if (th.includes('sku')) sku = td;
            if (th.includes('produzent land') || th.includes('herkunftsland')) country = td;
            if (th.includes('produktmenge') || th.includes('nettofüllmenge') || th.includes('gewicht')) quantity = td;
            if (th.includes('herstellerangaben') || th.includes('hersteller')) manufacturer = td;
        });

        // 6. Availability
        let availability = cleanText($('.stock.available span, .stock.available, [title="Availability"]').first().text());
        if (!availability) {
            if ($('button#product-addtocart-button').length > 0 || $('.action.primary.tocart').length > 0) {
                availability = 'Lieferbar / Auf Lager';
            }
        }

        // 7. Product Description & Ingredients
        const description = cleanText($('.product.attribute.description .value, #description, .description').first().text()) ||
                            cleanText($('meta[name="description"]').attr('content')) || '';

        let ingredients = '';
        $('.product.attribute.ingredients .value, #ingredients, .ingredients, tr:contains("Zutaten") td').each((i, el) => {
            const txt = cleanText($(el).text());
            if (txt) ingredients = txt;
        });

        return {
            name,
            category,
            productUrl,
            imageUrl,
            price,
            salePrice,
            regularPrice,
            unitPrice,
            brand,
            sku,
            ean,
            country,
            quantity,
            manufacturer,
            availability,
            sourceUrl: categoryInfo ? categoryInfo.sourceCategoryUrl : '',
            description,
            ingredients
        };

    } catch (e) {
        return null;
    }
}

/**
 * Main scraper execution function for myProduct.at
 * 
 * @param {Object} options - Scraper execution options
 * @param {number} [options.limit] - Limit total products for testing (e.g. 5)
 */
async function run(options = {}) {
    console.log(`\n=================================================`);
    console.log(`   STARTING SCRAPER FOR: ${siteName} (${siteSlug})`);
    console.log(`=================================================\n`);

    const limit = options.limit || null;

    // 1. Discover category URLs
    const categories = await discoverCategories();

    // 2. Collect product URLs
    const productUrlMap = await collectProductUrls(categories, limit);
    const totalProductUrlsFound = productUrlMap.size;

    const products = [];
    let successfulCount = 0;
    let failedCount = 0;

    const CONCURRENCY = 5;
    const entries = Array.from(productUrlMap.entries());
    let currentIndex = 0;

    console.log(`[${siteSlug}] Running PDP extraction with ${CONCURRENCY} concurrent workers...`);

    async function worker(workerId) {
        while (currentIndex < entries.length) {
            const idx = currentIndex++;
            const [productUrl, catInfo] = entries[idx];

            const countNum = idx + 1;
            if (countNum === 1 || countNum % 50 === 0 || countNum === totalProductUrlsFound) {
                console.log(`[${siteSlug}] Progress: [${countNum}/${totalProductUrlsFound}] (${Math.round((countNum / totalProductUrlsFound) * 100)}%) scraped...`);
            }

            const item = await scrapeProductDetail(productUrl, catInfo);

            if (item) {
                products.push(item);
                successfulCount++;
            } else {
                failedCount++;
            }

            await sleep(150);
        }
    }

    const workers = [];
    for (let w = 0; w < CONCURRENCY; w++) {
        workers.push(worker(w + 1));
    }
    await Promise.all(workers);

    console.log(`\n=================================================`);
    console.log(`   SCRAPE SUMMARY FOR ${siteName}`);
    console.log(`=================================================`);
    console.log(`- Total Product URLs Found:       ${totalProductUrlsFound}`);
    console.log(`- Total Unique Products Scraped:  ${products.length}`);
    console.log(`- Products Successfully Scraped:  ${successfulCount}`);
    console.log(`- Products Failed:               ${failedCount}`);
    console.log(`=================================================\n`);

    return products;
}

module.exports = {
    siteName,
    siteSlug,
    run
};
