/**
 * Website Scraper Module for tegut.com (https://www.tegut.com)
 *
 * How this scraper works (overview):
 * ───────────────────────────────────────────────────────────
 * tegut.com is a German grocery retailer that publishes its own-brand (Eigenmarken)
 * products on a paginated listing at:
 *   https://www.tegut.com/angebote-produkte/produkte/eigenmarken/alle/produkte-seite/{N}.html
 *
 * Each listing page shows ~24 product cards with links to individual product
 * detail pages structured like:
 *   https://www.tegut.com/angebote-produkte/produkte/eigenmarken/produkt/{slug}.html
 *
 * On the detail pages tegut provides:
 *   • Schema.org JSON-LD (Product type) → name, sku/EAN, image, description, brand
 *   • Plain HTML attributes → Füllmenge (fill quantity), EAN confirmation
 *   • Breadcrumb JSON-LD → category path
 *
 * Scrape strategy:
 *   Step 1 – Discover every listing page (page 0 → max page) and collect all
 *             unique product detail URLs.
 *   Step 2 – For each product URL fetch the detail page and extract all fields
 *             via JSON-LD + HTML parsing.
 *   Step 3 – Deduplicate by SKU / EAN, return final array.
 *
 * Outputs → data/tegut.csv and data/tegut.xlsx
 *
 * Features:
 *   - Polite request delays between pages to avoid overloading the server
 *   - Concurrent product-detail workers (5 at a time) for speed
 *   - HTML entity decoding for German umlauts (ä, ö, ü, ß …)
 *   - Graceful error handling: a failed request is counted and skipped
 */

const axios  = require('axios');   // HTTP client used to download pages
const cheerio = require('cheerio'); // HTML parser (jQuery-style selectors)
const { cleanText, sleep } = require('../utils'); // shared helpers

// ─── Site metadata (used by index.js orchestrator) ───────────────────────────
const siteName = 'tegut.com';   // Human-readable label shown in console output
const siteSlug = 'tegut';       // Used as the filename base → data/tegut.csv

// ─── Base URLs ────────────────────────────────────────────────────────────────
// This is the "Alle Produkte" (all products) listing URL base.
// Pages are numbered starting from 0; page 1 shows the second batch, etc.
const LISTING_BASE =
  'https://www.tegut.com/angebote-produkte/produkte/eigenmarken/alle/produkte-seite';

// The very first page (page 0) is treated as the "landing" category page.
// It already contains 24 products AND the total page count in its pagination.
const CATEGORY_LANDING =
  'https://www.tegut.com/angebote-produkte/produkte/eigenmarken/alle.html';

// The root category page is also used as the "sourceUrl" label for all products.
const SOURCE_CATEGORY_URL =
  'https://www.tegut.com/angebote-produkte/produkte/eigenmarken/alle.html';

// ─── HTTP headers ─────────────────────────────────────────────────────────────
// Mimicking a real browser to avoid 403 / bot-detection blocks.
const HTTP_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
  'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ─── HTML entity decoder ──────────────────────────────────────────────────────
/**
 * Converts HTML entities into proper Unicode characters so that scraped text
 * like "nat&uuml;rliches Mineralwasser" becomes "natürliches Mineralwasser".
 *
 * @param {string} str - Raw string that may contain HTML entities
 * @returns {string} - Clean text with HTML entities replaced
 */
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&auml;/g, 'ä').replace(/&Auml;/g, 'Ä')
    .replace(/&ouml;/g, 'ö').replace(/&Ouml;/g, 'Ö')
    .replace(/&uuml;/g, 'ü').replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

// ─── Step 1: Discover all product listing pages ───────────────────────────────
/**
 * Fetches the category landing page to read the total number of pagination pages,
 * then generates the full list of listing-page URLs to crawl.
 *
 * Why we need this:
 *   tegut uses server-side pagination: products are split across pages 0–38
 *   (approx 900+ products total). We must iterate all pages to find every product.
 *
 * @returns {Promise<string[]>} - Array of listing page URLs (e.g. page 0 … 38)
 */
async function discoverListingPages() {
  console.log(`\n[${siteSlug}] Fetching category landing page to find total pages...`);

  try {
    // Fetch the "Alle Produkte" root listing page
    const res = await axios.get(CATEGORY_LANDING, {
      headers: HTTP_HEADERS,
      timeout: 15000,
    });
    const $ = cheerio.load(res.data);

    // The pagination widget contains links like:
    //   /angebote-produkte/produkte/eigenmarken/alle/produkte-seite/38.html
    // We extract all page numbers and find the maximum.
    const pageNumbers = [];
    $('a[href*="produkte-seite"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/produkte-seite\/(\d+)\.html/);
      if (match) pageNumbers.push(parseInt(match[1], 10));
    });

    // Also collect product URLs already present on the landing page
    const landingProducts = new Set();
    $('a[href*="/produkt/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('/angebote-produkte/produkte/eigenmarken/produkt/')) {
        landingProducts.add('https://www.tegut.com' + href);
      }
    });

    const maxPage = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 0;
    console.log(`[${siteSlug}] Pagination: pages 0 to ${maxPage} (≈ ${(maxPage + 1) * 24} products)`);

    // Build the complete list of paginated listing URLs
    const listingUrls = [];
    for (let page = 0; page <= maxPage; page++) {
      listingUrls.push(`${LISTING_BASE}/${page}.html`);
    }

    return { listingUrls, landingProducts };
  } catch (err) {
    console.error(`[${siteSlug}] Error fetching landing page: ${err.message}`);
    // Fall back to a known safe range if the landing page fails
    const listingUrls = [];
    for (let page = 0; page <= 38; page++) {
      listingUrls.push(`${LISTING_BASE}/${page}.html`);
    }
    return { listingUrls, landingProducts: new Set() };
  }
}

// ─── Step 2: Collect product detail URLs ─────────────────────────────────────
/**
 * Iterates over all paginated listing pages and collects every unique
 * product detail URL found on those pages.
 *
 * Why deduplication is needed:
 *   tegut sometimes lists the same product in multiple sub-categories
 *   (e.g. "tegut... Bio" and "Alle Produkte"). Using a Set ensures we only
 *   visit each product detail page once.
 *
 * @param {string[]} listingUrls - All listing page URLs to crawl
 * @param {Set<string>} seedProducts - Product URLs already found on the landing page
 * @param {number|null} limit - If set, stop after finding this many product URLs
 * @returns {Promise<Set<string>>} - Deduplicated set of product detail page URLs
 */
async function collectProductUrls(listingUrls, seedProducts, limit = null) {
  console.log(`\n[${siteSlug}] Crawling ${listingUrls.length} listing pages to collect product URLs...`);

  // Start with products already found on the category landing page
  const productUrls = new Set(seedProducts);

  for (let i = 0; i < listingUrls.length; i++) {
    // Respect the optional limit for quick test runs
    if (limit && productUrls.size >= limit) {
      console.log(`[${siteSlug}] Limit of ${limit} reached. Stopping URL collection.`);
      break;
    }

    const pageUrl = listingUrls[i];
    console.log(
      `[${siteSlug}] Listing page [${i + 1}/${listingUrls.length}]: ${pageUrl} ` +
      `(collected so far: ${productUrls.size})`
    );

    try {
      const res = await axios.get(pageUrl, {
        headers: HTTP_HEADERS,
        timeout: 15000,
      });
      const $ = cheerio.load(res.data);

      // Every product card on the listing page has a link containing "/produkt/"
      // Example href: /angebote-produkte/produkte/eigenmarken/produkt/ingwer-kurkuma-shot.html
      $('a[href*="/produkt/"]').each((_, el) => {
        if (limit && productUrls.size >= limit) return; // stop if limit hit
        const href = $(el).attr('href') || '';
        if (href.includes('/angebote-produkte/produkte/eigenmarken/produkt/')) {
          const fullUrl = href.startsWith('http')
            ? href
            : 'https://www.tegut.com' + href;
          productUrls.add(fullUrl.split('?')[0].split('#')[0]); // strip query/hash
        }
      });

      // Polite delay so we don't hammer the server
      await sleep(200);

    } catch (err) {
      console.error(`[${siteSlug}] Error fetching listing page ${pageUrl}: ${err.message}`);
    }
  }

  console.log(`\n[${siteSlug}] Total unique product URLs collected: ${productUrls.size}`);
  return productUrls;
}

// ─── Step 3: Scrape individual product detail page ───────────────────────────
/**
 * Downloads a single product detail page and extracts all available fields.
 *
 * Data sources used (in priority order):
 *   1. JSON-LD <script type="application/ld+json"> block with @type="Product"
 *      → provides: name, description, sku/EAN, image URL, brand
 *   2. JSON-LD block with @type="BreadcrumbList"
 *      → provides: category path
 *   3. HTML content (Cheerio selectors)
 *      → provides: Füllmenge (quantity), EAN confirmation, price (if shown)
 *
 * @param {string} productUrl - Full URL of the product detail page
 * @returns {Promise<Object|null>} - Product data object, or null if scraping fails
 */
async function scrapeProductDetail(productUrl) {
  try {
    const res = await axios.get(productUrl, {
      headers: HTTP_HEADERS,
      timeout: 15000,
    });
    const $ = cheerio.load(res.data);

    // ── 1. Extract JSON-LD blocks ───────────────────────────────────────────
    // tegut embeds structured data as JSON-LD which is the most reliable
    // machine-readable data source on the page.
    let productJsonLd  = null; // Will hold the Product schema data
    let breadcrumbData = null; // Will hold the BreadcrumbList schema data

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw  = $(el).html() || '';
        const data = JSON.parse(raw);

        if (data['@type'] === 'Product') {
          productJsonLd = data;
        } else if (data['@type'] === 'BreadcrumbList') {
          breadcrumbData = data;
        }
      } catch (_parseErr) {
        // Some JSON-LD blocks may be malformed; skip silently
      }
    });

    // ── 2. Product Name ─────────────────────────────────────────────────────
    // Primary source: JSON-LD "name" field (most reliable)
    // Fallback: <h1> element on the page
    let name = '';
    if (productJsonLd && productJsonLd.name) {
      name = decodeHtmlEntities(productJsonLd.name);
    }
    if (!name) {
      name = decodeHtmlEntities(cleanText($('h1, h1.ce-headline, .product-title h1').first().text()));
    }
    name = decodeHtmlEntities(name);

    // If no name could be found, this is likely not a valid product page → skip
    if (!name) return null;

    // ── 3. Category (from BreadcrumbList) ──────────────────────────────────
    // The breadcrumb trail shows the full path, e.g.:
    //   Startseite > Angebote & Produkte > tegut... Eigenmarken > [Product Name]
    // We use the last breadcrumb item (closest to the product, deepest category).
    // If there are only 2 items (Startseite + product), we fall back to 'Eigenmarken'.
    let category = 'Eigenmarken'; // sensible default
    if (breadcrumbData && Array.isArray(breadcrumbData.itemListElement)) {
      const breadcrumbs = breadcrumbData.itemListElement
        .map(item => decodeHtmlEntities(item?.item?.name || item?.name || ''))
        .filter(Boolean);
      // Take the last breadcrumb item that is not the product name itself.
      // breadcrumbs[0] = Startseite, breadcrumbs[last] = usually the product page label
      // Best category is the second-to-last entry (the sub-brand / product group)
      if (breadcrumbs.length >= 3) {
        category = breadcrumbs[breadcrumbs.length - 2];
      } else if (breadcrumbs.length === 2) {
        category = breadcrumbs[1];
      }
    }

    // ── 4. Image URL ─────────────────────────────────────────────────────────
    // JSON-LD "image" is the highest-resolution product image.
    // Fallback: Open Graph <meta property="og:image"> tag.
    const imageUrl =
      (productJsonLd && productJsonLd.image) ||
      $('meta[property="og:image"]').attr('content') ||
      '';

    // ── 5. EAN / SKU ──────────────────────────────────────────────────────────
    // JSON-LD "sku" and "gtin13" both carry the EAN-13 barcode value.
    const ean =
      (productJsonLd && (productJsonLd.gtin13 || productJsonLd.sku)) || '';

    // ── 6. Brand ──────────────────────────────────────────────────────────────
    // Brand comes from JSON-LD nested object: { "brand": { "name": "..." } }
    let brand = '';
    if (productJsonLd && productJsonLd.brand) {
      if (typeof productJsonLd.brand === 'object') {
        brand = decodeHtmlEntities(productJsonLd.brand.name || '');
      } else {
        brand = decodeHtmlEntities(productJsonLd.brand);
      }
    }

    // Brand-based category fallback: tegut's JSON-LD "brand" often carries the product
    // group name (e.g. "Müsli und Cerealien", "Wasser") which is more descriptive than
    // the generic breadcrumb label "Angebote & Produkte" or "Eigenmarken".
    if (category === 'Eigenmarken' || category === 'Angebote & Produkte' || category === 'Angebote &amp; Produkte') {
      if (brand) category = brand;
    }

    // ── 7. Description ───────────────────────────────────────────────────────
    // JSON-LD "description" is the primary source; we also strip HTML entities.
    // Fallback: <meta name="description"> which tegut always provides.
    let description = '';
    if (productJsonLd && productJsonLd.description) {
      description = decodeHtmlEntities(productJsonLd.description);
    }
    if (!description) {
      description = cleanText($('meta[name="description"]').attr('content') || '');
    }

    // ── 8. Quantity / Füllmenge ──────────────────────────────────────────────
    // tegut shows "Füllmenge" and "EAN" as label+value pairs in the HTML.
    // The quantity value sits directly after the "Füllmenge" label text.
    // We extract just the amount (e.g. "1,5 l" or "500 g") stopping at the unit.
    let quantity = '';
    const pageText = $.text(); // full page text for regex scanning

    // Match only the measurement number + unit, NOT the following ingredients text.
    // Pattern: "Füllmenge" followed by optional whitespace, then digits + unit.
    // Units accepted: g, kg, l, ml, cl, Stück, St., Stk, Pck, Stk.
    const qtyMatch = pageText.match(
      /Füllmenge[\s\n\r]+([\d][\d,\.]*\s*(?:g|kg|l|ml|cl|Stück|St\.|Stk\.?|Pck\.?)(?:\s+[\d,\.]+\s*(?:g|kg|l|ml|cl))?)/i
    );
    if (qtyMatch) {
      quantity = cleanText(qtyMatch[1]);
    }

    // Fallback: traverse HTML siblings — "Füllmenge" label then adjacent value node
    if (!quantity) {
      $('p, span, div, td, th').each((_, el) => {
        const text = $(el).text().trim();
        if (text === 'Füllmenge') {
          const sibling = $(el).next();
          if (sibling.length) {
            const raw = cleanText(sibling.text());
            // Only take the first measurement token (stop before ingredient lists)
            const match = raw.match(/^([\d][\d,\.]*\s*(?:g|kg|l|ml|cl|Stück|Stk|Pck))/i);
            quantity = match ? match[1] : raw.split(' ')[0] + ' ' + (raw.split(' ')[1] || '');
          }
        }
      });
    }

    // ── 9. Price ─────────────────────────────────────────────────────────────
    // tegut's Eigenmarken product detail pages do NOT show a price publicly
    // (prices vary by location and availability). We try common selectors but
    // expect this field to be empty for most products.
    let price = '';
    const priceEl = $('.price, .product-price, [class*="price"]').first();
    if (priceEl.length) {
      const priceText = cleanText(priceEl.text());
      // Only use if it looks like a price (contains digit + comma/period + digit)
      if (/\d[,\.]\d/.test(priceText)) {
        price = priceText;
      }
    }

    // ── 10. Rating ───────────────────────────────────────────────────────────
    // JSON-LD "aggregateRating" may contain user rating information.
    let rating = '';
    if (productJsonLd && productJsonLd.aggregateRating) {
      const r = productJsonLd.aggregateRating;
      if (r.ratingValue && r.ratingCount) {
        rating = `${r.ratingValue}/5 (${r.ratingCount} Bewertungen)`;
      }
    }

    // ── 11. Ingredients (Zutaten) ─────────────────────────────────────────────
    // Ingredients list appears in the page as plain text after "Zutaten" keyword.
    // We capture only the ingredient text (stopping before allergen notes or ¹).
    // Example: "Zutaten rote Kidneybohnen." → "rote Kidneybohnen."
    let ingredients = '';
    const ingredientsMatch = pageText.match(/Zutaten\s+([\s\S]{5,1000}?)(?:\s*¹?\s*(?:Kann|Allergene|EAN|Füllmenge|Abtropfgewicht|\*aus|Hergestellt|Spuren|$))/i);
    if (ingredientsMatch) {
      // Clean up: strip leading asterisks, extra spaces, trim
      const rawIng = cleanText(ingredientsMatch[1])
        .replace(/^[*¹²³]+/, '')
        .trim();
      // Ignore matches from footer boilerplate (e.g. "unverfälschte Zutaten", "verzichten auf Geschmacksverstärker")
      if (!/Geschmacksverstärker|sensorische|unverfälschte|verzichten auf|verbesserte Rezepturen/i.test(rawIng)) {
        ingredients = rawIng;
      }
    }
    // Fallback: look for a dedicated ingredients section in the HTML
    if (!ingredients) {
      $('[class*="ingredient"], [id*="ingredient"], [class*="zutat"], [id*="zutat"]').each((_, el) => {
        const text = cleanText($(el).text());
        if (text && text.length > 5 && !/Geschmacksverstärker|sensorische|unverfälschte/i.test(text)) {
          ingredients = text;
          return false; // break the .each() loop
        }
      });
    }

    // ── 12. Build and return the product object ───────────────────────────────
    return {
      name,
      category,
      productUrl,
      imageUrl,
      price,         // Usually empty; tegut does not display prices publicly
      ean,           // EAN-13 barcode number
      brand,         // Product brand/sub-label (e.g. "tegut... Bio")
      quantity,      // Fill quantity / weight (e.g. "1,5 l", "500 g")
      ingredients,   // Ingredient list (Zutaten)
      description,   // Product description text
      rating,        // Aggregated customer rating from JSON-LD
      sourceUrl: SOURCE_CATEGORY_URL, // The listing page where this product was found
    };

  } catch (err) {
    // Any HTTP error (e.g. 404, timeout) means we skip this product
    return null;
  }
}

// ─── Main scraper execution ───────────────────────────────────────────────────
/**
 * Orchestrates the complete scraping workflow for tegut.com:
 *   1. Discover all paginated listing pages
 *   2. Collect all unique product URLs
 *   3. Scrape each product detail page (with 5 concurrent workers)
 *   4. Deduplicate by EAN/SKU
 *   5. Return the cleaned product array to the index.js orchestrator
 *
 * @param {Object}  [options]       - Optional configuration overrides
 * @param {number}  [options.limit] - Cap the number of products scraped (for testing)
 * @returns {Promise<Object[]>} - Array of scraped product objects
 */
async function run(options = {}) {
  console.log(`\n=================================================`);
  console.log(`   STARTING SCRAPER FOR: ${siteName} (${siteSlug})`);
  console.log(`=================================================\n`);

  // Optional product count cap (e.g. pass { limit: 5 } for a quick test run)
  const limit = options.limit || null;

  // ── Phase 1: Discover listing pages ───────────────────────────────────────
  const { listingUrls, landingProducts } = await discoverListingPages();

  // ── Phase 2: Collect product detail URLs ──────────────────────────────────
  const productUrlSet = await collectProductUrls(listingUrls, landingProducts, limit);
  const totalFound    = productUrlSet.size;
  const productUrls   = Array.from(productUrlSet); // convert Set → Array for indexing

  // ── Phase 3: Scrape product detail pages with concurrent workers ──────────
  // We run 5 workers simultaneously to speed things up while staying polite.
  // Each worker picks the next unprocessed URL from the shared index.
  const CONCURRENCY = 5;     // number of parallel requests
  const products    = [];    // final product list (populated by workers)
  let successfulCount = 0;
  let failedCount     = 0;
  let currentIndex    = 0;   // shared pointer; workers advance this atomically

  // Deduplication: avoid storing the same product twice (by EAN or product URL)
  const seenKeys = new Set();

  console.log(
    `[${siteSlug}] Scraping ${productUrls.length} product pages with ` +
    `${CONCURRENCY} concurrent workers...\n`
  );

  /**
   * A single worker function. Each worker loops until no more URLs remain,
   * fetching and parsing one product detail page at a time.
   *
   * @param {number} workerId - Identifier (1–5) for logging purposes
   */
  async function worker(workerId) {
    while (currentIndex < productUrls.length) {
      // Claim the next URL slot (simple mutex via pre-increment)
      const idx        = currentIndex++;
      const productUrl = productUrls[idx];
      const num        = idx + 1;

      // Log progress every 50 products and at start/end
      if (num === 1 || num % 50 === 0 || num === totalFound) {
        const pct = Math.round((num / totalFound) * 100);
        console.log(
          `[${siteSlug}] Progress: [${num}/${totalFound}] (${pct}%) — Worker #${workerId}`
        );
      }

      // Fetch and parse the product detail page
      const item = await scrapeProductDetail(productUrl);

      if (item && item.name) {
        // Deduplicate: use EAN if available, otherwise use the product URL
        const dedupeKey = item.ean || productUrl;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          products.push(item);
          successfulCount++;
        }
      } else {
        failedCount++;
      }

      // Small delay between each request to be a good HTTP citizen
      await sleep(150);
    }
  }

  // Launch all workers in parallel and wait for all to finish
  const workerPromises = [];
  for (let w = 1; w <= CONCURRENCY; w++) {
    workerPromises.push(worker(w));
  }
  await Promise.all(workerPromises);

  // ── Phase 4: Print summary ────────────────────────────────────────────────
  console.log(`\n=================================================`);
  console.log(`   SCRAPE SUMMARY FOR ${siteName}`);
  console.log(`=================================================`);
  console.log(`- Total Product URLs Found:       ${totalFound}`);
  console.log(`- Total Unique Products Scraped:  ${products.length}`);
  console.log(`- Products Successfully Scraped:  ${successfulCount}`);
  console.log(`- Products Failed / Skipped:      ${failedCount}`);
  console.log(`=================================================\n`);

  return products;
}

// ─── Module exports ──────────────────────────────────────────────────────────
// These three exports are required by the index.js orchestrator:
//   siteName → displayed in console logs
//   siteSlug → used to generate file names (data/tegut.csv, data/tegut.xlsx)
//   run      → the main entry point called by the orchestrator
module.exports = {
  siteName,
  siteSlug,
  run,
};
