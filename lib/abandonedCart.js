// lib/abandonedCart.js
// WhatsApp reminders for customers who left items in their cart.
//
// Every ~10 minutes runAbandonedCartSweep() runs (from the in-server timer
// in server.js, and from GET /cron/abandoned-carts):
//   1. Asks Shopify for open, not-recovered abandoned checkouts created in
//      the last LOOKBACK_HOURS whose last activity was REMIND_AFTER_MINUTES+ ago.
//   2. Each checkout gets up to 3 messages (a "sequence"):
//        step 1  ~1 hour after the customer left   store.cartTemplates[0]
//        step 2  ~24 hours after step 1            store.cartTemplates[1]
//        step 3  ~48 hours after step 1            store.cartTemplates[2]  (discount code)
//      A store with fewer templates simply gets fewer steps.
//   3. The sequence stops as soon as the checkout is completed/recovered
//      (Shopify stops returning it), the phone places any order, or the
//      customer replies STOP.
//   4. Skips a checkout if it has no usable phone, or that phone already
//      started a sequence for another cart in the last 7 days.
//   5. Nothing is sent 9pm-9am IST - due messages wait for the morning.
//
// Sequence progress and opt-outs are stored in a metafield on this app's
// own installation in Shopify, so a Render restart never causes a repeat.
//
// Every template: Marketing, English US, body {{1}} = first name,
// {{2}} = item summary, one URL button "https://<store domain>/{{1}}" whose
// dynamic suffix = path of the checkout's recovery link.

const whatsapp = require('./whatsapp');
const stores = require('./stores');
const { normalizePhone } = require('./cod');

const TEMPLATE_LANG = process.env.CART_TEMPLATE_LANGUAGE || 'en_US';
const REMIND_AFTER_MINUTES = Number(process.env.CART_REMIND_AFTER_MINUTES || 60);
// Hours after step 1 at which step 2 and step 3 become due.
const STEP_DELAYS_HOURS = [0, Number(process.env.CART_STEP2_HOURS || 24), Number(process.env.CART_STEP3_HOURS || 48)];
const LOOKBACK_HOURS = 96; // step 3 at 48h + up to 12h quiet-hours wait, with margin
const ORDER_LOOKBACK_DAYS = 4;
const PER_PHONE_COOLDOWN_DAYS = 7;
const MAX_SENDS_PER_SWEEP = 20;
const DATA_KEY = 'abandoned_cart';

// Opt-out words a customer can reply with.
const STOP_WORDS = ['stop', 'unsubscribe', 'stop promotions', 'stop messages'];

let lastSweepAt = 0;
let sweepRunning = false;
const sentThisProcess = new Set(); // extra in-memory guard: "<checkoutId>#<step>"

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

// The template's button is "https://<domain>/{{1}}", so we pass the
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
  const sent = {};
  for (const [phone, at] of Object.entries(data.sent || {})) {
    if (now - at < PER_PHONE_COOLDOWN_DAYS * 24 * 3600 * 1000) sent[phone] = at;
  }
  // seq: { [checkoutId]: { phone, step, firstAt, lastAt } }
  const seq = {};
  for (const [id, s] of Object.entries(data.seq || {})) {
    if (s && now - s.firstAt < (LOOKBACK_HOURS + 24) * 3600 * 1000) seq[id] = s;
  }
  // Checkouts reminded by the old single-message version: never message again.
  const checkouts = (data.checkouts || []).slice(-300);
  return { sent, seq, checkouts, optOut: data.optOut || [] };
}

async function loadData(shopify) {
  const { ownerId, value } = await shopify.getAppData(DATA_KEY);
  return { ownerId, data: pruneData(value || {}) };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - work out who WOULD get a message, send nothing.
 */
async function runAbandonedCartSweep({ dryRun = false } = {}) {
  const connected = stores.connected();
  if (!connected.length) return { skipped: 'shopify-not-configured' };
  if (!dryRun && (sweepRunning || Date.now() - lastSweepAt < 60 * 1000)) return { skipped: 'cooldown' };

  const hour = istHour();
  const quietHours = hour < 9 || hour >= 21;
  if (quietHours && !dryRun) return { skipped: 'quiet-hours (9pm-9am IST)' };

  if (!dryRun) {
    lastSweepAt = Date.now();
    sweepRunning = true;
  }
  try {
    const result = {};
    for (const store of connected) {
      result[store.key] = await sweepStore(store, dryRun).catch((e) => {
        console.error(`[cart] ${store.name} sweep failed:`, e.message);
        return { error: e.message };
      });
    }
    return result;
  } finally {
    if (!dryRun) sweepRunning = false;
  }
}

async function sweepStore(store, dryRun) {
  const shopify = store.shopify;
  const templates = (store.cartTemplates || []).filter(Boolean);

  const now = Date.now();
  const since = new Date(now - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const quietBefore = new Date(now - REMIND_AFTER_MINUTES * 60 * 1000).toISOString();
  const checkouts = await shopify.findAbandonedCheckouts(
    `status:open AND recovery_state:not_recovered AND created_at:>='${since}' AND updated_at:<='${quietBefore}'`
  );

  const stats = {
    found: checkouts.length,
    steps: templates.length,
    noPhone: 0,
    alreadyOrdered: 0,
    optedOut: 0,
    otherCartRecently: 0,
    finished: 0,
    notDueYet: 0,
    due: { step1: 0, step2: 0, step3: 0 },
    sent: { step1: 0, step2: 0, step3: 0 },
    failed: 0,
    dryRun,
  };
  if (!checkouts.length || !templates.length) return stats;

  const orderSince = new Date(now - ORDER_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
  const orderedPhones = new Set(
    (await shopify.orderPhones(`created_at:>='${orderSince}'`)).map(normalizePhone).filter(Boolean)
  );

  const { ownerId, data } = await loadData(shopify);
  const legacyDone = new Set(data.checkouts);
  const optOut = new Set(data.optOut);
  const phonesThisSweep = new Set();
  let sentCount = 0;
  let changed = false;

  // Oldest first, so follow-ups go out before brand-new carts if we hit the cap.
  for (const c of [...checkouts].reverse()) {
    if (c.completedAt || legacyDone.has(c.id)) {
      stats.finished += 1;
      continue;
    }
    const state = data.seq[c.id];
    const phone = state?.phone || normalizePhone(c.shippingAddress?.phone || c.billingAddress?.phone);
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

    const step = state ? state.step + 1 : 1; // 1-based step to send next
    if (step > templates.length) {
      stats.finished += 1;
      continue;
    }
    if (state) {
      const dueAt = state.firstAt + STEP_DELAYS_HOURS[step - 1] * 3600 * 1000;
      if (now < dueAt) {
        stats.notDueYet += 1;
        continue;
      }
    } else if ((data.sent[phone] && Date.now() - data.sent[phone] < PER_PHONE_COOLDOWN_DAYS * 864e5) ||
      Object.values(data.seq).some((s) => s.phone === phone)) {
      // This phone already started a sequence for a different cart.
      stats.otherCartRecently += 1;
      continue;
    }
    if (phonesThisSweep.has(phone) || sentThisProcess.has(`${c.id}#${step}`)) {
      stats.otherCartRecently += 1;
      continue;
    }
    const suffix = recoverySuffix(c.abandonedCheckoutUrl);
    if (!suffix) {
      stats.failed += 1;
      continue;
    }

    stats.due[`step${step}`] += 1;
    phonesThisSweep.add(phone);
    if (dryRun || sentCount >= MAX_SENDS_PER_SWEEP) continue;

    const name = c.shippingAddress?.firstName || c.billingAddress?.firstName || 'there';
    const template = templates[step - 1];
    try {
      await whatsapp.sendTemplate(phone, template, TEMPLATE_LANG, [
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
      sentCount += 1;
      stats.sent[`step${step}`] += 1;
      sentThisProcess.add(`${c.id}#${step}`);
      const at = Date.now();
      data.seq[c.id] = { phone, step, firstAt: state?.firstAt || at, lastAt: at };
      if (step === 1) data.sent[phone] = at;
      changed = true;
      console.log(`[cart] ${store.name}: step ${step} (${template}) sent to ${phone} for ${c.id}`);
    } catch (e) {
      stats.failed += 1;
      console.error(
        `[cart] ${store.name}: step ${step} (${template}) failed for ${phone}:`,
        e.response?.data?.error?.message || e.message
      );
    }
  }

  if (changed) {
    await shopify.setAppData(ownerId, DATA_KEY, pruneData(data)).catch((e) =>
      console.error('[cart] Could not save cart-reminder progress:', e.message)
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
  // One WhatsApp number for every brand - opt out of all of them.
  for (const store of stores.connected()) {
    try {
      const { ownerId, data } = await loadData(store.shopify);
      if (!data.optOut.includes(from)) {
        data.optOut.push(from);
        await store.shopify.setAppData(ownerId, DATA_KEY, data);
      }
    } catch (e) {
      console.error(`[cart] Could not save opt-out in ${store.name}:`, e.message);
    }
  }
  console.log(`[cart] ${from} opted out of cart reminders.`);
  return `Done - you won't get cart reminders or offers from ${stores.brandNames()} on WhatsApp anymore. You can still message us here any time.`;
}

module.exports = { runAbandonedCartSweep, handleOptOut, itemSummary, recoverySuffix, istHour };
