// config/excludedSenders.js
// Senders that should NEVER get an automated reply - e.g. Flipkart / other
// marketplace notifications, courier partners, suppliers, or any other
// business contact that happens to message this WhatsApp number. The bot
// will completely ignore (no reply, no AI, nothing) any message from these.
//
// Edit this file any time - no code changes needed elsewhere.

module.exports = {
        // WhatsApp numbers, digits only, with country code and NO leading "+"
        // (this is exactly the format WhatsApp sends in `message.from`).
        // Add a number here the first time you notice the bot wrongly
        // replying to it, and it'll be silently ignored from then on.
        numbers: [
                // '919999999999',
        ],

        // Safety net for the FIRST message from a sender you haven't added
        // above yet: if their WhatsApp profile name contains any of these
        // words (case-insensitive, partial match), the message is skipped
        // and logged instead of auto-replied to. Not every automated sender
        // sets a matching profile name, so this won't catch everything -
        // treat `numbers` above as the reliable long-term fix once you spot
        // one in the logs.
        nameKeywords: [
                'flipkart',
                'meesho',
                'myntra',
                'amazon',
                'ajio',
                'nykaa',
                'shiprocket',
                'delhivery',
                'bluedart',
                'blue dart',
                'ecom express',
                'xpressbees',
                'dtdc',
        ],
};
