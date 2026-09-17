const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const cleanText = (text) => {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
};

const extractCategoryFromUrl = (url) => {
    // e.g. https://natuerlich-fuer-uns.at/produkt-kategorien/bio-vegan/
    const match = url.match(/produkt-kategorien\/([^/]+)/);
    return match ? match[1] : '';
};

module.exports = {
    sleep,
    cleanText,
    extractCategoryFromUrl
};
