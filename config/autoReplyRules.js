// config/autoReplyRules.js
// Edit this file to change what Auralivin's bot says. No need to touch any
// other code. Rules are checked top to bottom; the first match wins.

module.exports = {
      // Sent once, the first time a customer messages (or messages after a long gap).
      greeting: `Hi! 👋 Welcome to Auralivin. Thanks for reaching out.\n\nHow can we help you today? Reply with a number or word:\n1️⃣ Order Tracking - type "track"\n2️⃣ Catalog / Products - type "catalog"\n3️⃣ Register a Complaint - type "complaint"\n4️⃣ Cancel / Exchange - type "cancel"\n5️⃣ Talk to an Agent - type "agent"`,

      // Keyword-based rules: { match: [array of trigger words, lowercase], reply }
      // Checked top to bottom — the first rule whose `match` list contains a word
      // found in the customer's message wins. Keep more specific rules (like
      // "complaint") above more general ones (like "agent") so they don't get
      // shadowed.
      rules: [
          {
                    match: ['1', 'order', 'track', 'tracking', 'status', 'shipment', 'delivery'],
                    reply:
                                'To check your order status, please share your Order Number (e.g. #AL1023). Our team will look it up and update you here shortly.',
          },
          {
                    match: ['2', 'catalog', 'products', 'price', 'prices', 'shop', 'buy'],
                    reply:
                                'You can browse our full catalog here: https://auralivin.com \n\nLet us know if you\'re looking for something specific!',
          },
          {
                    match: ['3', 'complaint', 'issue', 'problem', 'damaged', 'defective', 'wrong item', 'not working', 'quality'],
                    reply:
                                "We're really sorry for the trouble! Please share your Order Number and a short description (and a photo, if you have one) of the issue — our support team will personally follow up within 24 hours.",
          },
          {
                    match: ['4', 'cancel', 'exchange', 'refund', 'return', 'replace'],
                    reply:
                                'No problem. Please share your Order Number and let us know whether you\'d like a cancellation, return, or exchange — our team will guide you through the next steps.',
          },
          {
                    match: ['5', 'agent', 'human', 'support', 'help', 'talk to someone', 'representative'],
                    reply:
                                "Got it — connecting you with our support team. Someone from Auralivin will reply here shortly during business hours (10am-7pm IST, Mon-Sat).",
          },
          {
                    match: ['hi', 'hello', 'hey', 'hii', 'namaste'],
                    reply:
                                'Hey there! 😊 How can we help you with Auralivin today?',
          },
          {
                    match: ['thanks', 'thank you', 'thankyou', 'ty'],
                    reply: "You're welcome! Have a great day 🌿",
          },
            ],

      // Sent when nothing above matches.
      fallback:
              "Thanks for your message! Our team will get back to you shortly. In the meantime, you can type \"track\" for order status, \"catalog\" to browse products, or \"complaint\" to report an issue.",

      // If true, only the very first inbound message in a conversation gets the
      // greeting; later messages go straight to rule-matching. If false, the
      // greeting is skipped and rules run against every message.
      greetOnFirstMessage: true,
};
