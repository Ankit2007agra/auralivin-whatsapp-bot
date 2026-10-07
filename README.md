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

## 7b. COD order confirmation

When a new Shopify order is paid by Cash on Delivery, the customer gets a WhatsApp message asking them to confirm, with two buttons: Confirm Order and Cancel Order. Confirm tags the order COD-Confirmed. Cancel tags it COD-Cancelled-by-customer and alerts the store owner number(s); the order is not cancelled automatically, so cancel it yourself in Shopify. If there's no answer after about 6 hours, one reminder is sent and the order is tagged COD-Reminder-Sent. The GitHub Actions keep-alive workflow triggers the reminder check every 10 minutes through GET /cron/cod-reminders. In Shopify Admin you can filter orders by these tags to see what's pending, confirmed or cancelled. The code lives in lib/cod.js.

To set it up, first create a template in WhatsApp Manager, Message templates, named cod_order_confirmation. Use the Utility category and English (US) as the language. Give it this body: Hi {{1}}, thank you for your Auralivin order {{2}} of {{3}} with Cash on Delivery. Please confirm your order so we can ship it. Add two Quick Reply buttons in this order: Confirm Order, then Cancel Order.

Second, the Shopify app behind SHOPIFY_ADMIN_API_TOKEN needs the read_orders and write_orders Admin API scopes. write_orders is what lets the bot add tags.

Third, the Shopify Order creation webhook from step 7 must be set up, because that's what triggers the flow. SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_TOKEN must also be set.

These environment variables are optional: COD_TEMPLATE_NAME (default cod_order_confirmation), COD_TEMPLATE_LANGUAGE (default en_US), COD_REMINDER_AFTER_HOURS (default 6) and COD_REMINDER_TEMPLATE_NAME (defaults to the same template).

## 7c. AI assistant for normal questions

Short messages like "hi", "track", "2" or "agent" still get the numbered menu. When a customer writes a normal sentence instead, for example "do you have a bed for a large dog?", the AI answers it. It only answers from three places:

- config/knowledge.md: shipping, returns and other policies, copied from auralivin.com.
- The Shopify page called "Bot knowledge". This is where you add new information day to day.
- The live product catalog on auralivin.com: names, prices, sizes and whether something is sold out.

The bot goes silent in that chat and leaves it to your team when:

- the answer isn't in any of those places,
- the message is a complaint, a refund, return or cancellation request, or a problem with a specific order,
- the customer is upset,
- the customer sends a photo, voice note or other media.

Your team answers from the WhatsApp Business app. Once a teammate replies from the app, the bot also stays out of that chat for 24 hours. The customer can type "menu" at any time to bring the bot back.

To teach it something new, create the page once in Shopify Admin, Online Store, Pages, and give it the handle bot-knowledge. You can hide it from your site's menus. Then add lines to it whenever you like, for example "COD is available on orders up to ₹5000" or "Pet bed sizes: S fits up to 5kg...". The bot reads it every 10 minutes. The Shopify app token needs the read_content scope for this.

To let the bot notice when your team replies from the app, subscribe the webhook to the smb_message_echoes field. You'll find it under WhatsApp, Configuration, Webhook fields in the Meta app dashboard, next to messages.

This needs ANTHROPIC_API_KEY in Render. It uses Claude Haiku 4.5, which costs roughly ₹0.3-1 per AI reply. The code lives in lib/ai.js and lib/knowledge.js.

## 7d. Abandoned-cart WhatsApp reminder

When someone leaves items in their cart, the bot sends them one WhatsApp reminder with a "Complete your order" button. The button opens their saved checkout.

The reminder goes out about an hour after the customer's last activity, and only between 9am and 9pm IST. Reminders due overnight wait until the next morning.

The bot doesn't send a reminder if:

- the checkout has no phone number,
- the same phone number placed an order in the last 3 days,
- that number already got a cart reminder in the last 7 days,
- the customer replied STOP.

The GitHub Actions keep-alive workflow runs the check every 10 minutes through GET /cron/abandoned-carts. You can open /cron/abandoned-carts?dry=1 to see counts of who would get a message; it shows numbers only and sends nothing.

To set it up, create a template in WhatsApp Manager:

- Name: abandoned_cart_reminder
- Category: Marketing
- Language: English (US)
- Body: Hi {{1}}, you left {{2}} in your Auralivin cart. Your items are still saved - tap below to complete your order.
- Footer: Reply STOP to opt out
- Button: Visit website, Dynamic URL https://auralivin.com/{{1}}, with the text "Complete your order"

Each reminder is a marketing message, which Meta charges at about Rs 0.86 each. The code lives in lib/abandonedCart.js.

## 8. Trigger a broadcast

Example request: curl -X POST https://YOUR_RENDER_URL/broadcast -H "Content-Type: application/json" -d '{"apiKey": "YOUR_WEBHOOK_VERIFY_TOKEN", "templateName": "promo_broadcast", "languageCode": "en_US", "recipients": [{"to": "919520666401", "params": ["Ankit", "20% off this week"]}]}'

## Customizing auto-replies

Everything the bot says lives in config/autoReplyRules.js: greeting text, keyword-triggered replies, and the fallback message. Edit that file only; no other code needs to change for wording tweaks.

## Notes and limits

The "first message greeting" tracking is in-memory - it resets if the server restarts (rare on Render, but possible). Not a functional problem, just means a returning customer might get the greeting again occasionally. WhatsApp's free tier gives 1,000 business-initiated conversations per month; beyond that, Meta charges per conversation (rates vary by country and category). Business-initiated messages must use an approved template. Only replies sent within 24h of an inbound customer message can be free-form text (handled by /webhook's auto-reply).
