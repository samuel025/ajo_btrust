# Three-minute demo

A script for recording the demo video, or presenting it live. Everything uses test coins on the Mutinynet test network.

## Before you start (5 minutes)

Run through this list. Most "it didn't work in the demo" problems are on it.

- [ ] Relay running: `docker ps` shows `ajo-relay`.
- [ ] Both Alby Hubs are running **and unlocked** (`http://localhost:8080` and `:8081`), with a working channel between them (hub 1 should have outbound balance).
- [ ] `npm run lnurl -w @ajo/bot` is running (the stand-in Lightning address).
- [ ] The web app is running: `npm run dev -w @ajo/web` (the "10-minute" testing period is only in this development build).
- [ ] The bot is running with the **organizer's npub** and `AJO_ALLOW_LOCAL_LNURL=1`. Start the bot *after* you know the organizer's npub (sign in once, copy it), then start it.
- [ ] `GEMINI_API_KEY` is in `.env` if you want AI answers (the free tier has a small daily quota; templates take over if it runs out).
- [ ] Two browser windows that don't share data (a normal one and a private one) = the organizer and a member.
- [ ] Your wallet connection for the member window is ready to paste (`NWC_PAYER` from `.env`).

## The script

**0:00, the problem (15 s).** "An ajo is a savings circle: everyone pays in each week, and one person takes the pot in turn. It runs on a treasurer you have to trust. If they disappear, the group loses everything."

**0:15, the idea (15 s).** "Bitcoin Ajo takes the treasurer out of the money's path. Members pay the collector directly over Lightning. A bot runs the calendar but can never touch the money. The records are encrypted Nostr events."

**0:30, create and invite (30 s).** Organizer window: sign in, **New group**, name it, amount 1000 sats. Point at the naira estimate. Choose **Every 10 minutes (testing only)** so the whole cycle fits in the demo. **Create group**, then copy the invite link. Say: "I send this link in the group chat."

**1:00, join in one click (20 s).** Member window: open the link, show **"You're invited…"** and the single **Continue** button, then the Lightning address and language (choose Pidgin). Organizer approves and starts the group.

**1:20, pay from any wallet (40 s).** Member's group page shows the QR code. Say: "Any Lightning wallet works." Open the member's **Wallet** page, connect the wallet, and **Send**: paste the invoice and pay. (Or pay from Alby Hub's Send screen to show it really is any wallet.) Switch back: the round turns **Complete** with no receipt entered. Say: "The bot checked the payment proof itself."

**2:00, the wallet (25 s).** **Wallet** page: balance, **Receive** (create a QR invoice and have it paid), **History**, and the **budget meter** of a limited connection. Say: "Two wallets. The Bitcoin tab holds its own keys: twelve words, a password, real signed transactions. The Lightning tab connects the user's own Lightning wallet. The money never leaves their control." Show **Bitcoin → Receive** (address and QR) and **History**.

**2:25, the assistant (15 s).** Ask in Pidgin: "wetin dey happen with my turn?" Show the answer. Say: "AI in the language people actually speak."

**2:40, trust (15 s).** Show a group's **Members** list with each person's record. Say: "Anyone who collects and stops paying is on record."

**2:55, close (5 s).** "Bitcoin, Nostr and AI, for a savings tradition millions already trust. Thank you."

## If something goes wrong on stage

| Problem | Do this |
|---|---|
| The QR code doesn't appear | The bot isn't running, or was started with the wrong organizer npub. |
| Payment sent but the round doesn't complete | Wait up to a minute (the bot checks every 30 seconds). |
| The wallet page says it can't reach the relay | Alby's relay is slow; wait and retry. Nothing was paid if it said so before the payment. |
| The AI answer is plain and in English | The free quota ran out, and the template answered. Say so and move on. |
| Round 2 doesn't open | With the real schedule it opens at the previous due date. The 10-minute testing period is the one to use for demos. |
