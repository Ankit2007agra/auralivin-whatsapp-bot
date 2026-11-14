// server.js
// Entry point. Wires up:
//   GET/POST /webhook              - WhatsApp Cloud API webhook (auto-reply)
//   POST     /broadcast            - bulk/broadcast template sends
//   POST     /webhook/shopify/orders       - Shopify new-order -> WhatsApp
//   POST     /webhook/shopify/fulfillment  - Shopify shipped -> WhatsApp
//   GET      /cron/cod-reminders           - COD confirmation reminders
//   GET      /cron/abandoned-carts         - abandoned-cart WhatsApp reminders

require('dotenv').config();
const express = require('express');

const webhookRoute = require('./routes/webhook');
const broadcastRoute = require('./routes/broadcast');
const shopifyWebhookRoute = require('./routes/shopifyWebhook');
const cod = require('./lib/cod');
const abandonedCart = require('./lib/abandonedCart');

const app = express();

// Shopify webhooks must be verified against the *raw* request body, so this
// route gets express.raw() instead of the JSON parser used everywhere else.
app.use('/webhook/shopify', express.raw({ type: 'application/json' }), shopifyWebhookRoute);

// Everything else can use normal JSON parsing.
app.use(express.json());

app.use('/webhook', webhookRoute);
app.use('/broadcast', broadcastRoute);

app.get('/', (_req, res) => {
            res.send('Auralivin & Lovtail WhatsApp automation is running.');
});

// Hit every 10 minutes by the GitHub Actions keep-alive workflow. Sends
// one reminder to COD orders still unconfirmed after ~6 hours (lib/cod.js).
// Safe to call any time - Shopify order tags make it idempotent.
app.get('/cron/cod-reminders', async (_req, res) => {
            try {
                        res.json(await cod.runCodReminderSweep());
            } catch (err) {
                        console.error('[cod] Reminder sweep failed:', err.message);
                        res.status(500).json({ error: 'sweep failed' });
            }
});

// Also run every 10 minutes by the in-server timer below. Sends up to 3
// WhatsApp reminders per abandoned cart (lib/abandonedCart.js). Add ?dry=1 to only
// count who WOULD get a message (returns numbers only, sends nothing).
app.get('/cron/abandoned-carts', async (req, res) => {
            try {
                        res.json(await abandonedCart.runAbandonedCartSweep({ dryRun: req.query.dry === '1' }));
            } catch (err) {
                        console.error('[cart] Abandoned-cart sweep failed:', err.message);
                        res.status(500).json({ error: 'sweep failed' });
            }
});

app.get('/health', (_req, res) => {
            res.json({ status: 'ok', time: new Date().toISOString() });
});

// In-server scheduler. GitHub's scheduled workflow only fires every few
// hours in practice, so the server runs its own sweeps every 10 minutes and
// pings its own public URL so Render's free tier doesn't put it to sleep.
// Set KEEP_AWAKE=0 to turn this off.
const SWEEP_EVERY_MS = 10 * 60 * 1000;
function startScheduler() {
            if (process.env.KEEP_AWAKE === '0') return;
            const selfUrl = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
            const tick = async () => {
                        if (selfUrl) {
                                    await fetch(`${selfUrl}/health`).catch((e) => console.warn('[timer] self-ping failed:', e.message));
                        }
                        await cod.runCodReminderSweep().catch((e) => console.error('[timer] COD sweep failed:', e.message));
                        const r = await abandonedCart
                                    .runAbandonedCartSweep()
                                    .catch((e) => ({ error: e.message }));
                        if (!r.skipped) console.log('[timer] cart sweep:', JSON.stringify(r));
            };
            setTimeout(tick, 60 * 1000);
            setInterval(tick, SWEEP_EVERY_MS);
            console.log(`[timer] Sweeps every 10 min${selfUrl ? `, self-ping ${selfUrl}` : ' (no RENDER_EXTERNAL_URL - no self-ping)'}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
            startScheduler();
            console.log(`Auralivin WhatsApp bot listening on port ${PORT}`);
            if (!process.env.WHATSAPP_TOKEN) {
                              console.warn('WARNING: WHATSAPP_TOKEN is not set - copy .env.example to .env and fill it in.');
            }
});
