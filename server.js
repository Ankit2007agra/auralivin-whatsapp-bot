// server.js
// Entry point. Wires up:
//   GET/POST /webhook              - WhatsApp Cloud API webhook (auto-reply)
//   POST     /broadcast            - bulk/broadcast template sends
//   POST     /webhook/shopify/orders       - Shopify new-order -> WhatsApp
//   POST     /webhook/shopify/fulfillment  - Shopify shipped -> WhatsApp

require('dotenv').config();
const express = require('express');

const webhookRoute = require('./routes/webhook');
const broadcastRoute = require('./routes/broadcast');
const shopifyWebhookRoute = require('./routes/shopifyWebhook');

const app = express();

// Shopify webhooks must be verified against the *raw* request body, so this
// route gets express.raw() instead of the JSON parser used everywhere else.
app.use('/webhook/shopify', express.raw({ type: 'application/json' }), shopifyWebhookRoute);

// Everything else can use normal JSON parsing.
app.use(express.json());

app.use('/webhook', webhookRoute);
app.use('/broadcast', broadcastRoute);

app.get('/', (_req, res) => {
    res.send('Auralivin WhatsApp automation is running.');
});

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Auralivin WhatsApp bot listening on port ${PORT}`);
    if (!process.env.WHATSAPP_TOKEN) {
          console.warn('WARNING: WHATSAPP_TOKEN is not set - copy .env.example to .env and fill it in.');
    }
});
