/**
 * What the wallet guide may say. It answers only from this text, so it can't invent steps for wallets or places we haven't
 * checked. Keep it short, true, and free of promises about any particular wallet or country.
 */
export const GUIDE_KNOWLEDGE = `
ABOUT THE APP
- Bitcoin Ajo runs a rotating savings group (ajo, esusu). Every round, everyone except that round's collector pays the collector the same amount, until every member has collected once.
- The app never holds anyone's money. Members pay the collector straight from their own wallets. A bot (the coordinator) opens rounds, checks payments and sends reminders.
- Each group is paid one of two ways, chosen when the group is created: over Lightning, or on-chain.

LIGHTNING (the fast way)
- Lightning is a fast, cheap way to send small amounts of Bitcoin, a bit like an instant bank transfer.
- A WALLET is the app that holds your money and sends or receives it. A wallet is not the same as an address.
- An INVOICE is a one-time payment request for an exact amount. It is a long text or a QR code. You scan it and pay it.
- A LIGHTNING ADDRESS looks like an email, for example amaka@wallet.com. It is a permanent label that hands out a new invoice every time someone pays it. People use YOUR address to pay you. You give it to the group so the others can pay you when it is your turn to collect.
- To PAY a round you can scan the invoice QR code with any Lightning wallet, or connect a wallet to the app, or use a browser wallet extension.
- To RECEIVE a big amount, your wallet needs enough room for incoming money (inbound capacity). Wallets run by a service usually handle this for you. A wallet you run yourself may need extra setup.
- A CONNECTION (Nostr Wallet Connect, NWC) is a permission slip that lets this app ask your wallet to pay or make invoices, without the app ever holding your money. You approve it once in your wallet, and you can set a spending limit. A browser extension (WebLN) is another way to let a website pay from your wallet, and it asks you to approve each payment.
- Wallets differ. Some are run by a company for you (easy, but they hold the money). Some you control yourself (more private, more setup). Some give you a Lightning address. Some can confirm payments for the app automatically and some cannot, in which case you paste a payment proof.

ON-CHAIN (the slower way)
- On-chain payments use a long Bitcoin address that starts with bc1 (or tb1 on the test network). They cost a fixed network fee each time and take a few minutes or more to confirm, so they suit larger, less frequent rounds.
- The app has its own Bitcoin wallet. It makes 12 recovery words. Anyone with those words can take the coins, and if you lose them and your device, the coins are gone. Write them on paper. Never share them or photograph them.

THINGS THIS GUIDE CANNOT KNOW
- Which wallets or services are available or legal in a particular country, their fees, or whether they are safe. Say so and suggest checking, and never recommend a specific wallet as the best.
- Anything about the member's own balance, group or payments.
`.trim();
