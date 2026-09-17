// This library helps us easily create CSV (Comma Separated Values) files
const { createObjectCsvWriter } = require('csv-writer');
// This library helps us read and write Excel (.xlsx) files
const xlsx = require('xlsx');
// This is a built-in Node.js module to help build file paths safely on any operating system
const path = require('path');

// Determine exactly where to save the files. 
// __dirname is the folder this file is in (src). '..' goes up one folder, then into 'data'
const CSV_PATH = path.join(__dirname, '..', 'data', 'products.csv');
const EXCEL_PATH = path.join(__dirname, '..', 'data', 'products.xlsx');

// This function takes the final list of products and saves them to the computer
async function exportData(products) {
    if (products.length === 0) {
        console.log("No products to export.");
        return; // If the list is empty, stop and do nothing
    }

    console.log(`Exporting ${products.length} products...`);
    
    // --- 1. Exporting to CSV ---
    // We configure the CSV writer with the save path and the column headers
    const csvWriter = createObjectCsvWriter({
        path: CSV_PATH,
        header: [
            // 'id' must match the key name in our product object, 'title' is what appears at the top of the CSV
            { id: 'name', title: 'Product Name' },
            { id: 'category', title: 'Category' },
            { id: 'imageUrl', title: 'Image URL' },
            { id: 'sourceUrl', title: 'Source Category URL' },
            { id: 'productUrl', title: 'Product URL' }
        ]
    });
    
    // Write all the products to the CSV file
    await csvWriter.writeRecords(products);
    console.log(`CSV exported to ${CSV_PATH}`);
    
    // --- 2. Exporting to Excel (.xlsx) ---
    // Create a new "worksheet" (like a single tab in Excel) directly from our JSON data
    // We specify the 'header' order so the columns are organized correctly
    const worksheet = xlsx.utils.json_to_sheet(products, {
        header: ['name', 'category', 'imageUrl', 'sourceUrl', 'productUrl']
    });
    
    // By default, it uses the JSON keys as column headers. Let's rename them to be reader-friendly
    worksheet.A1.v = 'Product Name';
    worksheet.B1.v = 'Category';
    worksheet.C1.v = 'Image URL';
    worksheet.D1.v = 'Source Category URL';
    worksheet.E1.v = 'Product URL';
    
    // Create a new empty "workbook" (the whole Excel file)
    const workbook = xlsx.utils.book_new();
    
    // Add our worksheet to the workbook, and name the tab "Products"
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Products');
    
    // Save the final Excel file to the computer
    xlsx.writeFile(workbook, EXCEL_PATH);
    
    console.log(`Excel exported to ${EXCEL_PATH}`);
}

module.exports = {
    exportData
};
