// routes/webhook.js
// Handles the WhatsApp Cloud API webhook: verification (GET) and
// incoming messages + auto-reply (POST).

const express = require('express');
const router = express.Router();
const whatsapp = require('../lib/whatsapp');
const rules = require('../config/autoReplyRules');

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// Tracks phone numbers we've already greeted, so we don't repeat the
// greeting on every message. In-memory only - resets on server restart.
// For a persistent version, swap this Set for a small database table.
const greetedNumbers = new Set();

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

      // Mark the message as read (blue ticks) - nice UX touch.
      whatsapp.markAsRead(messageId).catch((e) =>
              console.error('[webhook] markAsRead failed:', e.response?.data || e.message)
                                               );

      if (message.type !== 'text') {
              await whatsapp.sendText(
                        from,
                        "Thanks for your message! We currently reply to text messages - please type what you need and we'll help right away."
                      );
              return;
      }

      const text = message.text.body.trim();
                    const reply = buildReply(from, text);

      await whatsapp.sendText(from, reply);
                    console.log(`[webhook] Auto-replied to ${from}: "${text}" -> "${reply.slice(0, 60)}..."`);
              } catch (err) {
                    console.error('[webhook] Error handling incoming message:', err.response?.data || err.message);
              }
});

function buildReply(from, text) {
    const lower = text.toLowerCase();

  if (rules.greetOnFirstMessage && !greetedNumbers.has(from)) {
        greetedNumbers.add(from);
        return rules.greeting;
  }

  for (const rule of rules.rules) {
        if (rule.match.some((keyword) => lower.includes(keyword))) {
                return rule.reply;
        }
  }

  return rules.fallback;
}

module.exports = router;
