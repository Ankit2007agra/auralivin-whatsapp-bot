// routes/webhook.js
// Handles the WhatsApp Cloud API webhook: verification (GET) and
// incoming messages + auto-reply (POST).

const express = require('express');
const router = express.Router();
const whatsapp = require('../lib/whatsapp');
const shopify = require('../lib/shopify');
// lib/ai.js is intentionally NOT wired in here right now - "Talk to an
// Agent" now hands off to a real human (see humanHandoffNumbers below)
// instead of the AI, since the AI was replying instead of a person and
// sometimes gave wrong answers. The file is kept in case you want to use
// it for something more constrained later (e.g. an FAQ-only assistant).
const rules = require('../config/autoReplyRules');
const excluded = require('../config/excludedSenders');

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// Tracks phone numbers we've already greeted, so we don't repeat the
// greeting on every message. In-memory only - resets on server restart.
// For a persistent version, swap this Set for a small database table.
const greetedNumbers = new Set();

// Tracks phone numbers we just asked for an Order Number, so their very
// next message is treated as that order number instead of being matched
// against the normal keyword rules. In-memory only, same caveat as above.
const awaitingOrderNumber = new Set();

// Tracks phone numbers who asked for a HUMAN ("Talk to an Agent"). Once a
// number is in here, the bot goes completely silent for it - no keyword
// replies, no AI, nothing - so a real person can take over the
// conversation in WhatsApp without the bot talking over them. Value is the
// timestamp (ms) they were handed off, used for the safety-net expiry below.
// In-memory only, same caveat as above.
const humanHandoffNumbers = new Map();

// If a customer has been sitting in human-handoff for longer than this with
// no one clearing it, the bot resumes normal auto-replies automatically -
// a safety net so a forgotten conversation doesn't stay silent forever.
// Adjust to taste (currently 24 hours).
const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

// Typing any of these (as a customer, any time) cancels human-handoff / AI
// mode and goes back to the numbered menu.
const MENU_RESET_KEYWORDS = ['menu', 'main menu', 'restart', 'start over'];

// --- 1) Webhook verification (Meta calls this once when you save the
//        webhook URL in the App Dashboard) ---
router.get('/', (req, res) => {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

           if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                 console.log('[webhook] Verified successfully.');
                 return res.status(200).send(challenge);
           }
      console.warn('[webhook] Verification failed - token mismatch.');
      return res.sendStatus(403);
});

// --- 2) Incoming events (messages, statuses, etc.) ---
router.post('/', async (req, res) => {
      // Always ack immediately - Meta retries aggressively if you don't respond
            // within a few seconds.
            res.sendStatus(200);

            try {
                  const entry = req.body.entry?.[0];
                  const change = entry?.changes?.[0];
                  const value = change?.value;
                  const message = value?.messages?.[0];

      if (!message) {
            // Could be a status update (delivered/read) - nothing to do.
                  return;
      }

      const from = message.from; // sender's WhatsApp number, digits only
      const messageId = message.id;
      const profileName = value?.contacts?.[0]?.profile?.name || '';

      // Marketplace / courier / other non-customer sender - ignore entirely,
      // don't even mark as read. Check this BEFORE anything else so nothing
      // downstream (menu, AI, order lookup) ever sees these messages.
      if (isExcludedSender(from, profileName)) {
            console.log(`[webhook] Ignored message from excluded sender ${from} (profile: "${profileName}").`);
            return;
      }

      // Mark the message as read (blue ticks) - nice UX touch.
      whatsapp.markAsRead(messageId).catch((e) =>
            console.error('[webhook] markAsRead failed:', e.response?.data || e.message)
                                           );

      if (message.type !== 'text') {
            if (humanHandoffNumbers.has(from) && !isHandoffExpired(from)) {
                  return; // stay silent - a human is handling this conversation
            }
            await whatsapp.sendText(
                  from,
                  "Thanks for your message! We currently reply to text messages - please type what you need and we'll help right away."
                  );
            return;
      }

      const text = message.text.body.trim();
                  const reply = await buildReply(from, text);

      if (reply === null) {
            // null means "stay silent" (customer is in human handoff) -
            // nothing to send.
            console.log(`[webhook] In human handoff, staying silent for ${from}: "${text}"`);
            return;
      }

      await whatsapp.sendText(from, reply);
                  console.log(`[webhook] Auto-replied to ${from}: "${text}" -> "${reply.slice(0, 60)}..."`);
            } catch (err) {
                  console.error('[webhook] Error handling incoming message:', err.response?.data || err.message);
            }
});

// True if this sender should never get an automated reply (marketplace
// notification, courier, etc.) - see config/excludedSenders.js.
function isExcludedSender(from, profileName) {
      if (excluded.numbers.includes(from)) return true;
      const lowerName = profileName.toLowerCase();
      if (lowerName && excluded.nameKeywords.some((kw) => lowerName.includes(kw))) return true;
      return false;
}

function isHandoffExpired(from) {
      const startedAt = humanHandoffNumbers.get(from);
      if (!startedAt) return true;
      return Date.now() - startedAt > HANDOFF_TTL_MS;
}

async function buildReply(from, text) {
      const lower = text.toLowerCase();

// A customer waiting on / being handled by a human can type "menu" to
// cancel that and go back to the numbered options.
if (humanHandoffNumbers.has(from)) {
      if (MENU_RESET_KEYWORDS.includes(lower)) {
            humanHandoffNumbers.delete(from);
            return rules.greeting;
      }
      if (isHandoffExpired(from)) {
            // Safety net: no one cleared it, resume normal auto-replies.
            humanHandoffNumbers.delete(from);
            // fall through to the normal rules below
      } else {
            // A human is handling this conversation - the bot must not
            // send anything, so it doesn't talk over them.
            return null;
      }
}

// If we just asked this customer for their Order Number, treat this
// message as the answer and try a live Shopify lookup before anything
// else - unless it clearly isn't a number (e.g. they typed "catalog"
// instead), in which case fall through to the normal rules below.
if (awaitingOrderNumber.has(from)) {
      awaitingOrderNumber.delete(from);
      if (/\d{3,7}/.test(text)) {
            return orderStatusReply(text);
      }
}

if (rules.greetOnFirstMessage && !greetedNumbers.has(from)) {
      greetedNumbers.add(from);
      return rules.greeting;
}

for (const rule of rules.rules) {
      if (rule.match.some((keyword) => lower.includes(keyword))) {
            if (rule.trackOrder) {
                  awaitingOrderNumber.add(from);
            }
            if (rule.humanHandoff) {
                  // Customer wants a real person. Send the one canned
                  // "connecting you" message, then go silent - the AI must
                  // NOT keep messaging this customer after this point.
                  humanHandoffNumbers.set(from, Date.now());
                  return rule.reply;
            }
            return rule.reply;
      }
}

return rules.fallback;
}

// Looks up the order in Shopify (see lib/shopify.js) and returns a reply
// for whatever happened: found, not found, or lookup not set up / failed.
async function orderStatusReply(text) {
      try {
            const status = await shopify.getOrderStatusMessage(text);

      if (status === null) {
            // Shopify env vars aren't configured - keep the old behavior.
            return 'Got it, thanks! Our team will check that order and update you here shortly.';
      }
            if (status === undefined) {
                  return "We couldn't find an order with that number. Please double-check it and send it again, or type \"agent\" to reach our support team.";
            }
            return status;
      } catch (err) {
            console.error('[webhook] Shopify order lookup failed:', err.response?.data || err.message);
            return 'Sorry, we\'re having trouble checking that order right now. Please type "agent" and our team will look it up for you.';
      }
}

module.exports = router;
