// Built-in Node.js module to work with files and directories
const fs = require('fs');
// Built-in Node.js module to help build file paths safely on any operating system
const path = require('path');
// Library to create CSV (Comma Separated Values) files
const { createObjectCsvWriter } = require('csv-writer');
// Library to read and write Excel (.xlsx) files
const xlsx = require('xlsx');
// Import helper to clean site names into safe filenames
const { sanitizeFilename } = require('./utils');

// Map of internal object key names to user-friendly column title headers
const STANDARD_HEADERS = {
    name: 'Product Name',
    category: 'Category',
    price: 'Price',
    description: 'Description',
    productUrl: 'Product URL',
    imageUrl: 'Image URL',
    sourceUrl: 'Source Category URL'
};

/**
 * Exports scraped product data for a specific website into separate CSV and Excel files.
 * 
 * @param {string|Array} siteIdentifier - Domain name or site identifier (e.g. "natuerlich-fuer-uns.at" or "biogast")
 * @param {Array} products - List of product objects collected for this website
 */
async function exportData(siteIdentifier, products) {
    // Parameter handling: if only products array is passed, default site name to 'products'
    if (Array.isArray(siteIdentifier)) {
        products = siteIdentifier;
        siteIdentifier = 'products';
    }

    if (!products || products.length === 0) {
        console.log(`[Exporter] No products to export for ${siteIdentifier}.`);
        return;
    }

    // 1. Convert site identifier into a safe filename slug (e.g., "natuerlich-fuer-uns")
    const filenameBase = sanitizeFilename(siteIdentifier);

    // 2. Ensure the target `data/` folder exists
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // 3. Define output file paths inside `data/`
    const csvPath = path.join(dataDir, `${filenameBase}.csv`);
    const excelPath = path.join(dataDir, `${filenameBase}.xlsx`);

    console.log(`\n[Exporter] Exporting ${products.length} products for '${siteIdentifier}' -> ${filenameBase}...`);

    // 4. Determine columns by combining standard keys and any custom keys found in the products
    const keySet = new Set(['name', 'category', 'price', 'description', 'productUrl', 'imageUrl', 'sourceUrl']);
    products.forEach(item => {
        Object.keys(item).forEach(k => keySet.add(k));
    });

    // Convert Set to array of key strings
    const headerKeys = Array.from(keySet);

    // Filter out keys that don't exist in any of the product objects (e.g. if price/description are empty everywhere)
    const activeHeaderKeys = headerKeys.filter(key => 
        products.some(p => p[key] !== undefined && p[key] !== null)
    );

    // Build header configuration array for CSV writer
    const csvHeaderConfig = activeHeaderKeys.map(key => ({
        id: key,
        title: STANDARD_HEADERS[key] || (key.charAt(0).toUpperCase() + key.slice(1))
    }));

    // --- A. Export to CSV ---
    const csvWriter = createObjectCsvWriter({
        path: csvPath,
        header: csvHeaderConfig
    });

    await csvWriter.writeRecords(products);
    console.log(`✓ CSV successfully saved to: ${csvPath}`);

    // --- B. Export to Excel (.xlsx) ---
    // Generate worksheet from JSON using active keys header sequence
    const worksheet = xlsx.utils.json_to_sheet(products, {
        header: activeHeaderKeys
    });

    // Rename first row cells (headers) to user-friendly column titles
    activeHeaderKeys.forEach((key, colIndex) => {
        const cellAddress = xlsx.utils.encode_cell({ r: 0, c: colIndex });
        if (worksheet[cellAddress]) {
            worksheet[cellAddress].v = STANDARD_HEADERS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
        }
    });

    // Create workbook and append worksheet named 'Products'
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Products');

    // Save workbook file
    xlsx.writeFile(workbook, excelPath);
    console.log(`✓ Excel successfully saved to: ${excelPath}`);
}

module.exports = {
    exportData
};

