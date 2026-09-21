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

// This function takes a website URL or domain name (like "natuerlich-fuer-uns.at" or "https://myproduct.at/")
// and converts it into a clean, safe filename slug (like "natuerlich-fuer-uns" or "myproduct").
const sanitizeFilename = (siteOrDomain) => {
    if (!siteOrDomain) return 'scraped-website';
    
    let clean = siteOrDomain.toString().toLowerCase().trim();
    
    // Remove protocol (http:// or https://)
    clean = clean.replace(/^https?:\/\//i, '');
    
    // Remove www.
    clean = clean.replace(/^www\./i, '');
    
    // Remove URL path (keep only host domain)
    clean = clean.split('/')[0].split('?')[0].split('#')[0];
    
    // Remove common Top Level Domains (.at, .de, .com, .org, etc.)
    clean = clean.replace(/\.(at|de|com|org|net|co\.at|co\.uk|eu)$/i, '');
    
    // Replace any remaining non-alphanumeric characters with hyphens
    clean = clean.replace(/[^a-z0-9_-]/g, '-');
    
    // Remove double hyphens and trim dashes from edges
    clean = clean.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    
    return clean || 'scraped-website';
};

// Export these functions so they can be imported into other modules
module.exports = {
    sleep,
    cleanText,
    extractCategoryFromUrl,
    sanitizeFilename
};

