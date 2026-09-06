// lib/ai.js
// Thin wrapper around the Anthropic Messages API. Used to give customers a
// natural, AI-generated reply once they ask for a human agent, instead of
// (or in addition to) a canned "someone will get back to you" message.
//
// Setup (one-time):
//   1) Create an API key at https://console.anthropic.com/settings/keys
//   2) Set ANTHROPIC_API_KEY in your .env / Render env vars.
//
// If ANTHROPIC_API_KEY isn't set, getAIReply() just returns null and
// webhook.js falls back to the old canned "connecting you" reply - nothing
// breaks without it.

const axios = require('axios');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
const API_VERSION = '2023-06-01';

function isConfigured() {
    return Boolean(API_KEY);
}

const SYSTEM_PROMPT =
    "You are a friendly, helpful customer support assistant for Auralivin, " +
    "an e-commerce store, chatting with a customer over WhatsApp. Keep " +
    "replies short (1-4 sentences) and conversational - this is a chat, " +
    "not an email. Be warm and genuinely helpful. If a customer asks about " +
    "something you can't actually verify or action yourself (an order's " +
    "exact status, approving a refund, changing an account) be upfront " +
    "that a teammate will need to confirm it, and ask for any details " +
    "(like an order number) that would help them out faster. Never invent " +
    "order numbers, prices, tracking details, or store policies you don't " +
    "actually know.";

/**
 * Gets an AI-generated reply for a customer's message.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} history - prior
 *   turns in this conversation (oldest first), NOT including the latest
 *   customer message.
 * @param {string} latestMessage - the customer's newest message.
 * @returns {Promise<string|null>} the reply, or null if AI isn't configured
 *   or the call failed (caller should fall back to a canned reply).
 */
async function getAIReply(history, latestMessage) {
    if (!isConfigured()) return null;

  try {
        const { data } = await axios.post(
                'https://api.anthropic.com/v1/messages',
          {
                    model: MODEL,
                    max_tokens: 300,
                    system: SYSTEM_PROMPT,
                    messages: [...history, { role: 'user', content: latestMessage }],
          },
          {
                    headers: {
                                'x-api-key': API_KEY,
                                'anthropic-version': API_VERSION,
                                'content-type': 'application/json',
                    },
                    timeout: 20000,
          }
              );
        const reply = data?.content?.[0]?.text;
        return reply ? reply.trim() : null;
  } catch (err) {
        console.error('[ai] Anthropic call failed:', err.response?.data || err.message);
        return null;
  }
}

module.exports = { getAIReply, isConfigured };
