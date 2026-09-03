# Auralivin WhatsApp Automation

Auto-reply, bulk/broadcast messaging, and Shopify order notifications for Auralivin's WhatsApp, built on Meta's official WhatsApp Cloud API.

## What's included

server.js starts the web server and wires up all routes. routes/webhook.js receives incoming WhatsApp messages and sends auto-replies. config/autoReplyRules.js is the file to edit to change what the bot says. routes/broadcast.js exposes POST /broadcast to send a bulk message to a list of numbers. routes/shopifyWebhook.js receives Shopify order and fulfillment webhooks and messages the customer plus the store owner. lib/whatsapp.js is a small helper that talks to the WhatsApp Cloud API.

All three automations were tested locally (webhook verification, keyword auto-reply logic, broadcast auth/validation, and Shopify HMAC signature verification all pass) - see the setup steps below to connect real credentials.

## 1. Get your Meta WhatsApp credentials

This assumes the Meta app ("Auralivin Automation") and business portfolio ("Balaji Overseas") already exist in Meta Business Manager. In developers.facebook.com, under your app, WhatsApp, API Setup, you will need the following three things.

Temporary or Permanent access token: click "Generate token" on that page. The one shown there by default expires in 24h; for production, create a System User under Business Settings, Users, System Users, assign it to the WhatsApp app with whatsapp_business_messaging and whatsapp_business_management permissions, and generate a token with no expiry from there instead.

Phone Number ID: shown on the same page.

WhatsApp Business Account ID (WABA ID): also shown on the same page.

To send real messages (not just to the test number), finish Step 2, Production setup, in that same panel to add and verify Auralivin's real number (9520666401), via SMS or voice OTP.

## 2. Configure

Run: cp .env.example .env

Then fill in .env with the following. WHATSAPP_TOKEN comes from Step 1 above. WHATSAPP_PHONE_NUMBER_ID comes from Step 1 above. WHATSAPP_BUSINESS_ACCOUNT_ID comes from Step 1 above. WEBHOOK_VERIFY_TOKEN is any random string you make up yourself. SHOPIFY_WEBHOOK_SECRET comes from Shopify Admin, Settings, Notifications, Webhooks. STORE_OWNER_WHATSAPP_NUMBERS is the comma-separated list of numbers that get "new order" alerts.

## 3. Run locally

Run: npm install
Then: npm start

Visit http://localhost:3000/health to confirm it's up.

## 4. Deploy (Render, free tier, simplest option)

This repo is already on GitHub. On render.com, choose New, Web Service, and connect this repo. Set the build command to npm install and the start command to npm start. Under Environment, add every variable from .env with real values (never commit your real .env to GitHub). Deploy - Render gives you a public URL like https://auralivin-bot.onrender.com. Railway or Fly.io work the same way if you prefer those instead.

Note: Render's free tier sleeps after 15 minutes idle and wakes on the next request (a few seconds' delay on the first message after a quiet period). Fine for auto-reply and order alerts; upgrade to a paid instance later if that delay ever matters.

## 5. Connect the webhook in Meta

In developers.facebook.com, under your app, WhatsApp, Configuration: set the Callback URL to https://YOUR_RENDER_URL/webhook and the Verify token to the same string you put in WEBHOOK_VERIFY_TOKEN. Click Verify and save, then subscribe to the messages field.

## 6. Create message templates (required for broadcast and order alerts)

In WhatsApp Manager, Message templates, Create template, you need at least three. order_confirmation (Marketing or Utility category) with a body like: Hi {{1}}, thanks for your order {{2}}! Total: {{3}}. We'll notify you when it ships. shipping_update with a body like: Your Auralivin order {{1}} has shipped! Tracking: {{2}} - {{3}}. And promo_broadcast (Marketing category, for the /broadcast endpoint) with whatever variables you want, referenced as {{1}}, {{2}}, and so on in order.

Templates need Meta's approval (usually minutes to a few hours) before they can be sent. Free-form auto-replies (the /webhook auto-reply flow) do not need a template - those only work within 24h of the customer's last message, which is exactly the auto-reply use case.

## 7. Connect Shopify

In Shopify Admin, Settings, Notifications, Webhooks, Create webhook: for the Order creation event, use URL https://YOUR_RENDER_URL/webhook/shopify/orders. For the Order fulfillment event, use URL https://YOUR_RENDER_URL/webhook/shopify/fulfillment. Use JSON format for both. Copy the Signing secret shown on that page into SHOPIFY_WEBHOOK_SECRET.

## 8. Trigger a broadcast

Example request: curl -X POST https://YOUR_RENDER_URL/broadcast -H "Content-Type: application/json" -d '{"apiKey": "YOUR_WEBHOOK_VERIFY_TOKEN", "templateName": "promo_broadcast", "languageCode": "en_US", "recipients": [{"to": "919520666401", "params": ["Ankit", "20% off this week"]}]}'

## Customizing auto-replies

Everything the bot says lives in config/autoReplyRules.js: greeting text, keyword-triggered replies, and the fallback message. Edit that file only; no other code needs to change for wording tweaks.

## Notes and limits

The "first message greeting" tracking is in-memory - it resets if the server restarts (rare on Render, but possible). Not a functional problem, just means a returning customer might get the greeting again occasionally. WhatsApp's free tier gives 1,000 business-initiated conversations per month; beyond that, Meta charges per conversation (rates vary by country and category). Business-initiated messages must use an approved template. Only replies sent within 24h of an inbound customer message can be free-form text (handled by /webhook's auto-reply).
