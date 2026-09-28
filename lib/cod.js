// lib/cod.js
// Cash-on-Delivery (COD) order confirmation over WhatsApp.
//
// Flow:
//   1. A new Shopify order arrives (routes/shopifyWebhook.js). If it's COD,
//      sendCodConfirmation() sends the customer an approved template with
//      two quick-reply buttons - "Confirm Order" and "Cancel Order" - and
//      tags the order "COD-Pending" in Shopify.
//   2. The customer taps a button. WhatsApp delivers that to /webhook
//      (routes/webhook.js), which calls handleCodButton().
//        Confirm -> order tagged "COD-Confirmed", customer thanked.
//        Cancel  -> order tagged "COD-Cancelled-by-customer", customer told
//                   it's noted, store owner alerted. The order is NOT
//                   cancelled automatically - you cancel it in Shopify.
//   3. runCodReminderSweep() (hit every 10 minutes by the GitHub Actions
//      keep-alive workflow via GET /cron/cod-reminders) sends ONE reminder
//      to COD orders still unconfirmed ~6 hours after they were placed, and
//      tags them "COD-Reminder-Sent" so it never repeats.
//
// All state lives in Shopify order tags, so nothing is lost if Render
// restarts. You can also filter orders by these tags in Shopify Admin.
//
// Needs (Render env vars):
//   SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_API_TOKEN, with the Shopify app's
//   Admin API scopes "read_orders" AND "write_orders" (write is for tags).
//   An approved WhatsApp template - see COD_TEMPLATE below and README.

const whatsapp = require('./whatsapp');
const shopify = require('./shopify');

// Name + language of the approved template. Body must have 3 variables:
//   {{1}} customer first name, {{2}} order number, {{3}} order total
// and exactly two Quick Reply buttons, in this order:
//   button 0: "Confirm Order"    button 1: "Cancel Order"
const COD_TEMPLATE = process.env.COD_TEMPLATE_NAME || 'cod_order_confirmation';
// Reminder uses the same template unless you create a separate one.
const COD_REMINDER_TEMPLATE = process.env.COD_REMINDER_TEMPLATE_NAME || COD_TEMPLATE;
const COD_TEMPLATE_LANG = process.env.COD_TEMPLATE_LANGUAGE || 'en_US';

const REMINDER_AFTER_HOURS = Number(process.env.COD_REMINDER_AFTER_HOURS || 6);

const TAG_PENDING = 'COD-Pending';
const TAG_CONFIRMED = 'COD-Confirmed';
const TAG_CANCELLED = 'COD-Cancelled-by-customer';
const TAG_REMINDED = 'COD-Reminder-Sent';

const OWNER_NUMBERS = (process.env.STORE_OWNER_WHATSAPP_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Matches Shopify's built-in "Cash on Delivery (COD)" manual payment method
// and most COD checkout apps (e.g. "cash_on_delivery", "COD").
function isCodOrder(order) {
  const gateways = [
    ...(order.payment_gateway_names || []),
    order.gateway || '',
  ].join(' | ');
  return /cash[\s_-]*on[\s_-]*delivery|\bcod\b/i.test(gateways);
}

// Shopify phone -> WhatsApp format (digits only, with country code).
// Indian 10-digit numbers without a country code get "91" added.
function normalizePhone(rawPhone) {
  if (!rawPhone) return null;
  let digits = String(rawPhone).replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length < 11) return null;
  return digits;
}

function templateComponents(firstName, orderName, total, orderId) {
  return [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: firstName || 'there' },
        { type: 'text', text: orderName },
        { type: 'text', text: total },
      ],
    },
    // The payload rides along with the button, so when the customer taps
    // it we know exactly which order they mean - even with several orders.
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: `COD_CONFIRM:${orderId}` }],
    },
    {
      type: 'button',
      sub_type: 'quick_reply',
      index: '1',
      parameters: [{ type: 'payload', payload: `COD_CANCEL:${orderId}` }],
    },
  ];
}

/**
 * Called from the Shopify "order created" webhook for COD orders.
 * `order` is the raw REST webhook payload.
 */
// Shopify re-sends a webhook if it doesn't get a fast 200 (e.g. while
// Render is cold-starting). Remember recent order ids so a retried
// delivery doesn't message the customer twice.
const recentCodOrderIds = new Set();

async function sendCodConfirmation(order) {
  const key = String(order.id);
  if (recentCodOrderIds.has(key)) {
    console.log(`[cod] Duplicate webhook for order ${order.name} - already asked, skipping.`);
    return;
  }
  recentCodOrderIds.add(key);
  if (recentCodOrderIds.size > 500) {
    recentCodOrderIds.delete(recentCodOrderIds.values().next().value);
  }

  const orderName = order.name || `#${order.order_number}`;
  const total = order.total_price ? `${order.currency} ${order.total_price}` : 'N/A';
  const firstName =
    order.customer?.first_name || order.shipping_address?.first_name || 'there';
  const phone = normalizePhone(
    order.phone || order.customer?.phone || order.shipping_address?.phone ||
      order.billing_address?.phone
  );

  if (!phone) {
    console.log(`[cod] No usable phone on COD order ${orderName} - cannot ask for confirmation.`);
    await notifyOwners(`⚠️ COD order ${orderName} (${total}) has no usable phone number - please confirm it manually.`);
    return;
  }

  await whatsapp.sendTemplate(
    phone,
    COD_TEMPLATE,
    COD_TEMPLATE_LANG,
    templateComponents(firstName, orderName, total, order.id)
  );
  console.log(`[cod] Confirmation request sent to ${phone} for ${orderName}`);

  if (shopify.isConfigured()) {
    await shopify.addOrderTags(order.id, [TAG_PENDING]).catch((e) =>
      console.error(`[cod] Could not tag ${orderName} as ${TAG_PENDING}:`, e.message)
    );
  }
}

/**
 * Called from the WhatsApp webhook when a customer taps a template button.
 * Returns true if the payload was a COD button (handled), false otherwise.
 */
async function handleCodButton(from, payload) {
  const match = /^COD_(CONFIRM|CANCEL):(\d+)$/.exec(String(payload || ''));
  if (!match) return false;
  const action = match[1];
  const orderId = match[2];

  // Look up the order for its name/total and current tags, if we can.
  let order = null;
  if (shopify.isConfigured()) {
    order = await shopify.getOrderById(orderId).catch((e) => {
      console.error(`[cod] Order lookup failed for ${orderId}:`, e.message);
      return null;
    });
  }
  const orderName = order?.name || 'your order';
  const tags = order?.tags || [];

  // Already answered (e.g. they tapped twice, or tapped the reminder after
  // answering the first message) - don't flip-flop, just restate it.
  if (tags.includes(TAG_CONFIRMED) || tags.includes(TAG_CANCELLED)) {
    const state = tags.includes(TAG_CONFIRMED) ? 'confirmed' : 'marked for cancellation';
    await whatsapp.sendText(
      from,
      `Your order ${orderName} is already ${state}. If you'd like to change that, type "agent" and our team will help.`
    );
    return true;
  }
  if (order?.cancelledAt) {
    await whatsapp.sendText(from, `Your order ${orderName} has already been cancelled.`);
    return true;
  }

  if (action === 'CONFIRM') {
    if (order) {
      await shopify.addOrderTags(orderId, [TAG_CONFIRMED]).catch((e) =>
        console.error(`[cod] Tagging ${orderName} confirmed failed:`, e.message)
      );
      await shopify.removeOrderTags(orderId, [TAG_PENDING]).catch(() => {});
    }
    await whatsapp.sendText(
      from,
      `✅ Thank you! Your Cash on Delivery order ${orderName} is confirmed. We'll share tracking details here as soon as it ships.`
    );
    console.log(`[cod] ${from} CONFIRMED order ${orderName} (${orderId})`);
  } else {
    if (order) {
      await shopify.addOrderTags(orderId, [TAG_CANCELLED]).catch((e) =>
        console.error(`[cod] Tagging ${orderName} cancelled failed:`, e.message)
      );
      await shopify.removeOrderTags(orderId, [TAG_PENDING]).catch(() => {});
    }
    await whatsapp.sendText(
      from,
      `We've noted your request to cancel order ${orderName}. Our team will cancel it shortly - no payment is due. If this was a mistake, type "agent" and we'll help.`
    );
    await notifyOwners(
      `❌ COD order ${orderName} was CANCELLED by the customer (${from}) on WhatsApp. Please cancel it in Shopify.`
    );
    console.log(`[cod] ${from} CANCELLED order ${orderName} (${orderId})`);
  }
  return true;
}

/**
 * Sends ONE reminder to COD orders still pending REMINDER_AFTER_HOURS after
 * they were placed. Safe to call as often as you like - tags make it
 * idempotent and a short cooldown stops it running back-to-back.
 */
let lastSweepAt = 0;
async function runCodReminderSweep() {
  if (!shopify.isConfigured()) return { skipped: 'shopify-not-configured' };
  if (Date.now() - lastSweepAt < 60 * 1000) return { skipped: 'cooldown' };
  lastSweepAt = Date.now();

  const now = Date.now();
  const dueBefore = new Date(now - REMINDER_AFTER_HOURS * 3600 * 1000).toISOString();
  // Don't chase very old orders (e.g. the first time this runs).
  const notOlderThan = new Date(now - 48 * 3600 * 1000).toISOString();
  const query =
    `tag:'${TAG_PENDING}' AND -tag:'${TAG_REMINDED}' AND -tag:'${TAG_CONFIRMED}' ` +
    `AND -tag:'${TAG_CANCELLED}' AND status:open ` +
    `AND created_at:<='${dueBefore}' AND created_at:>='${notOlderThan}'`;

  const orders = await shopify.findOrders(query);
  let sent = 0;
  for (const o of orders) {
    const phone = normalizePhone(o.phone || o.shippingAddress?.phone);
    if (!phone) continue;
    const total = `${o.totalPriceSet.shopMoney.currencyCode} ${o.totalPriceSet.shopMoney.amount}`;
    const firstName = o.shippingAddress?.firstName || 'there';
    try {
      await whatsapp.sendTemplate(
        phone,
        COD_REMINDER_TEMPLATE,
        COD_TEMPLATE_LANG,
        templateComponents(firstName, o.name, total, o.legacyResourceId)
      );
      await shopify.addOrderTags(o.legacyResourceId, [TAG_REMINDED]);
      sent += 1;
      console.log(`[cod] Reminder sent to ${phone} for ${o.name}`);
    } catch (e) {
      console.error(`[cod] Reminder failed for ${o.name}:`, e.response?.data?.error?.message || e.message);
    }
  }
  return { checked: orders.length, sent };
}

// Alerts go to the store owner number(s). Free-form text only delivers if
// that number messaged the bot in the last 24h, so fall back to the
// existing order_confirmation template if plain text is rejected.
async function notifyOwners(text) {
  for (const owner of OWNER_NUMBERS) {
    try {
      await whatsapp.sendText(owner, text);
    } catch (e) {
      try {
        await whatsapp.sendTemplate(owner, 'order_confirmation', 'en_US', [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Auralivin Team' },
              { type: 'text', text: text.slice(0, 200) },
              { type: 'text', text: '-' },
            ],
          },
        ]);
      } catch (e2) {
        console.error(`[cod] Could not alert owner ${owner}:`, e2.response?.data?.error?.message || e2.message);
      }
    }
  }
}

module.exports = {
  isCodOrder,
  normalizePhone,
  sendCodConfirmation,
  handleCodButton,
  runCodReminderSweep,
};
