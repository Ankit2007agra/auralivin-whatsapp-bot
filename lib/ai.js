// lib/ai.js
// The WhatsApp AI assistant. When a customer writes normally (a real
// question, not a menu keyword), webhook.js asks this module for a reply.
//
// The golden rule: the AI only answers from what it's been given - the
// knowledge file, the team's Shopify "Bot knowledge" page and the live
// product catalog (see lib/knowledge.js). If the answer isn't there, or the
// message needs a person (complaint, refund, angry customer, specific order
// problem...), it returns { handoff: true } and the bot goes SILENT in that
// chat so your team can answer from the WhatsApp Business app.
//
// Setup: ANTHROPIC_API_KEY in Render env vars. Optional: ANTHROPIC_MODEL.
// Without a key, getAssistantReply() returns null and the bot behaves as
// before (menu keywords only, silent otherwise).

const axios = require('axios');
const knowledge = require('./knowledge');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
// Older Claude 3.x model IDs (like the one in the old .env.example) have
// been retired by Anthropic, so ignore them and use the current default.
const MODEL =
  process.env.ANTHROPIC_MODEL && !/^claude-3/.test(process.env.ANTHROPIC_MODEL)
    ? process.env.ANTHROPIC_MODEL
    : DEFAULT_MODEL;

function isConfigured() {
  return Boolean(API_KEY);
}

const INSTRUCTIONS = `You are the WhatsApp assistant for AuraLivin (auralivin.com), an Indian home décor, furniture and pet products brand. You are chatting with a customer on WhatsApp.

HOW TO ANSWER
- Use ONLY the facts in the KNOWLEDGE section below and earlier messages in this chat. Never invent or guess prices, stock, sizes, delivery dates, discounts, offers, COD rules, or policies. If a fact isn't written there, you don't know it.
- Keep it short: 1-3 sentences, friendly, plain text (no markdown, no headings). Reply in the customer's language/style (English, Hindi or Hinglish).
- When recommending or confirming a product, give its exact name, price and link from the catalog. Mention if it's sold out.
- For order status, tell them to type "track" and send their order number (you can't see orders yourself).

WHEN TO HAND OFF TO THE TEAM (handoff = true, reply = "")
- The answer is not clearly in the KNOWLEDGE, or you are not sure.
- Complaints, damaged/defective/wrong product, delivery problems, courier issues, an upset or angry customer.
- Requests that need someone to act: refund, return, exchange, cancellation, address or order changes, payment problems, bulk/wholesale/custom orders, price negotiation.
- Questions about a specific existing order beyond "how do I track it".
- The customer asks for a human, or the message is unclear, a voice note/photo reference you can't see, or unrelated to the store.
- A team member has already been replying in this chat and the customer is answering them.
It is MUCH better to hand off than to give a wrong or made-up answer.

WHEN NOTHING NEEDS SAYING (handoff = false, reply = "")
- The message is just an acknowledgement or small talk that needs no answer: "ok", "hmm", "👍", "thanks", "fine".

OUTPUT: respond with ONLY a JSON object, nothing else:
{"handoff": false, "reply": "<message to send the customer>"}
or
{"handoff": false, "reply": ""}   (nothing needs saying)
or
{"handoff": true, "reply": "", "reason": "<few words why>"}`;

function parseModelOutput(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (obj.handoff === true) return { handoff: true, reason: String(obj.reason || '') };
    const reply = String(obj.reply || '').trim();
    if (!reply) return { handoff: false, ignore: true };
    return { handoff: false, reply };
  } catch {
    return null;
  }
}

/**
 * @param {Array<{role:'user'|'assistant', content:string}>} history - earlier
 *   turns in this chat, oldest first (NOT including `message`). Messages the
 *   team typed themselves are included as assistant turns prefixed "[Team]".
 * @param {string} message - the customer's newest message.
 * @returns {Promise<{handoff:true, reason:string}|{handoff:false, reply:string}|{handoff:false, ignore:true}|null>}
 *   ignore = nothing needs saying (e.g. "ok"), stay quiet but DON'T hand off.
 *   null = AI not configured or the call failed (caller decides what to do).
 */
async function getAssistantReply(history, message) {
  if (!isConfigured()) return null;

  const recentText = [...history.slice(-4).map((h) => h.content), message].join(' ');
  const kb = await knowledge.buildKnowledge(recentText);

  // The API needs alternating user/assistant turns starting with user.
  const turns = [];
  for (const h of [...history, { role: 'user', content: message }]) {
    const last = turns[turns.length - 1];
    if (last && last.role === h.role) last.content += `\n${h.content}`;
    else turns.push({ role: h.role, content: h.content });
  }
  if (turns[0].role !== 'user') turns.unshift({ role: 'user', content: '(earlier in this chat)' });

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 400,
        temperature: 0.2,
        system: [
          { type: 'text', text: INSTRUCTIONS },
          { type: 'text', text: `KNOWLEDGE\n\n${kb}` },
        ],
        messages: turns,
      },
      {
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 25000,
      }
    );
    const text = (data.content || []).map((c) => c.text || '').join('');
    const result = parseModelOutput(text);
    if (!result) {
      console.error('[ai] Could not parse model output, handing off:', text.slice(0, 200));
      return { handoff: true, reason: 'unparseable AI output' };
    }
    return result;
  } catch (err) {
    console.error('[ai] Anthropic call failed:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

module.exports = { getAssistantReply, isConfigured, parseModelOutput, MODEL };
