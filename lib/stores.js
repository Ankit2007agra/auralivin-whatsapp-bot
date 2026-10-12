// lib/stores.js
// The Shopify stores (brands) this bot serves. Both brands share ONE
// WhatsApp number, so incoming chats aren't tied to a brand - order lookups
// and AI answers check every store. Outgoing messages (order confirmations,
// COD, cart reminders) come from a specific store's webhook/sweep and use
// that brand's name and templates.
//
// Each store is configured with env vars (Render > Environment):
//
//   Auralivin (no prefix, as before):
//     SHOPIFY_STORE_DOMAIN       yiu5wf-1t.myshopify.com
//     SHOPIFY_ADMIN_API_TOKEN    shpat_...         (or the two below)
//     SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET     (Dev Dashboard app)
//     SHOPIFY_WEBHOOK_SECRET     signing secret of the store's webhooks
//
//   Lovtail (LOVTAIL_ prefix):
//     LOVTAIL_SHOPIFY_STORE_DOMAIN     b51150-ff.myshopify.com
//     LOVTAIL_SHOPIFY_ADMIN_API_TOKEN  (or LOVTAIL_SHOPIFY_CLIENT_ID +
//                                       LOVTAIL_SHOPIFY_CLIENT_SECRET)
//     LOVTAIL_SHOPIFY_WEBHOOK_SECRET
//
// With a Dev Dashboard app, give its Client ID + Client secret instead of a
// token: the bot then gets (and renews every 24h) its own access token using
// Shopify's client-credentials grant. That only works when the app and the
// store are in the same Shopify organization.

const { createShopify } = require('./shopify');

const env = process.env;

function strip(url) {
  return String(url || '').replace(/\/$/, '');
}

const DEFINITIONS = [
  {
    key: 'auralivin',
    name: 'Auralivin',
    domain: env.SHOPIFY_STORE_DOMAIN,
    token: env.SHOPIFY_ADMIN_API_TOKEN,
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    webhookSecret: env.SHOPIFY_WEBHOOK_SECRET,
    publicUrl: strip(env.STORE_PUBLIC_URL || 'https://auralivin.com'),
    knowledgeFile: 'knowledge.md',
    about: 'home décor, marble serveware, furniture (tables, desks, seating, storage, mirrors) and pet products',
    codTemplate: env.COD_TEMPLATE_NAME || 'cod_order_confirmation',
    cartTemplate: env.CART_TEMPLATE_NAME || 'abandoned_cart_reminder',
  },
  {
    key: 'lovtail',
    name: 'Lovtail',
    domain: env.LOVTAIL_SHOPIFY_STORE_DOMAIN,
    token: env.LOVTAIL_SHOPIFY_ADMIN_API_TOKEN,
    clientId: env.LOVTAIL_SHOPIFY_CLIENT_ID,
    clientSecret: env.LOVTAIL_SHOPIFY_CLIENT_SECRET,
    webhookSecret: env.LOVTAIL_SHOPIFY_WEBHOOK_SECRET,
    publicUrl: strip(env.LOVTAIL_STORE_PUBLIC_URL || 'https://www.lovtail.com'),
    knowledgeFile: 'knowledge-lovtail.md',
    about: 'pet products: pet beds, sofas, tents, mats, feeders, accessories and pet food',
    codTemplate: env.LOVTAIL_COD_TEMPLATE_NAME || 'cod_order_confirmation_lovtail',
    cartTemplate: env.LOVTAIL_CART_TEMPLATE_NAME || 'abandoned_cart_reminder_lovtail',
  },
];

const ALL = DEFINITIONS.map((d) => ({ ...d, shopify: createShopify(d) }));

/** Every brand (for the public catalog / knowledge, even without API access). */
function all() {
  return ALL;
}

/** Stores the bot can call the Shopify Admin API for. */
function connected() {
  return ALL.filter((s) => s.shopify.isConfigured());
}

function byKey(key) {
  return ALL.find((s) => s.key === key) || null;
}

/** Store for an incoming Shopify webhook (X-Shopify-Shop-Domain header). */
function byShopDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return ALL.find((s) => s.domain && s.domain.toLowerCase() === d) || null;
}

function primary() {
  return ALL[0];
}

/** "Auralivin & Lovtail" - for the shared greeting and messages. */
function brandNames() {
  return ALL.map((s) => s.name).join(' & ');
}

module.exports = { all, connected, byKey, byShopDomain, primary, brandNames };
