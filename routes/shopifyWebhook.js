// routes/shopifyWebhook.js
// Receives Shopify order webhooks and sends WhatsApp notifications:
//   - to the customer (order confirmation / shipping update), if they have
//     a phone number on the order and it's in a sendable format
//   - to the store owner's WhatsApp, as an internal "new order" alert
//
// Setup in Shopify Admin: Settings > Notifications > Webhooks > Create webhook
//   Event: "Order creation"   -> URL: https://YOUR_HOST/webhook/shopify/orders
//   Event: "Order fulfillment" -> URL: https://YOUR_HOST/webhook/shopify/fulfillment
//   Format: JSON
// Copy the "Signing secret" shown there into SHOPIFY_WEBHOOK_SECRET in .env
//
// Requires approved WhatsApp templates named "order_confirmation" and
// "shipping_update" (create + submit these in WhatsApp Manager > Message
// templates). Adjust the template names/variables below to match exactly
// what you get approved.

const express = require('express');
const crypto = require('crypto');
const whatsapp = require('../lib/whatsapp');

const router = express.Router();

const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const OWNER_NUMBERS = (process.env.STORE_OWNER_WHATSAPP_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Shopify sends the raw body signed with HMAC-SHA256; body-parser must give
// us the raw buffer here (see server.js, which mounts this route with
// express.raw before the JSON parser runs).
function verifyShopifyHmac(req) {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    if (!hmacHeader || !SHOPIFY_SECRET) return false;
    const digest = crypto
      .createHmac('sha256', SHOPIFY_SECRET)
      .update(req.body) // raw Buffer
    .digest('base64');
    try {
          return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
    } catch {
          return false; // length mismatch etc.
    }
}

// Normalize a Shopify phone string to WhatsApp's expected "countrycode+number"
// digits-only format. Returns null if it doesn't look like a usable number.
function normalizePhone(rawPhone) {
    if (!rawPhone) return null;
    const digits = rawPhone.replace(/[^\d]/g, '');
    if (digits.length < 8) return null;
    return digits;
}

router.post('/orders', async (req, res) => {
    if (!verifyShopifyHmac(req)) {
          console.warn('[shopify] Invalid HMAC signature on /orders webhook.');
          return res.sendStatus(401);
    }
    res.sendStatus(200); // ack fast, process after

              let order;
    try {
          order = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
          console.error('[shopify] Failed to parse order payload:', e.message);
          return;
    }

              const orderNumber = order.name || `#${order.order_number}`;
    const total = order.total_price ? `${order.currency} ${order.total_price}` : 'N/A';
    const customerName = order.customer?.first_name || 'there';
    const customerPhone = normalizePhone(order.phone || order.customer?.phone || order.shipping_address?.phone);

              // 1) Notify the customer, if we have a usable phone number and an
              //    approved "order_confirmation" template exists.
              if (customerPhone) {
                    try {
                            await whatsapp.sendTemplate(customerPhone, 'order_confirmation', 'en_US', [
                              {
                                          type: 'body',
                                          parameters: [
                                            { type: 'text', text: customerName },
                                            { type: 'text', text: orderNumber },
                                            { type: 'text', text: total },
                                                      ],
                              },
                                    ]);
                            console.log(`[shopify] Order confirmation sent to customer ${customerPhone} for ${orderNumber}`);
                    } catch (err) {
                            console.error(
                                      `[shopify] Failed to message customer for ${orderNumber}:`,
                                      err.response?.data?.error?.message || err.message
                                    );
                    }
              } else {
                    console.log(`[shopify] No usable phone on order ${orderNumber} - skipping customer notification.`);
              }

              // 2) Internal alert to the store owner(s) - plain text is fine here since
              //    it's a reply-less internal notice; still needs a template if this
              //    number hasn't messaged the bot in the last 24h, so we default to one.
              for (const ownerNumber of OWNER_NUMBERS) {
                    try {
                            await whatsapp.sendTemplate(ownerNumber, 'order_confirmation', 'en_US', [
                              {
                                          type: 'body',
                                          parameters: [
                                            { type: 'text', text: 'Auralivin Team' },
                                            { type: 'text', text: `NEW ORDER ${orderNumber}` },
                                            { type: 'text', text: total },
                                                      ],
                              },
                                    ]);
                    } catch (err) {
                            console.error(
                                      `[shopify] Failed to alert owner ${ownerNumber}:`,
                                      err.response?.data?.error?.message || err.message
                                    );
                    }
              }
});

router.post('/fulfillment', async (req, res) => {
    if (!verifyShopifyHmac(req)) {
          console.warn('[shopify] Invalid HMAC signature on /fulfillment webhook.');
          return res.sendStatus(401);
    }
    res.sendStatus(200);

              let fulfillment;
    try {
          fulfillment = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
          console.error('[shopify] Failed to parse fulfillment payload:', e.message);
          return;
    }

              const orderNumber = fulfillment.name || `Order ${fulfillment.order_id}`;
    const trackingNumber = fulfillment.tracking_number || 'N/A';
    const trackingUrl = fulfillment.tracking_url || '';
    const customerPhone = normalizePhone(fulfillment.destination?.phone);

              if (!customerPhone) {
                    console.log(`[shopify] No usable phone on fulfillment for ${orderNumber} - skipping.`);
                    return;
              }

              try {
                    await whatsapp.sendTemplate(customerPhone, 'shipping_update', 'en_US', [
                      {
                                type: 'body',
                                parameters: [
                                  { type: 'text', text: orderNumber },
                                  { type: 'text', text: trackingNumber },
                                  { type: 'text', text: trackingUrl || 'N/A' },
                                          ],
                      },
                          ]);
                    console.log(`[shopify] Shipping update sent to ${customerPhone} for ${orderNumber}`);
              } catch (err) {
                    console.error(
                            `[shopify] Failed to send shipping update for ${orderNumber}:`,
                            err.response?.data?.error?.message || err.message
                          );
              }
});

module.exports = router;
