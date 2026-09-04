// routes/shopifyAuth.js
// TEMPORARY - one-time use to obtain a genuine Shopify Admin API access
// token for this bot via the standard OAuth authorization-code flow.
//
// Usage:
//   1) Make sure SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are set in the
//      environment (from the Dev Dashboard app's "Client credentials").
//   2) Visit /shopify/auth?shop=yourstore.myshopify.com in a browser while
//      logged into that store's admin, and approve the requested scopes.
                     //   3) The callback below exchanges the code for an access token and shows
//      it once. Copy it into SHOPIFY_ADMIN_API_TOKEN.
//   4) Delete this file and its require()/app.use() in server.js, then
//      redeploy - do not leave this endpoint live once the token is saved.

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SCOPES = 'read_orders';
const APP_HOST = process.env.APP_HOST || 'https://auralivin-whatsapp-bot.onrender.com';

router.get('/auth', (req, res) => {
    const shop = req.query.shop;
    if (!shop || !/^[a-zA-Z0-9-]+\.myshopify\.com$/.test(shop)) {
          return res.status(400).send('Missing or invalid ?shop=yourstore.myshopify.com');
        }
    if (!CLIENT_ID) {
          return res.status(500).send('SHOPIFY_CLIENT_ID is not set in the environment.');
        }

    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `${APP_HOST}/shopify/auth/callback`;
    const installUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    res.redirect(installUrl);
  });

router.get('/auth/callback', async (req, res) => {
    const { shop, code } = req.query;
    if (!shop || !code) {
          return res.status(400).send('Missing shop or code in callback.');
        }
    if (!CLIENT_ID || !CLIENT_SECRET) {
          return res.status(500).send('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set.');
        }

    try {
          const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
                  client_id: CLIENT_ID,
                  client_secret: CLIENT_SECRET,
                  code,
                });
          const accessToken = tokenRes.data.access_token;
          res.send(
                  `<pre>Shop: ${shop}\nAccess token: ${accessToken}\n\n` +
                  `Copy this into Render env vars as SHOPIFY_ADMIN_API_TOKEN and ` +
                  `SHOPIFY_STORE_DOMAIN=${shop}, then remove routes/shopifyAuth.js ` +
                  `and its wiring in server.js, and redeploy.</pre>`
                );
        } catch (err) {
          console.error('[shopifyAuth] token exchange failed:', err.response?.data || err.message);
          res.status(500).send('Token exchange failed: ' + JSON.stringify(err.response?.data || err.message));
        }
  });

module.exports = router;
