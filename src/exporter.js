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
    subcategory: 'Subcategory',
    price: 'Price',
    regularPrice: 'Regular Price',
    salePrice: 'Sale Price',
    uvp: 'UVP / RRP',
    brand: 'Brand',
    manufacturer: 'Manufacturer',
    description: 'Description',
    productUrl: 'Product URL',
    imageUrl: 'Image URL',
    sourceUrl: 'Source Category URL',
    quantity: 'Product Weight / Quantity',
    unitPrice: 'Unit Price',
    ingredients: 'Ingredients',
    ean: 'EAN / GTIN',
    availability: 'Availability',
    onlineAvailability: 'Online Availability',
    storeAvailability: 'Store Availability',
    productId: 'Product ID / Article Number',
    rating: 'Rating',
    reviewCount: 'Review Count',
    badges: 'Product Badges',
    shortDescription: 'Short Description',
    nutritionalInfo: 'Nutritional Information',
    usage: 'Recommended Usage / Dosage',
    country: 'Country of Origin',
    sourceBrandUrl: 'Source Brand URL',
    statusCode: 'HTTP Status Code',
    errorType: 'Error Type',
    errorMessage: 'Error Message',
    failureReason: 'Failure Reason',
    retryAttempts: 'Number of Retry Attempts',
    availabilityDate: 'Availability Date'
};

/**
 * Exports scraped product data for a specific website into separate CSV and Excel files.
 * 
 * @param {string|Array} siteIdentifier - Domain name or site identifier (e.g. "natuerlich-fuer-uns.at" or "mpreis")
 * @param {Array} products - List of product objects collected for this website
 */
async function exportData(siteIdentifier, products) {
    if (Array.isArray(siteIdentifier)) {
        products = siteIdentifier;
        siteIdentifier = 'products';
    }

    if (!products || products.length === 0) {
        console.log(`[Exporter] No products to export for ${siteIdentifier}.`);
        return;
    }

    const filenameBase = sanitizeFilename(siteIdentifier);
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const csvPath = path.join(dataDir, `${filenameBase}.csv`);
    const excelPath = path.join(dataDir, `${filenameBase}.xlsx`);

    console.log(`\n[Exporter] Exporting ${products.length} products for '${siteIdentifier}' -> ${filenameBase}...`);

    const keySet = new Set(['name', 'category', 'price', 'description', 'productUrl', 'imageUrl', 'sourceUrl']);
    products.forEach(item => {
        Object.keys(item).forEach(k => keySet.add(k));
    });

    const headerKeys = Array.from(keySet);
    const activeHeaderKeys = headerKeys.filter(key => 
        products.some(p => p[key] !== undefined && p[key] !== null)
    );

    const csvHeaderConfig = activeHeaderKeys.map(key => ({
        id: key,
        title: STANDARD_HEADERS[key] || (key.charAt(0).toUpperCase() + key.slice(1))
    }));

    const csvWriter = createObjectCsvWriter({
        path: csvPath,
        header: csvHeaderConfig
    });

    await csvWriter.writeRecords(products);
    console.log(`✓ CSV successfully saved to: ${csvPath}`);

    const worksheet = xlsx.utils.json_to_sheet(products, {
        header: activeHeaderKeys
    });

    activeHeaderKeys.forEach((key, colIndex) => {
        const cellAddress = xlsx.utils.encode_cell({ r: 0, c: colIndex });
        if (worksheet[cellAddress]) {
            worksheet[cellAddress].v = STANDARD_HEADERS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
        }
    });

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Products');

    xlsx.writeFile(workbook, excelPath);
    console.log(`✓ Excel successfully saved to: ${excelPath}`);
}

/**
 * Exports failed product records for a specific website into a failure CSV file inside data/
 * 
 * @param {string} siteIdentifier 
 * @param {Array} failedRecords 
 */
async function exportFailedData(siteIdentifier, failedRecords) {
    if (!failedRecords || failedRecords.length === 0) return;

    const filenameBase = sanitizeFilename(siteIdentifier);
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const failedCsvPath = path.join(dataDir, `${filenameBase}_failed.csv`);

    console.log(`\n[Exporter] Exporting ${failedRecords.length} failed record(s) -> ${filenameBase}_failed.csv...`);

    const keySet = new Set(['name', 'productUrl', 'sourceUrl', 'statusCode', 'errorType', 'errorMessage', 'failureReason', 'retryAttempts']);
    failedRecords.forEach(item => {
        Object.keys(item).forEach(k => keySet.add(k));
    });

    const activeHeaderKeys = Array.from(keySet).filter(key => 
        failedRecords.some(p => p[key] !== undefined && p[key] !== null)
    );

    const csvHeaderConfig = activeHeaderKeys.map(key => ({
        id: key,
        title: STANDARD_HEADERS[key] || (key.charAt(0).toUpperCase() + key.slice(1))
    }));

    const csvWriter = createObjectCsvWriter({
        path: failedCsvPath,
        header: csvHeaderConfig
    });

    await csvWriter.writeRecords(failedRecords);
    console.log(`✓ Failed CSV successfully saved to: ${failedCsvPath}`);
}

module.exports = {
    exportData,
    exportFailedData
};
