# Bitcoin Ajo

**The savings circle your community already trusts, rebuilt so nobody has to trust a treasurer. It has its own Bitcoin wallet and a Lightning wallet connection, speaks Pidgin, Yoruba and Hausa, and shows prices in naira.**

## The problem

An *ajo* (also called *esusu*) is a rotating savings group. Everyone pays the same amount each week or month, and one member takes the whole amount in turn until everyone has had a turn. Versions of it exist across Nigeria, West Africa and the world, because it works where banks and credit don't reach people.

It runs on one fragile thing: **a trusted person who holds the money.** If the treasurer disappears, delays payouts, or simply makes a mistake, the group loses its savings and its trust. Records live in a notebook or a chat that anyone can dispute. Cash has to be gathered in person.

## The solution

Bitcoin Ajo takes the treasurer out of the money's path.

- **Nobody holds a pot.** Each round, every member pays that round's collector *directly*, wallet to wallet, over the Bitcoin Lightning Network. Payments are instant and cost almost nothing.
- **The records can't be disputed.** The group, the schedule and every payment are signed Nostr events, encrypted so only members can read them.
- **A bot runs the calendar, not the money.** It issues invoices, confirms payments, sends reminders and records who didn't pay. It cannot spend anyone's funds.
- **A member who collects and stops paying is recorded.** Each member's history is on the group page for everyone to see.

## How it works in three steps

1. **The organizer creates a group** and shares an invite link. Members open it, continue with one click (no email or password), and ask to join. The organizer approves them.
2. **Each round, members pay the collector** by scanning a QR code with any Lightning wallet, with one tap from the built-in wallet, or automatically through a budgeted connection.
3. **The bot confirms each payment** by checking the payment proof against the invoice, closes the round when everyone has paid, and opens the next one on its due date.

## Why Bitcoin, Nostr and AI

| | What it does here | Why it fits |
|---|---|---|
| **Bitcoin / Lightning** | Moves the money between members. Includes a **built-in wallet**: balance, receive, send, history, spending budgets. | Instant, near-zero fees, no bank account needed, and money that can't be frozen by a treasurer. |
| **Nostr** | Identity (a key instead of an account), and the group's encrypted records. **NWC** lets the app talk to the user's own wallet. | No company database to run, trust or lose. Anyone can verify the records. |
| **AI (Gemini)** | A group assistant that answers "when is my turn?" and "who hasn't paid?" in English, Pidgin, Yoruba or Hausa, plus reminders. | Brings a new kind of money to people in the language they speak, in plain words. |

## Built for here

- **Prices in naira** next to every amount, while the contribution itself is fixed in sats.
- **Pidgin, Yoruba and Hausa** for reminders and answers (the assistant's free-form answers use AI; English reminders use AI; other languages use fixed templates, because AI Yoruba and Pidgin were unreliable in our testing).
- **Pay from any wallet**, so a member needs no special app. A QR code works with whatever Lightning wallet they already have.
- **One-click join from a link** shared in a WhatsApp group, the way ajo groups already organize.
- **Runs in the phone's browser**, with a layout that adapts to a small screen (not yet tested on real phones).

## The wallet (required deliverable)

The **Wallet** page holds two wallets that work together.

**Bitcoin (your keys), a real on-chain wallet.** The app creates the keys itself: a 12-word recovery phrase, checked back with three words, then locked with a password. It reads the blockchain, shows the balance, gives a fresh address and QR code for each receive, and builds, signs and broadcasts payments (with a review screen showing the amount, fee and change) all in the browser. No server ever sees a key. Built on BIP-39/32/84 and checked against the official test vectors, including verifying the signatures it produces.

**Lightning, for paying the circle.** It connects to the user's own Lightning wallet over Nostr Wallet Connect: balance, receive by QR invoice, send to an invoice or Lightning address, history, and a spending-budget meter.

**It is used by the ajo itself.** A group can be paid in Bitcoin on-chain: members join with the wallet's address, pay from the group page, and the coordinator confirms by reading the blockchain. Lightning stays the better choice for small, frequent rounds, and the app says so.

Both were tested in real Chrome against the real Mutinynet test network. Mainnet is switched off until the code is audited.

## What exists today

A working MVP, tested end to end on a Bitcoin test network with test coins:

- invite links, group creation and approval, a calendar-driven schedule (rounds open when the previous one is due)
- payments from any wallet with automatic confirmation, invoices that are replaced before they expire
- budgeted auto-pay, reminders, a multilingual assistant, defaults and a per-member record
- encrypted records, the built-in wallet, one-command hosting with Docker
- 185 automated unit tests, plus end-to-end tests that make real Lightning payments on a test network

## Honest limits

- **The collector bears the risk of a default.** There is no pot and no collateral. The record deters but doesn't compensate.
- **Tested on a test network only.** Real money needs real-world hardening, a security review, and attention to the rules about handling other people's funds in each country.
- **The coordinator can read its groups' data** (not their money).
- Some provider-dependent features vary: automatic payment confirmation needs the collector's Lightning provider to offer a verify link.
- The Pidgin, Yoruba and Hausa wording should be reviewed by native speakers.

## What's next

- **All-or-nothing rounds with hold invoices**, so a round only settles when everyone has paid, removing the collector's default risk (needs a spike on how long a payment can be held).
- **Collateral**, and reputation that follows a person between groups.
- **1-click wallet connection** (the app creates the secret on the user's device), and a wallet-extension pay button.
- **Reminders delivered as private Nostr messages** to ordinary Nostr apps.
- Real PWA install and offline support.

## Try it

See the [README](../README.md) for setup. A three-minute demo script is in [DEMO.md](DEMO.md).
