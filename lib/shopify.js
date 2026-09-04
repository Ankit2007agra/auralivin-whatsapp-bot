// lib/shopify.js
// Looks up a real order in Shopify so the WhatsApp bot can reply with the
// customer's actual order/tracking status, instead of a canned "our team
// will check" message.
//
// Setup (one-time, in Shopify Admin):
//   Settings > Apps and sales channels > Develop apps > Create an app
//   > Configure Admin API scopes > enable "read_orders"
//   > Install app > reveal the "Admin API access token"
// Then set these in your .env / Render env vars:
//   SHOPIFY_STORE_DOMAIN=yourstore.myshopify.com
//   SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
//
// If these aren't set, getOrderStatusMessage() just returns null and
// webhook.js falls back to the old "our team will look it up" reply -
// nothing breaks.

const axios = require('axios');

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2024-10';

function isConfigured() {
    return Boolean(STORE_DOMAIN && ADMIN_TOKEN);
}

function client() {
    return axios.create({
          baseURL: `https://${STORE_DOMAIN}/admin/api/${API_VERSION}`,
          headers: {
                  'X-Shopify-Access-Token': ADMIN_TOKEN,
                  'Content-Type': 'application/json',
          },
          timeout: 15000,
    });
}

// Pulls a plausible order number out of whatever the customer typed, e.g.
// "2586", "#2586", "order 2586, please check" all -> "2586".
function extractOrderNumber(text) {
    const match = String(text || '').match(/(\d{3,7})/);
    return match ? match[1] : null;
}

function humanFulfillmentStatus(order) {
    const status = (order.fulfillment_status || 'unfulfilled').toLowerCase();
    if (status === 'fulfilled') return 'Shipped';
    if (status === 'partial') return 'Partially shipped';
    if (status === 'restocked') return 'Cancelled';
    return 'Processing (not shipped yet)';
}

function latestTracking(order) {
    const fulfillments = order.fulfillments || [];
    const withTracking = fulfillments.find((f) => f.tracking_number || f.tracking_url);
    if (!withTracking) return null;
    return {
          company: withTracking.tracking_company || 'Courier',
          number: withTracking.tracking_number || null,
          url: withTracking.tracking_url || (withTracking.tracking_urls || [])[0] || null,
    };
}

/**
 * Looks up an order by the number the customer typed and returns a
 * ready-to-send WhatsApp status message.
 *
 * Return value meanings (important - callers branch on this):
 *   - null      -> Shopify isn't configured (no env vars set)
 *   - undefined -> configured + searched, but no matching order found
 *   - string    -> the order's live status, ready to send
 */
async function getOrderStatusMessage(rawText) {
    if (!isConfigured()) return null;

  const number = extractOrderNumber(rawText);
    if (!number) return undefined;

  const name = `#${number}`;
    const { data } = await client().get('/orders.json', {
          params: { name, status: 'any' },
    });

  const order = (data.orders || [])[0];
    if (!order) return undefined;

  const status = humanFulfillmentStatus(order);
    const tracking = latestTracking(order);

  let msg = `📦 Order ${order.name}\nStatus: ${status}`;
    if (tracking) {
          msg += `\nCourier: ${tracking.company}`;
          if (tracking.number) msg += `\nTracking #: ${tracking.number}`;
          if (tracking.url) msg += `\nTrack here: ${tracking.url}`;
    } else if (status === 'Processing (not shipped yet)') {
          msg += `\nWe'll share tracking details here as soon as it ships.`;
    }
    return msg;
}

module.exports = { getOrderStatusMessage, isConfigured };
