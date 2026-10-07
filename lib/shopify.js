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
const API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-10';

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

// ---------------------------------------------------------------------
// Helpers used by the COD confirmation flow (lib/cod.js). These use the
// GraphQL Admin API. Tagging needs the "write_orders" scope on the app.
// ---------------------------------------------------------------------

async function graphql(query, variables = {}) {
    const { data } = await client().post('/graphql.json', { query, variables });
    if (data.errors) {
          throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors).slice(0, 300)}`);
    }
    return data.data;
}

const orderGid = (id) => (String(id).startsWith('gid://') ? id : `gid://shopify/Order/${id}`);

/** Returns { id, legacyResourceId, name, tags, cancelledAt } or null. */
async function getOrderById(id) {
    const data = await graphql(
          `query($id: ID!) { order(id: $id) { id legacyResourceId name tags cancelledAt } }`,
          { id: orderGid(id) }
    );
    return data.order;
}

async function changeOrderTags(mutation, id, tags) {
    const data = await graphql(
          `mutation($id: ID!, $tags: [String!]!) { ${mutation}(id: $id, tags: $tags) { userErrors { field message } } }`,
          { id: orderGid(id), tags }
    );
    const errors = data[mutation].userErrors;
    if (errors.length) throw new Error(`${mutation}: ${errors.map((e) => e.message).join('; ')}`);
}

const addOrderTags = (id, tags) => changeOrderTags('tagsAdd', id, tags);
const removeOrderTags = (id, tags) => changeOrderTags('tagsRemove', id, tags);

/** Orders matching a Shopify search query (max 50). */
async function findOrders(searchQuery) {
    const data = await graphql(
          `query($q: String!) {
            orders(first: 50, query: $q) {
              nodes {
                id legacyResourceId name phone tags
                totalPriceSet { shopMoney { amount currencyCode } }
                shippingAddress { firstName phone }
              }
            }
          }`,
          { q: searchQuery }
    );
    return data.orders.nodes;
}

/** The Online Store page with this handle ({ title, body }) or null. Needs read_content. */
async function getPageByHandle(handle) {
    const data = await graphql(
          `query($q: String!) { pages(first: 1, query: $q) { nodes { title handle body } } }`,
          { q: `handle:${handle}` }
    );
    const page = data.pages.nodes[0];
    return page && page.handle === handle ? page : null;
}

// ---------------------------------------------------------------------
// Helpers for the abandoned-cart WhatsApp reminder (lib/abandonedCart.js).
// Only need read_orders.
// ---------------------------------------------------------------------

/** Abandoned checkouts matching a Shopify search query, newest first (max 100). */
async function findAbandonedCheckouts(searchQuery) {
    const data = await graphql(
          `query($q: String!) {
            abandonedCheckouts(first: 100, query: $q, sortKey: CREATED_AT, reverse: true) {
              nodes {
                id createdAt updatedAt completedAt abandonedCheckoutUrl
                totalPriceSet { shopMoney { amount currencyCode } }
                shippingAddress { firstName phone }
                billingAddress { firstName phone }
                lineItems(first: 3) { nodes { title quantity } }
              }
            }
          }`,
          { q: searchQuery }
    );
    return data.abandonedCheckouts.nodes;
}

/** Phone numbers (raw strings) on orders matching a search query (max 250). */
async function orderPhones(searchQuery) {
    const data = await graphql(
          `query($q: String!) {
            orders(first: 250, query: $q) {
              nodes { phone shippingAddress { phone } billingAddress { phone } }
            }
          }`,
          { q: searchQuery }
    );
    return data.orders.nodes.flatMap((o) =>
          [o.phone, o.shippingAddress?.phone, o.billingAddress?.phone].filter(Boolean)
    );
}

// Small JSON values the bot needs to remember across restarts are stored
// as metafields on this app's own installation (no extra scope needed).
const APP_DATA_NAMESPACE = 'wa_bot';

async function getAppData(key) {
    const data = await graphql(
          `query($key: String!) { currentAppInstallation { id metafield(namespace: "${APP_DATA_NAMESPACE}", key: $key) { value } } }`,
          { key }
    );
    const raw = data.currentAppInstallation.metafield?.value;
    let value = null;
    try {
          value = raw ? JSON.parse(raw) : null;
    } catch {
          value = null;
    }
    return { ownerId: data.currentAppInstallation.id, value };
}

async function setAppData(ownerId, key, value) {
    const data = await graphql(
          `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
          {
                m: [{ ownerId, namespace: APP_DATA_NAMESPACE, key, type: 'json', value: JSON.stringify(value) }],
          }
    );
    const errors = data.metafieldsSet.userErrors;
    if (errors.length) throw new Error(`metafieldsSet: ${errors.map((e) => e.message).join('; ')}`);
}

module.exports = {
    findAbandonedCheckouts,
    orderPhones,
    getAppData,
    setAppData,
    getPageByHandle,
    getOrderStatusMessage,
    isConfigured,
    getOrderById,
    addOrderTags,
    removeOrderTags,
    findOrders,
};
