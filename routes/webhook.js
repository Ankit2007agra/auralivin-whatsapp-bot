// routes/webhook.js
// Handles the WhatsApp Cloud API webhook: verification (GET) and
// incoming messages + auto-reply (POST).

const express = require('express');
const router = express.Router();
const whatsapp = require('../lib/whatsapp');
const shopify = require('../lib/shopify');
const cod = require('../lib/cod');
// AI assistant for normal (non-menu) questions - answers only from the
// store's knowledge + live catalog, and goes silent (hands off to your
// team) when it doesn't know. See lib/ai.js and lib/knowledge.js.
const ai = require('../lib/ai');
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

// WhatsApp RETRIES the webhook call if it doesn't think we responded fast
// enough - very common right after this server wakes up from sleeping on a
// free hosting tier (cold start can take 10-30+ seconds). Without this,
// the SAME customer message can arrive 2, 3, even more times and get a
// separate auto-reply EACH time - this is almost certainly why replies
// looked like they were "responding again and again". Keyed by WhatsApp's
// message id, which stays identical across retries of the same message.
const processedMessageIds = new Set();
const MAX_TRACKED_MESSAGE_IDS = 500; // simple cap so this can't grow forever

// Recent conversation per customer, so the AI understands follow-ups ("and
// in blue?"). Includes messages your team typed in the WhatsApp Business
// app. In-memory, last 12 messages, forgotten after 24h or a restart.
const chatHistory = new Map();
const HISTORY_MAX = 12;
function remember(number, role, content) {
  const now = Date.now();
  const list = (chatHistory.get(number) || []).filter((m) => now - m.at < HANDOFF_TTL_MS);
  list.push({ role, content: String(content).slice(0, 1500), at: now });
  chatHistory.set(number, list.slice(-HISTORY_MAX));
  if (chatHistory.size > 2000) chatHistory.delete(chatHistory.keys().next().value);
}
function historyFor(number) {
  return (chatHistory.get(number) || []).map(({ role, content }) => ({ role, content }));
}

// Messages of this many words or fewer ("hi", "track", "2", "agent") go
// through the numbered menu keywords. Longer, normal sentences go to the AI.
const SHORT_MESSAGE_WORDS = 3;

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

    // Your team replied to a customer from the WhatsApp Business app
    // (needs the "smb_message_echoes" webhook field - see README). A person
    // is now talking to this customer, so the bot steps back for that chat.
    if (value?.message_echoes?.length) {
      for (const echo of value.message_echoes) handleTeamMessage(echo);
      return;
    }

    const message = value?.messages?.[0];

    if (!message) {
      // Could be a status update (delivered/read) - nothing to do.
      return;
    }

    const from = message.from; // sender's WhatsApp number, digits only
    const messageId = message.id;
    const profileName = value?.contacts?.[0]?.profile?.name || '';

    // Duplicate delivery of a message we already handled - WhatsApp
    // retried the webhook (see processedMessageIds above). Ignore it so
    // the customer doesn't get a second (or third) reply.
    if (processedMessageIds.has(messageId)) {
      console.log(`[webhook] Duplicate delivery of message ${messageId} from ${from} - ignoring.`);
      return;
    }
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > MAX_TRACKED_MESSAGE_IDS) {
      // Sets preserve insertion order - drop the oldest tracked id.
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }

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

    // Customer tapped a button on one of our template messages (e.g.
    // "Confirm Order" / "Cancel Order" on the COD confirmation). Handled
    // even during human handoff, since it's an answer we asked for.
    const buttonPayload =
      message.type === 'button'
        ? message.button?.payload
        : message.interactive?.button_reply?.id;
    if (buttonPayload && (await cod.handleCodButton(from, buttonPayload))) {
      return;
    }

    if (message.type !== 'text') {
      // Photo, voice note, video, document, location... The bot can't
      // understand these, and they're often complaint proof or a product
      // screenshot - leave the chat to your team, and stay quiet in it.
      const caption = message[message.type]?.caption;
      remember(from, 'user', `[sent a ${message.type}${caption ? `: ${caption}` : ''}]`);
      if (!humanHandoffNumbers.has(from) || isHandoffExpired(from)) {
        humanHandoffNumbers.set(from, Date.now());
      }
      console.log(`[webhook] ${from} sent a ${message.type} - left for the team, bot silent in this chat.`);
      return;
    }

    const text = message.text.body.trim();
    const reply = await buildReply(from, text);
    remember(from, 'user', text);

    if (reply === null) {
      // null means "stay silent" - either the customer is in human
      // handoff, or their message didn't match a keyword (see the
      // "no match" comment in buildReply below) - nothing to send.
      console.log(`[webhook] Staying silent for ${from}: "${text}"`);
      return;
    }

    await whatsapp.sendText(from, reply);
    remember(from, 'assistant', reply);
    console.log(`[webhook] Auto-replied to ${from}: "${text}" -> "${reply.slice(0, 60)}..."`);
  } catch (err) {
    console.error('[webhook] Error handling incoming message:', err.response?.data || err.message);
  }
});

// A message your team typed in the WhatsApp Business app (coexistence
// echo). Pause the bot in that chat - the safety-net expiry below resumes
// it after 24h - and remember it so the AI has context if it's needed later.
function handleTeamMessage(echo) {
  const customer = echo.to;
  if (!customer || echo.type === 'revoke' || echo.type === 'edit') return;
  humanHandoffNumbers.set(customer, Date.now());
  awaitingOrderNumber.delete(customer);
  greetedNumbers.add(customer);
  const body = echo.text?.body || `[sent a ${echo.type}]`;
  remember(customer, 'assistant', `[Team] ${body}`);
  console.log(`[webhook] Team replied to ${customer} from the app - bot paused in this chat.`);
}

// True if this sender should never get an automated reply (marketplace
// notification, courier, etc.) - see config/excludedSenders.js.
function isExcludedSender(from, profileName) {
  if (excluded.numbers.includes(from)) return true;
  const lowerName = profileName.toLowerCase();
  if (lowerName && excluded.nameKeywords.some((kw) => lowerName.includes(kw))) return true;
  return false;
}

// Whole-word keyword matching. Plain substring matching caused wrong
// replies in the live logs - e.g. "Bye this product" matched "hi" (inside
// "this"), and "ty" / "hey" hide inside "quality" / "they". Single-digit
// menu numbers ("1".."5") only count when they're the whole message, so a
// phone number or order number like "2586" doesn't trigger menu option 2.
function matchesKeyword(lowerText, keyword) {
  if (/^\d$/.test(keyword)) {
    return lowerText.replace(/[^a-z0-9]/g, '') === keyword;
  }
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(lowerText);
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

  const isShort = text.split(/\s+/).filter(Boolean).length <= SHORT_MESSAGE_WORDS;
  const useAI = ai.isConfigured() && !isShort;

  // Order number already in the message ("where is my order #2586?") -
  // look it up live, whatever the message length.
  const trackRule = rules.rules.find((r) => r.trackOrder);
  if (/\d{3,7}/.test(text) && trackRule && trackRule.match.some((k) => matchesKeyword(lower, k))) {
    greetedNumbers.add(from);
    return orderStatusReply(text);
  }

  // First message: show the menu - unless it's a real question and the AI
  // is on, in which case answering the question is more useful than a menu.
  if (rules.greetOnFirstMessage && !greetedNumbers.has(from)) {
    greetedNumbers.add(from);
    if (!useAI) return rules.greeting;
  }

  if (!useAI) {
    const keywordReply = keywordRuleReply(from, lower);
    if (keywordReply !== null || !ai.isConfigured()) return keywordReply;
  }

  // A normal sentence - let the AI answer from the store's knowledge.
  const result = await ai.getAssistantReply(historyFor(from), text);
  if (result === null) {
    // AI call failed - fall back to the menu keywords, else stay silent.
    return keywordRuleReply(from, lower);
  }
  if (result.handoff) {
    // The AI doesn't know / a person should handle this. Say nothing and
    // leave the chat to the team (they see it in the WhatsApp Business app).
    humanHandoffNumbers.set(from, Date.now());
    console.log(`[webhook] AI handed ${from} to the team (${result.reason || 'no reason'}): "${text}"`);
    return null;
  }
  if (result.ignore) return null; // "ok" / "thanks" - nothing to say
  return result.reply;
}

// The numbered-menu keyword rules from config/autoReplyRules.js. Returns
// the reply, or null if no keyword matched (= stay silent).
function keywordRuleReply(from, lower) {
  for (const rule of rules.rules) {
    if (rule.match.some((keyword) => matchesKeyword(lower, keyword))) {
      if (rule.trackOrder) {
        awaitingOrderNumber.add(from);
      }
      if (rule.humanHandoff) {
        // Customer wants a real person. Send the one canned
        // "connecting you" message, then go silent in this chat.
        humanHandoffNumbers.set(from, Date.now());
      }
      return rule.reply;
    }
  }
  // No keyword matched - stay silent (see config/autoReplyRules.js
  // `fallback` if you ever want a canned reply here instead).
  return null;
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
