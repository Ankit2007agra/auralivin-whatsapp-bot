// lib/abandonedCart.js
// WhatsApp reminder for customers who left items in their cart.
//
// Every 10 minutes the GitHub Actions keep-alive workflow calls
// GET /cron/abandoned-carts, which runs runAbandonedCartSweep():
//   1. Asks Shopify for open abandoned checkouts created in the last 24h
//      whose last activity was at least REMIND_AFTER_MINUTES ago (default 60).
//   2. Skips a checkout if:
//        - it has no usable phone number,
//        - the same phone placed an order in the last 3 days (GoKwik orders
//          often leave the Shopify checkout looking "abandoned"),
//        - that phone already got a cart reminder in the last 7 days,
//        - that phone replied STOP to opt out,
//        - it's outside 9am-9pm IST (it waits for the next morning instead).
//   3. Sends ONE approved WhatsApp template with a "Complete your order"
//      button that opens the customer's saved checkout.
//
// What was sent (and who opted out) is stored in a metafield on this app's
// own installation in Shopify, so a Render restart never causes a repeat.
//
// Template (Marketing category, English US) - see README:
//   name: abandoned_cart_reminder
//   body: Hi {{1}}, you left {{2}} in your Auralivin cart. Your items are
//         still saved - tap below to complete your order.
//   button: URL "Complete your order" -> https://auralivin.com/{{1}}
//           (dynamic suffix = path of the checkout's recovery link)

const whatsapp = require('./whatsapp');
const shopify = require('./shopify');
const { normalizePhone } = require('./cod');

const TEMPLATE = process.env.CART_TEMPLATE_NAME || 'abandoned_cart_reminder';
const TEMPLATE_LANG = process.env.CART_TEMPLATE_LANGUAGE || 'en_US';
const REMIND_AFTER_MINUTES = Number(process.env.CART_REMIND_AFTER_MINUTES || 60);
const LOOKBACK_HOURS = 24;
const ORDER_LOOKBACK_DAYS = 3;
const PER_PHONE_COOLDOWN_DAYS = 7;
const MAX_SENDS_PER_SWEEP = 20;
const DATA_KEY = 'abandoned_cart';

// Opt-out words a customer can reply with.
const STOP_WORDS = ['stop', 'unsubscribe', 'stop promotions', 'stop messages'];

let lastSweepAt = 0;
const sentThisProcess = new Set(); // extra in-memory guard

function istHour(date = new Date()) {
  // IST = UTC+5:30
  const ist = new Date(date.getTime() + 330 * 60 * 1000);
  return ist.getUTCHours();
}

function itemSummary(checkout) {
  const items = checkout.lineItems?.nodes || [];
  if (!items.length) return 'some items';
  let first = String(items[0].title || 'an item').trim();
  if (first.length > 60) first = `${first.slice(0, 57)}...`;
  // lineItems(first: 3) only tells us "at least 3" - say "more" not a number.
  if (items.length === 1) return first;
  if (items.length === 2) return `${first} and 1 more item`;
  return `${first} and more items`;
}

// The template's button is "https://auralivin.com/{{1}}", so we pass the
// recovery link's path + query (works whatever domain Shopify reports).
function recoverySuffix(url) {
  try {
    const u = new URL(url);
    return `${u.pathname.replace(/^\//, '')}${u.search}`;
  } catch {
    return null;
  }
}

function pruneData(data) {
  const now = Date.now();
  const keepFor = PER_PHONE_COOLDOWN_DAYS * 24 * 3600 * 1000;
  const sent = {};
  for (const [phone, at] of Object.entries(data.sent || {})) {
    if (now - at < keepFor) sent[phone] = at;
  }
  const checkouts = (data.checkouts || []).slice(-300);
  return { sent, checkouts, optOut: data.optOut || [] };
}

async function loadData() {
  const { ownerId, value } = await shopify.getAppData(DATA_KEY);
  return { ownerId, data: pruneData(value || {}) };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - work out who WOULD get a message, send nothing.
 */
async function runAbandonedCartSweep({ dryRun = false } = {}) {
  if (!shopify.isConfigured()) return { skipped: 'shopify-not-configured' };
  if (!dryRun && Date.now() - lastSweepAt < 60 * 1000) return { skipped: 'cooldown' };

  const hour = istHour();
  const quietHours = hour < 9 || hour >= 21;
  if (quietHours && !dryRun) return { skipped: 'quiet-hours (9pm-9am IST)' };
  if (!dryRun) lastSweepAt = Date.now();

  const now = Date.now();
  const since = new Date(now - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const quietBefore = new Date(now - REMIND_AFTER_MINUTES * 60 * 1000).toISOString();
  const checkouts = await shopify.findAbandonedCheckouts(
    `status:open AND recovery_state:not_recovered AND created_at:>='${since}' AND updated_at:<='${quietBefore}'`
  );

  const stats = {
    found: checkouts.length,
    noPhone: 0,
    alreadyOrdered: 0,
    alreadyReminded: 0,
    optedOut: 0,
    eligible: 0,
    sent: 0,
    failed: 0,
    dryRun,
  };
  if (!checkouts.length) return stats;

  const orderSince = new Date(now - ORDER_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
  const orderedPhones = new Set(
    (await shopify.orderPhones(`created_at:>='${orderSince}'`)).map(normalizePhone).filter(Boolean)
  );

  const { ownerId, data } = await loadData();
  const doneCheckouts = new Set(data.checkouts);
  const optOut = new Set(data.optOut);
  const phonesThisSweep = new Set();
  let changed = false;

  for (const c of checkouts) {
    if (c.completedAt || doneCheckouts.has(c.id) || sentThisProcess.has(c.id)) {
      stats.alreadyReminded += 1;
      continue;
    }
    const phone = normalizePhone(c.shippingAddress?.phone || c.billingAddress?.phone);
    if (!phone) {
      stats.noPhone += 1;
      continue;
    }
    if (optOut.has(phone)) {
      stats.optedOut += 1;
      continue;
    }
    if (orderedPhones.has(phone)) {
      stats.alreadyOrdered += 1;
      continue;
    }
    if (data.sent[phone] || phonesThisSweep.has(phone)) {
      stats.alreadyReminded += 1;
      continue;
    }
    const suffix = recoverySuffix(c.abandonedCheckoutUrl);
    if (!suffix) {
      stats.failed += 1;
      continue;
    }
    stats.eligible += 1;
    phonesThisSweep.add(phone);
    if (dryRun || stats.sent >= MAX_SENDS_PER_SWEEP) continue;

    const name = c.shippingAddress?.firstName || c.billingAddress?.firstName || 'there';
    try {
      await whatsapp.sendTemplate(phone, TEMPLATE, TEMPLATE_LANG, [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: name },
            { type: 'text', text: itemSummary(c) },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: suffix }],
        },
      ]);
      stats.sent += 1;
      sentThisProcess.add(c.id);
      data.sent[phone] = Date.now();
      data.checkouts.push(c.id);
      changed = true;
      console.log(`[cart] Reminder sent to ${phone} for abandoned checkout ${c.id}`);
    } catch (e) {
      stats.failed += 1;
      console.error(`[cart] Reminder failed for ${phone}:`, e.response?.data?.error?.message || e.message);
    }
  }

  if (changed) {
    await shopify.setAppData(ownerId, DATA_KEY, pruneData(data)).catch((e) =>
      console.error('[cart] Could not save sent-reminder list:', e.message)
    );
  }
  return stats;
}

/**
 * Called from the WhatsApp webhook for every text message. If it's an
 * opt-out ("STOP"), records it and returns a confirmation to send;
 * otherwise returns null and the message is handled normally.
 */
async function handleOptOut(from, text) {
  if (!STOP_WORDS.includes(String(text || '').trim().toLowerCase())) return null;
  if (shopify.isConfigured()) {
    try {
      const { ownerId, data } = await loadData();
      if (!data.optOut.includes(from)) {
        data.optOut.push(from);
        await shopify.setAppData(ownerId, DATA_KEY, data);
      }
    } catch (e) {
      console.error('[cart] Could not save opt-out:', e.message);
    }
  }
  console.log(`[cart] ${from} opted out of cart reminders.`);
  return "Done - you won't get cart reminders or offers from Auralivin on WhatsApp anymore. You can still message us here any time.";
}

module.exports = { runAbandonedCartSweep, handleOptOut, itemSummary, recoverySuffix, istHour };
