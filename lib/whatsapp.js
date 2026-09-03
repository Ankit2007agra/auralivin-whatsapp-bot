// lib/whatsapp.js
// Thin wrapper around the Meta WhatsApp Cloud API (Graph API).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages

const axios = require('axios');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

function client() {
    if (!TOKEN || !PHONE_NUMBER_ID) {
          throw new Error(
                  'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set in your .env file'
                );
    }
    return axios.create({
          baseURL: `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}`,
          headers: {
                  Authorization: `Bearer ${TOKEN}`,
                  'Content-Type': 'application/json',
          },
          timeout: 15000,
    });
}

/**
 * Send a free-form text message.
 * Only deliverable within the 24-hour customer service window
 * (i.e. as a reply to a message the customer sent you recently).
 */
async function sendText(to, body, { previewUrl = false } = {}) {
    const { data } = await client().post('/messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body, preview_url: previewUrl },
    });
    return data;
}

/**
 * Send a pre-approved message template.
 * Required for any business-initiated message (broadcasts, order alerts)
 * sent outside the 24-hour window. Templates must be created and approved
 * in WhatsApp Manager > Message templates before use.
 *
 * @param {string} to - recipient phone number, digits only, with country code
 * @param {string} templateName - the approved template's name
 * @param {string} languageCode - e.g. "en_US", "en", "hi"
 * @param {Array}  components - template variable components, e.g.
 *   [{ type: "body", parameters: [{ type: "text", text: "John" }] }]
 */
async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
    const { data } = await client().post('/messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
                  name: templateName,
                  language: { code: languageCode },
                  components,
          },
    });
    return data;
}

/** Mark an incoming message as read (shows blue ticks). */
async function markAsRead(messageId) {
    const { data } = await client().post('/messages', {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
    });
    return data;
}

module.exports = { sendText, sendTemplate, markAsRead };
