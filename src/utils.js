// This function pauses the script for a certain number of milliseconds (e.g., 500ms = 0.5 seconds).
// We use Promises to make this work with 'await' inside our async functions.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// This function takes a string (like a product title) and cleans it up.
// It removes any extra spaces, tabs, or newlines that might mess up our CSV/Excel files.
const cleanText = (text) => {
    if (!text) return ''; // If there's no text, just return an empty string
    
    // .replace(/\s+/g, ' ') replaces all large gaps of whitespace with a single space
    // .trim() removes any spaces at the very beginning or end of the string
    return text.replace(/\s+/g, ' ').trim();
};

// This function takes a full URL (like "https://site.com/produkt-kategorien/bio-vegan/")
// and extracts just the category name ("bio-vegan") from it.
const extractCategoryFromUrl = (url) => {
    // We use a "Regular Expression" (regex) to find the text that comes immediately 
    // after "/produkt-kategorien/" and before the next "/"
    const match = url.match(/produkt-kategorien\/([^/]+)/);
    
    // If it finds a match, return the captured word (match[1]). Otherwise return an empty string.
    return match ? match[1] : '';
};

// Export these functions so they can be imported into scraper.js
module.exports = {
    sleep,
    cleanText,
    extractCategoryFromUrl
};
