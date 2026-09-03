// config/autoReplyRules.js
// Edit this file to change what Auralivin's bot says. No need to touch any
// other code. Rules are checked top to bottom; the first match wins.

module.exports = {
    // Sent once, the first time a customer messages (or messages after a long gap).
    greeting: `Hi! Welcome to Auralivin. Thanks for reaching out.

    How can we help you today? You can ask about:
    Order status - type "order"
    Products - type "catalog"
    Talk to a person - type "agent"`,

    // Keyword-based rules: { match: [array of trigger words, lowercase], reply }
    rules: [
      {
              match: ['order', 'track', 'tracking', 'status', 'shipment', 'delivery'],
              reply:
                        'To check your order status, please share your Order Number (e.g. #AL1023). Our team will look it up for you.',
      },
      {
              match: ['catalog', 'products', 'price', 'prices', 'shop'],
              reply:
                        'You can browse our full catalog here: https://auralivin.com \n\nLet us know if you\'re looking for something specific!',
      },
      {
              match: ['agent', 'human', 'support', 'help', 'complaint', 'refund', 'return'],
              reply:
                        "Got it - connecting you with our support team. Someone from Auralivin will reply here shortly during business hours (10am-7pm IST, Mon-Sat).",
      },
      {
              match: ['hi', 'hello', 'hey', 'hii', 'namaste'],
              reply:
                        'Hey there! How can we help you with Auralivin today?',
      },
      {
              match: ['thanks', 'thank you', 'thankyou', 'ty'],
              reply: "You're welcome! Have a great day",
      },
        ],

    // Sent when nothing above matches.
    fallback:
          "Thanks for your message! Our team will get back to you shortly. In the meantime, you can type \"order\" to check an order, or \"catalog\" to browse products.",

    // If true, only the very first inbound message in a conversation gets the
    // greeting; later messages go straight to rule-matching. If false, the
    // greeting is skipped and rules run against every message.
    greetOnFirstMessage: true,
};
