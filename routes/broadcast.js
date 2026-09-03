// routes/broadcast.js
// Send a bulk/broadcast WhatsApp message to a list of contacts using an
// approved message template (required for business-initiated messages).
//
// Why a template? WhatsApp only allows free-form text replies within 24h of
// the customer last messaging you. For anything you initiate - promos,
// announcements, reminders - Meta requires a pre-approved template
// (create these in WhatsApp Manager > Message templates, e.g. a
// "promo_broadcast" template with one {{1}} text variable).

const express = require('express');
const router = express.Router();
const whatsapp = require('../lib/whatsapp');

// Simple shared-secret so random people on the internet can't trigger sends.
const BROADCAST_KEY = process.env.BROADCAST_API_KEY || process.env.WEBHOOK_VERIFY_TOKEN;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /broadcast
 * Body:
 * {
 *   "apiKey": "...",                 // must match BROADCAST_API_KEY
 *   "templateName": "promo_broadcast",
 *   "languageCode": "en_US",
 *   "recipients": [
 *     { "to": "919520666401", "params": ["Ankit", "20% OFF"] }
 *   ]
 * }
 *
 * `params` become {{1}}, {{2}}, ... text variables in the template body, in
 * order. Omit `params` (or use []) for templates with no variables.
 */
router.post('/', async (req, res) => {
    const { apiKey, templateName, languageCode, recipients } = req.body || {};

              if (!BROADCAST_KEY || apiKey !== BROADCAST_KEY) {
                    return res.status(401).json({ error: 'Invalid or missing apiKey' });
              }
    if (!templateName || !Array.isArray(recipients) || recipients.length === 0) {
          return res.status(400).json({ error: 'templateName and a non-empty recipients array are required' });
    }

              // Respond immediately; run the send in the background and log results,
              // since large lists can take a while (we deliberately pace sends below).
              res.status(202).json({ accepted: recipients.length, message: 'Broadcast started' });

              const results = [];
    for (const recipient of recipients) {
          const { to, params = [] } = recipient;
          try {
                  const components =
                            params.length > 0
                      ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }]
                              : [];

            await whatsapp.sendTemplate(to, templateName, languageCode || 'en_US', components);
                  results.push({ to, status: 'sent' });
                  console.log(`[broadcast] Sent to ${to}`);
          } catch (err) {
                  const errMsg = err.response?.data?.error?.message || err.message;
                  results.push({ to, status: 'failed', error: errMsg });
                  console.error(`[broadcast] Failed for ${to}:`, errMsg);
          }
          // Pace sends to stay well under WhatsApp's rate limits.
      await delay(1100);
    }

              const sent = results.filter((r) => r.status === 'sent').length;
    const failed = results.length - sent;
    console.log(`[broadcast] Done. Sent: ${sent}, Failed: ${failed}`);
});

module.exports = router;
