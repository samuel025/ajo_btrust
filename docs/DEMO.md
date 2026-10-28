# Three-minute demo

A script for recording the demo video, or presenting it live. Everything uses test coins on the Mutinynet test network. It shows the app's own Bitcoin wallet paying an ajo, with the coordinator confirming the payment from the blockchain.

## Before you start (3 minutes)

1. **Relay running:** `docker ps` shows `ajo-relay`.
2. **Stop any old bot** (Ctrl+C in its terminal), then run **`npm run demo`**. It starts the web app and the coordinator bot, checks the pieces, and prints the demo wallet's twelve words, its balance and the steps. Leave it running.
3. **Check the demo wallet has coins.** `npm run demo` prints its balance. Each round needs the contribution (500 sats) plus a network fee (a few hundred sats), so keep **at least 1,500 test sats** in it. Top it up from `faucet.mutinynet.com` or from Alby Hub's on-chain Send, to the address it prints.
4. **Two browser windows that don't share data** (a normal one and a private one): the organizer and the member.
5. Optional: `GEMINI_API_KEY` in `.env` for AI answers (the free tier is small; templates take over if it runs out).
6. **Rehearse once.** A full on-chain round takes 30 to 60 seconds to confirm, so know where you'll fill that time with talking.

## The script

**0:00, the problem (15 s).** "An ajo is a savings circle: everyone pays in each week, and one person takes the pot in turn. It runs on a treasurer you have to trust. If they disappear, the group loses everything."

**0:15, the idea (15 s).** "Bitcoin Ajo takes the treasurer out of the money's path. Members pay the collector directly, with Bitcoin. A bot runs the calendar and checks payments on the blockchain, but it can never touch the money. The records are encrypted Nostr events."

**0:30, the wallet (35 s).** Organizer window: **Create a test key**, **Wallet**, **Create a new wallet**. Show the twelve words: "These words are the wallet. They never leave this device; nobody else can move the coins." Do the three-word check and set a password. Show the receive address and QR code.

**1:05, create and invite (25 s).** **New group**, name it, 500 sats, **Bitcoin on-chain**, **Create group**. **Use my wallet's address** and **Join**. Copy the invite link. Say: "I send this link in the group chat."

**1:30, join in one click (20 s).** Member window (already restored with the demo wallet): open the link, show "paid in Bitcoin on-chain", **Use my wallet's address**, **Ask to join**. Organizer: **Add to group**, **Start the group**.

**1:50, pay (30 s).** Member's group page: **Pay 500 sats from my wallet**. Show the review: amount, network fee, total. Say: "The payment is tagged for this group and round, so the bot knows who paid." **Sign and send**. Show "waiting for the network to put it in a block".

**2:20, the bot confirms (25 s).** While it confirms, say: "The bot reads the blockchain, finds the tagged payment and closes the round by itself. No receipt, no invoice." When both windows show **Complete**, show the organizer's wallet: **+500 sats**, and **History**.

**2:45, trust and close (15 s).** Show the **Members** list with each person's record. "Anyone who collects and stops paying is on record. Bitcoin, Nostr and AI, for a savings tradition millions already trust. Thank you."

### Optional extras (if you have more time)

- **Lightning groups:** the same flow with a Lightning invoice QR code that any wallet can pay (needs both Alby Hubs unlocked and `npm run lnurl -w @ajo/bot`).
- **The assistant:** ask in Pidgin "wetin dey happen with my turn?" and show the answer.
- **Lightning tab:** connect a wallet over NWC to show balance, receive, send and the budget meter.

## If something goes wrong on stage

| Problem | Do this |
|---|---|
| "Waiting for the coordinator to open this round" for over a minute | The bot isn't running, or an old copy of it is. Stop it, run `npm run demo` again. |
| The pay button says there isn't enough confirmed Bitcoin | The demo wallet needs coins. Top it up and wait ~30 seconds for the confirmation. |
| Payment sent but the round doesn't complete | A block takes ~30 seconds on this network; the bot checks every 30 seconds. Wait up to two minutes. |
| The page shows "not yet in a block" for a long time | The test network is slow or the fee was low. Wait, or show a recorded take. |
| The AI answer is plain and in English | The free quota ran out, and the template answered. Say so and move on. |
