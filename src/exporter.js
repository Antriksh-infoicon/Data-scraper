const { createObjectCsvWriter } = require('csv-writer');
const xlsx = require('xlsx');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'data', 'products.csv');
const EXCEL_PATH = path.join(__dirname, '..', 'data', 'products.xlsx');

async function exportData(products) {
    if (products.length === 0) {
        console.log("No products to export.");
        return;
    }

    console.log(`Exporting ${products.length} products...`);
    
    // Export CSV
    const csvWriter = createObjectCsvWriter({
        path: CSV_PATH,
        header: [
            { id: 'name', title: 'Product Name' },
            { id: 'category', title: 'Category' },
            { id: 'imageUrl', title: 'Image URL' },
            { id: 'sourceUrl', title: 'Source Category URL' },
            { id: 'productUrl', title: 'Product URL' }
        ]
    });
    
    await csvWriter.writeRecords(products);
    console.log(`CSV exported to ${CSV_PATH}`);
    
    // Export Excel
    const worksheet = xlsx.utils.json_to_sheet(products, {
        header: ['name', 'category', 'imageUrl', 'sourceUrl', 'productUrl']
    });
    
    // Rename columns
    worksheet.A1.v = 'Product Name';
    worksheet.B1.v = 'Category';
    worksheet.C1.v = 'Image URL';
    worksheet.D1.v = 'Source Category URL';
    worksheet.E1.v = 'Product URL';
    
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Products');
    xlsx.writeFile(workbook, EXCEL_PATH);
    
    console.log(`Excel exported to ${EXCEL_PATH}`);
}

module.exports = {
    exportData
};
