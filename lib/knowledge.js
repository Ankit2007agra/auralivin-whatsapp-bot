// lib/knowledge.js
// Everything the WhatsApp AI assistant is allowed to "know", from three
// sources, refreshed automatically so new info is picked up day to day:
//
//   1. config/knowledge.md             - permanent baseline (policies etc.)
//   2. Shopify page "bot-knowledge"    - day-to-day additions you type in
//                                         Shopify Admin > Online Store > Pages.
//                                         Needs the "read_content" API scope.
//   3. Live product catalog            - https://auralivin.com/products.json
//                                         (public, no API scope needed):
//                                         titles, prices, sizes, stock.
//
// Shopify page + catalog are cached for REFRESH_MS; if a refresh fails the
// last good copy keeps being used, so a Shopify hiccup never breaks replies.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const shopify = require('./shopify');

const STORE_URL = (process.env.STORE_PUBLIC_URL || 'https://auralivin.com').replace(/\/$/, '');
const KNOWLEDGE_PAGE_HANDLE = process.env.KNOWLEDGE_PAGE_HANDLE || 'bot-knowledge';
const REFRESH_MS = 10 * 60 * 1000;

const baseKnowledge = fs.readFileSync(path.join(__dirname, '../config/knowledge.md'), 'utf8')
  .split('\n')
  .filter((l) => !l.startsWith('#') || l.startsWith('## ')) // drop the file's own header comments
  .join('\n')
  .trim();

let pageCache = { text: '', at: 0 };
let catalogCache = { products: [], at: 0 };

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function getShopifyPageKnowledge() {
  if (!shopify.isConfigured()) return '';
  if (Date.now() - pageCache.at < REFRESH_MS) return pageCache.text;
  try {
    const page = await shopify.getPageByHandle(KNOWLEDGE_PAGE_HANDLE);
    pageCache = { text: page ? htmlToText(page.body) : '', at: Date.now() };
    if (!page) console.warn(`[knowledge] No Shopify page with handle "${KNOWLEDGE_PAGE_HANDLE}" yet.`);
  } catch (e) {
    console.error('[knowledge] Could not load Shopify knowledge page (needs read_content scope):', e.message);
    pageCache.at = Date.now(); // don't hammer Shopify; retry after REFRESH_MS
  }
  return pageCache.text;
}

async function getCatalog() {
  if (Date.now() - catalogCache.at < REFRESH_MS && catalogCache.products.length) {
    return catalogCache.products;
  }
  try {
    let all = [];
    for (let page = 1; page <= 8; page++) {
      const { data } = await axios.get(`${STORE_URL}/products.json`, {
        params: { limit: 250, page },
        timeout: 15000,
      });
      all = all.concat(data.products || []);
      if (!data.products || data.products.length < 250) break;
    }
    catalogCache = {
      at: Date.now(),
      products: all.map((p) => ({
        title: p.title,
        type: p.product_type || '',
        tags: (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).join(' '),
        url: `${STORE_URL}/products/${p.handle}`,
        description: htmlToText(p.body_html).slice(0, 400),
        variants: (p.variants || []).map((v) => ({
          title: v.title,
          price: v.price,
          compareAt: v.compare_at_price,
          available: v.available !== false,
        })),
      })),
    };
  } catch (e) {
    console.error('[knowledge] Could not refresh product catalog:', e.message);
    catalogCache.at = Date.now();
  }
  return catalogCache.products;
}

const STOPWORDS = new Set(
  ('the and for you your with have has any this that what which there are was can will ' +
    'please pls plz want need buy price rate cost how much hai hain kya ka ki ke ko me mein ' +
    'mujhe chahiye aap kar karo send show from about available more info details').split(' ')
);

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function formatProduct(p, withDescription) {
  const prices = p.variants.map((v) => Number(v.price)).filter((n) => !Number.isNaN(n));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const price = prices.length ? (min === max ? `₹${min}` : `₹${min}-₹${max}`) : 'price n/a';
  const anyAvailable = p.variants.some((v) => v.available);
  const variants =
    p.variants.length > 1 || p.variants[0]?.title !== 'Default Title'
      ? ' | options: ' +
        p.variants
          .slice(0, 12)
          .map((v) => `${v.title} ₹${v.price}${v.available ? '' : ' (sold out)'}`)
          .join('; ')
      : '';
  let line = `- ${p.title} | ${p.type} | ${price}${anyAvailable ? '' : ' | SOLD OUT'}${variants} | ${p.url}`;
  if (withDescription && p.description) line += `\n  details: ${p.description}`;
  return line;
}

/**
 * The part of the catalog relevant to what the customer is asking about -
 * sending all ~370 products on every message would be slow and costly.
 * Returns a category summary plus the best-matching products.
 */
async function getRelevantCatalog(conversationText, maxProducts = 30) {
  const products = await getCatalog();
  if (!products.length) return 'CATALOG: (temporarily unavailable)';

  const categories = {};
  for (const p of products) {
    const key = p.type || 'Other';
    categories[key] = (categories[key] || 0) + 1;
  }
  const summary =
    `The store has ${products.length} products in these categories: ` +
    Object.entries(categories)
      .map(([k, n]) => `${k} (${n})`)
      .join(', ') +
    `. Full catalog: ${STORE_URL}/collections/all`;

  const queryWords = words(conversationText);
  const scored = products
    .map((p) => {
      const hay = ` ${words(`${p.title} ${p.type} ${p.tags}`).join(' ')} `;
      let score = 0;
      for (const w of queryWords) {
        if (hay.includes(` ${w} `)) score += 3;
        else if (hay.includes(w)) score += 1; // partial, e.g. "bed" in "beds"
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxProducts);

  const lines = scored.map((x, i) => formatProduct(x.p, i < 8));
  return (
    `${summary}\n\nProducts matching the customer's words (${scored.length} shown` +
    `${scored.length ? '' : ' - nothing matched; do not guess products'}):\n${lines.join('\n')}`
  );
}

async function buildKnowledge(conversationText) {
  const [pageText, catalog] = await Promise.all([
    getShopifyPageKnowledge(),
    getRelevantCatalog(conversationText),
  ]);
  return [
    '=== STORE KNOWLEDGE (baseline) ===',
    baseKnowledge,
    '=== LATEST UPDATES FROM THE TEAM (take priority over the baseline if they conflict) ===',
    pageText || '(none yet)',
    '=== PRODUCT CATALOG (live) ===',
    catalog,
  ].join('\n\n');
}

module.exports = { buildKnowledge, getRelevantCatalog, htmlToText };
