// lib/knowledge.js
// Everything the WhatsApp AI assistant is allowed to "know". The WhatsApp
// number is shared by every brand in lib/stores.js (Auralivin, Lovtail), so
// knowledge from ALL of them is combined, each clearly labelled by brand:
//
//   1. config/<store.knowledgeFile>    - permanent baseline (policies etc.),
//                                         e.g. knowledge.md, knowledge-lovtail.md
//   2. Shopify page "bot-knowledge"    - day-to-day additions you type in each
//                                         store's Admin > Online Store > Pages.
//                                         Needs the "read_content" API scope.
//   3. Live product catalog            - <store.publicUrl>/products.json
//                                         (public, no API scope needed).
//
// Shopify pages + catalogs are cached for REFRESH_MS; if a refresh fails the
// last good copy keeps being used, so a Shopify hiccup never breaks replies.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const stores = require('./stores');

const KNOWLEDGE_PAGE_HANDLE = process.env.KNOWLEDGE_PAGE_HANDLE || 'bot-knowledge';
const REFRESH_MS = 10 * 60 * 1000;

function readBaseKnowledge(file) {
  try {
    return fs.readFileSync(path.join(__dirname, '../config', file), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('#') || l.startsWith('## ')) // drop the file's own header comments
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

const baseKnowledge = new Map(stores.all().map((st) => [st.key, readBaseKnowledge(st.knowledgeFile)]));
const pageCache = new Map(); // store.key -> { text, at }
const catalogCache = new Map(); // store.key -> { products, at }

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

async function getShopifyPageKnowledge(store) {
  if (!store.shopify.isConfigured()) return '';
  const cached = pageCache.get(store.key);
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached.text;
  try {
    const page = await store.shopify.getPageByHandle(KNOWLEDGE_PAGE_HANDLE);
    pageCache.set(store.key, { text: page ? htmlToText(page.body) : '', at: Date.now() });
    if (!page) console.warn(`[knowledge] ${store.name}: no Shopify page with handle "${KNOWLEDGE_PAGE_HANDLE}" yet.`);
  } catch (e) {
    console.error(`[knowledge] ${store.name}: could not load knowledge page (needs read_content scope):`, e.message);
    // don't hammer Shopify; keep the last good copy and retry after REFRESH_MS
    pageCache.set(store.key, { text: cached?.text || '', at: Date.now() });
  }
  return pageCache.get(store.key).text;
}

async function getCatalog(store) {
  const cached = catalogCache.get(store.key);
  if (cached && Date.now() - cached.at < REFRESH_MS && cached.products.length) {
    return cached.products;
  }
  try {
    let all = [];
    for (let page = 1; page <= 8; page++) {
      const { data } = await axios.get(`${store.publicUrl}/products.json`, {
        params: { limit: 250, page },
        timeout: 15000,
      });
      all = all.concat(data.products || []);
      if (!data.products || data.products.length < 250) break;
    }
    catalogCache.set(store.key, {
      at: Date.now(),
      products: all.map((p) => ({
        brand: store.name,
        title: p.title,
        type: p.product_type || '',
        tags: (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).join(' '),
        url: `${store.publicUrl}/products/${p.handle}`,
        description: htmlToText(p.body_html).slice(0, 400),
        variants: (p.variants || []).map((v) => ({
          title: v.title,
          price: v.price,
          compareAt: v.compare_at_price,
          available: v.available !== false,
        })),
      })),
    });
  } catch (e) {
    console.error(`[knowledge] ${store.name}: could not refresh product catalog:`, e.message);
    catalogCache.set(store.key, { products: cached?.products || [], at: Date.now() });
  }
  return catalogCache.get(store.key).products;
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
  let line = `- [${p.brand}] ${p.title} | ${p.type} | ${price}${anyAvailable ? '' : ' | SOLD OUT'}${variants} | ${p.url}`;
  if (withDescription && p.description) line += `\n  details: ${p.description}`;
  return line;
}

/**
 * The part of the catalog relevant to what the customer is asking about -
 * sending all ~370 products on every message would be slow and costly.
 * Returns a category summary plus the best-matching products.
 */
async function getRelevantCatalog(conversationText, maxProducts = 30) {
  const perStore = await Promise.all(stores.all().map((st) => getCatalog(st).then((p) => [st, p])));
  const products = perStore.flatMap(([, p]) => p);
  if (!products.length) return 'CATALOG: (temporarily unavailable)';

  const summaries = perStore
    .filter(([, p]) => p.length)
    .map(([st, p]) => {
      const categories = {};
      for (const prod of p) categories[prod.type || 'Other'] = (categories[prod.type || 'Other'] || 0) + 1;
      return (
        `${st.name} has ${p.length} products in these categories: ` +
        Object.entries(categories)
          .map(([k, n]) => `${k} (${n})`)
          .join(', ') +
        `. Full catalog: ${st.publicUrl}/collections/all`
      );
    })
    .join('\n');

  const queryWords = words(conversationText);
  const scored = products
    .map((p) => {
      const hay = ` ${words(`${p.brand} ${p.title} ${p.type} ${p.tags}`).join(' ')} `;
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
    `${summaries}\n\nProducts matching the customer's words (${scored.length} shown` +
    `${scored.length ? '' : ' - nothing matched; do not guess products'}):\n${lines.join('\n')}`
  );
}

async function buildKnowledge(conversationText) {
  const [pages, catalog] = await Promise.all([
    Promise.all(stores.all().map((st) => getShopifyPageKnowledge(st))),
    getRelevantCatalog(conversationText),
  ]);
  const sections = [];
  stores.all().forEach((st, i) => {
    sections.push(
      `=== ${st.name.toUpperCase()} (${st.publicUrl}) - STORE KNOWLEDGE (baseline) ===`,
      baseKnowledge.get(st.key) || '(none)',
      `=== ${st.name.toUpperCase()} - LATEST UPDATES FROM THE TEAM (take priority over the baseline if they conflict) ===`,
      pages[i] || '(none yet)'
    );
  });
  sections.push('=== PRODUCT CATALOG (live, both brands) ===', catalog);
  return sections.join('\n\n');
}

module.exports = { buildKnowledge, getRelevantCatalog, htmlToText };
