# Bitcoin Ajo

A non-custodial ajo (also called esusu): a rotating savings group on Bitcoin's Lightning Network and
Nostr. A fixed group saves together. Every round, everyone except that round's collector pays the
collector the same amount, and by the end every member has collected once.

**The app never holds anyone's money.** Members pay the collector directly, wallet to wallet. Signed,
encrypted Nostr events record the group, the schedule and who has paid. A bot coordinates the rounds.

> Status: a hackathon project, tested on a Bitcoin test network (Mutinynet) with test coins. Read
> [Limits](#limits-and-whats-not-done) before putting real money near it.

## Hackathon fit

Built for the brief *Bitcoin, Nostr and AI solutions that answer local and regional needs*. The need is
the **ajo / esusu** savings circle, which depends on a trusted treasurer holding everyone's money. See
[docs/PITCH.md](docs/PITCH.md) for the short presentation and [docs/DEMO.md](docs/DEMO.md) for a
three-minute demo script.

| Requirement | Where it is |
|---|---|
| Bitcoin, Nostr and AI centered | **Bitcoin/Lightning** moves the money; **Nostr** holds the identity and the encrypted records, and carries **NWC**; **AI** (Gemini) powers the assistant and reminders. |
| Answers a local or regional need | Rotating savings groups; **naira** estimates; **Pidgin, Yoruba and Hausa**; one-click join from a shared link; pay from any wallet. |
| **A Bitcoin/Lightning wallet implementation** | The **Wallet** page has two parts. **Bitcoin (your keys)** is a real on-chain wallet: it makes a 12-word recovery phrase (BIP-39), derives native-SegWit keys (BIP-84), scans the blockchain, builds, signs and broadcasts transactions in the browser (`apps/web/src/lib/onchain/`, `pages/BitcoinWallet.tsx`). **Lightning** connects your own wallet over NWC for invoices, sending and budgets (`lib/wallet.ts`). Tests: `npm run e2e:bitcoin -w @ajo/web`, `npm run e2e:wallet -w @ajo/web`. |
| A prototype, MVP or PoC | The whole repository: a working MVP, with unit tests and end-to-end tests that make real Lightning payments on a test network. One-command hosting with Docker. |
| A brief presentation | [docs/PITCH.md](docs/PITCH.md) (text) and the [demo script](docs/DEMO.md). |

The **Bitcoin** tab is a genuine self-custodial wallet: the keys are created and kept in the user's
browser, locked by a password and encrypted (PBKDF2 + AES-GCM), and the 12 words are the backup. Nobody
else, including us, can move the coins. It runs on the Mutinynet signet test network by default;
mainnet is switched off unless `VITE_ALLOW_MAINNET=1`, because this code has not had a security audit.
**Paying an ajo in Bitcoin.** When creating a group the organizer can choose *Bitcoin on-chain* instead of
Lightning. Members then use their in-app wallet address as their payout address, and pay each round from
the group page with one tap. The payment carries a short tag (an OP_RETURN output derived from the
group, round and payer) so the coordinator can tell who paid; it reads the recipient's address on the
blockchain (Esplora) and closes the round by itself, with no receipt, invoice or provider support needed.
Trade-offs: each payment costs a network fee and takes a block or more to confirm, so it suits larger, less
frequent rounds; Lightning stays better for small, frequent ones. Auto-pay is Lightning-only.
The **Lightning** tab does not hold funds: it is an interface to the user's own Lightning wallet (for
example Alby Hub), which is where the Lightning node lives. An in-browser Lightning node is not practical
today, so the app pairs the two: on-chain for keeping, Lightning for paying the circle.

**Want to see it?** After setup, `npm run demo` starts the web app and the coordinator and prints the steps to run an on-chain ajo in two browser windows. The script to present it is in [docs/DEMO.md](docs/DEMO.md).

## How it works

**People**

- **Organizer** creates a group and shares an invite link, approves who joins, and starts it.
- **Member** opens the link, continues with one click (an account is created on their device), enters a
  Lightning address (where they get paid on their turn), and asks to join.
- **Coordinator** is a bot that runs the rounds: it fetches invoices, confirms payments, sends
  reminders, answers questions and records defaults. It never holds funds.

**A group's life**

1. The organizer creates the group: name, amount per round, how often, and a first due date.
2. People join from the invite link. The organizer approves each request, then starts the group.
3. **Round 1 opens when the group starts.** The bot gets one invoice per payer from the collector's
   Lightning address and publishes them (encrypted) to the relay.
4. Each member pays their invoice by scanning a QR code with **any Lightning wallet**, or with one tap
   from a wallet connected to the app, or automatically through an optional budgeted connection.
   An invoice only lives an hour or a day, but a round lasts a whole period, so the bot **replaces an
   unpaid member's invoice shortly before it expires** (a tenth of its lifetime early, at most an hour)
   and keeps honoring a payment made on an older one.
5. The bot confirms each payment by checking the proof of payment (the preimage) against the invoice.
   When everyone has paid, the round closes.
6. **Each later round opens when the previous one falls due**, and is due one period after that. If
   everyone pays early, the next round is announced ("opens Nov 3, 9:00 AM") and nothing is issued
   until then, so a ten-round cycle takes ten periods, not an afternoon. A round paid after its due
   date opens the next one straight away.
7. After the last round, the cycle is complete.

**When someone doesn't pay.** A member who was given an invoice and still hasn't paid a week after the
due date is recorded as having defaulted, and the round closes without them so the group can go on.
The collector is short by that contribution: that is the real cost of a model with no pot to hold.
Each member's record (paid on time, late, missed, rounds received, and whether they received a payout
and then stopped paying) is shown on the group page. Nobody is blamed unless another member's payment
got through that round, so an unreachable collector can't make everyone look like a defaulter.

**Other features**

- **Reminders** a day before a round is due and when it is overdue, in the language each member chose
  (English, Pidgin, Yoruba, Hausa).
- **Group assistant**: members ask "when is my turn?" or "who hasn't paid?" on the group page.
- **Naira estimates** next to every amount. Amounts are fixed in sats; the naira value is an estimate.
- **Auto-pay**: a member can give the coordinator a wallet connection that can only pay invoices, with a
  spending budget enforced by their own wallet.

**Privacy and trust**

- Every group event (the group itself, joins, round state, receipts, questions, answers, reminders) is
  encrypted with NIP-44. The relay sees that events exist, their type, the group id and who the members
  are, but not names, amounts, Lightning addresses, invoices or preimages.
- Each group has its own key, wrapped separately for each member and the coordinator. An invite link
  carries only the group's name, amount and frequency, never the key.
- The coordinator can see its group's contents, so you must trust whoever runs it with that, though not
  with your money.
- If an AI key is configured, members' questions and the group schedule are sent to Google Gemini. On
  Google's free tier that data may be used to improve its products; the app tells members so. Keys,
  invoices and wallet connections are never sent.
- Everything the coordinator fetches from addresses members control goes through a guard that refuses
  private, local and cloud-metadata addresses, redirects and oversized responses.

## Repository layout

```
packages/core   shared rules: event kinds, encryption, schedule, defaults and reputation, receipt checks
packages/bot    the coordinator: round engine, relay access, assistant, payment checks, dev tools
apps/web        the web app (Vite + React): sign-in, invite and join, schedule, pay, assistant
deploy/         Caddy config and an example env file for hosting
scripts/        open-channel.sh (open a Lightning channel from a local Alby Hub), nwc-check.mjs
```

## Run it yourself

You need **Node.js 22 or newer** (developed on 23) and **Docker**. Chrome is only needed for the
browser tests. Everything below runs on your own machine.

### 1. Install

```
git clone <this repo> && cd <repo>
npm install
npm test            # 146 unit tests; needs nothing else running
```

### 2. Start a relay

A relay stores the events. A local one keeps your test data private:

```
docker run -d --name ajo-relay -p 7777:8080 scsibug/nostr-rs-relay:latest
```

### 3. Make the coordinator's key

```
npm run keygen -w @ajo/bot
```

It prints `BOT_NSEC=…` (the secret key) and an `npub1…` (the public key). Put the secret in a file
named `.env` at the repo root, with the relay address, and put the public key where the web app can
find it. Keep `.env` private (it is git-ignored) and keep a backup: the bot's key is the identity of
every group it runs, and a lost key can't be recovered.

```
# .env
BOT_NSEC=nsec1...
RELAYS=ws://localhost:7777
```

```
# apps/web/.env.local   (new groups use this coordinator by default)
VITE_COORDINATOR=npub1...
```

### 4. Start the web app

```
npm run dev -w @ajo/web          # http://localhost:5173
```

Open it, click **Create a test key**, and you can already create a group, invite people and approve
them. Use a second, private browser window as the second person. To see a whole cycle in one sitting,
choose **"Every 10 minutes (testing only)"** when creating the group (development builds only).

### 5. Start the coordinator

It needs the organizer's `npub`, which is shown on the app's home page ("copy npub"):

```
ORGANIZERS=npub1<organizer> AJO_ALLOW_LOCAL_LNURL=1 npm start -w @ajo/bot
```

`AJO_ALLOW_LOCAL_LNURL=1` is only for local development, because test Lightning addresses live on
`localhost`; the bot's safety guard refuses local addresses otherwise. Restart the bot after changing
code, and after creating a new organizer. You can list groups by hand instead with
`GROUPS=<organizer npub>:<group id>`.

Without a Lightning setup you can follow the whole flow up to the point of paying. To pay, you need
the next section.

### 6. Lightning on a test network (to actually pay)

Payments need two Lightning wallets with a channel between them. This uses two
[Alby Hub](https://github.com/getAlby/hub) instances on **Mutinynet**, a test network with free coins.
(Everything here is test money. Never use real funds.)

```
docker network create ajo-net

docker run -d --name albyhub --network ajo-net -p 8080:8080 \
  -v ~/.local/share/albyhub-ajo:/data -e WORK_DIR=/data \
  -e NETWORK=signet \
  -e LDK_ESPLORA_SERVER=https://mutinynet.com/api \
  -e LDK_GOSSIP_SOURCE=https://rgs.mutinynet.com/snapshot/0 \
  -e MEMPOOL_API=https://mutinynet.com/api \
  ghcr.io/getalby/hub:latest

docker run -d --name albyhub2 --network ajo-net -p 8081:8080 \
  -v ~/.local/share/albyhub-ajo2:/data -e WORK_DIR=/data \
  -e NETWORK=signet \
  -e LDK_ESPLORA_SERVER=https://mutinynet.com/api \
  -e LDK_GOSSIP_SOURCE=https://rgs.mutinynet.com/snapshot/0 \
  -e MEMPOOL_API=https://mutinynet.com/api \
  ghcr.io/getalby/hub:latest
```

- **Hub 1** (`http://localhost:8080`) is the payer. **Hub 2** (`http://localhost:8081`) is the receiver.
- In each: choose **Maybe later** on the Alby account screen, then **Create Wallet with Custom Node**
  and **LDK**, and set a password. Write down the recovery phrase.
- **Fund hub 1:** copy its on-chain deposit address and get coins at <https://faucet.mutinynet.com>.
- **Open a channel from hub 1 to hub 2.** Hub 2's node public key is on its **Node** page. The hub's
  own channel page can stall on unannounced nodes, so use the script (it asks for hub 1's password,
  which it never stores):

  ```
  HUB2_IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "ajo-net").IPAddress}}' albyhub2)
  scripts/open-channel.sh <hub2-pubkey>@$HUB2_IP:9735 100000
  ```

  Wait for the channel to show as active.
- **Create wallet connections** (in each hub: Connections, then Add connection) and add them to `.env`:

  ```
  NWC_PAYER=nostr+walletconnect://...      # hub 1, Full Access: the "wallet" that pays in tests
  NWC_RECIPIENT=nostr+walletconnect://...  # hub 2: makes the invoices for the stand-in address
  NWC_AUTOPAY=nostr+walletconnect://...    # optional, hub 1: pay-invoice only, budget 1500 sats/week
  ```

  Check them with `node --env-file=.env scripts/nwc-check.mjs`: it prints which node and balance each
  connection controls, without showing the URLs. `npm run e2e:live -w @ajo/bot` is the simplest proof
  that the whole setup works (it pays 1000 test sats).
- **Start the Lightning address stand-in.** Real Lightning addresses on a test network are not
  available, so this small server makes `anything@localhost:3456` pay into hub 2:

  ```
  npm run lnurl -w @ajo/bot
  ```

Now use `name@localhost:3456` as the Lightning address when joining. To pay as "any wallet", copy the
invoice from the pay card and send it from hub 1's **Send** screen. Within about a minute the bot
confirms it by itself.

## Configuration reference

Set in `.env` at the repo root (read by the bot and the live tests), or in the environment.

| Variable | Used by | Meaning |
|---|---|---|
| `BOT_NSEC` | bot | The coordinator's secret key. Required. |
| `RELAYS` | bot | Comma-separated relay addresses. Required. |
| `ORGANIZERS` | bot | Organizer npubs whose groups this bot runs. |
| `GROUPS` | bot | Alternatively, `<organizer npub>:<group id>`, comma-separated. |
| `AJO_ALLOW_LOCAL_LNURL` | bot | `1` allows localhost Lightning addresses. Development only. |
| `GEMINI_API_KEY` | bot | Turns on Gemini for the assistant. Free key: <https://aistudio.google.com/apikey>. |
| `GEMINI_MODELS` | bot | Comma-separated model list, tried in order. Default `gemini-3.1-flash-lite,gemini-2.5-flash`. |
| `AI_REMINDER_LANGUAGES` | bot | Languages in which Gemini may write reminders. Default `en`; others use fixed templates. |
| `VITE_BTC_NETWORK`, `VITE_ESPLORA_URL`, `VITE_ALLOW_MAINNET` | web | On-chain wallet network (`signet` default, `testnet`), the block explorer API to use, and the mainnet switch (leave off). |
| `ORGANIZERS=*` | bot | Runs every group that names the bot. For a private demo only (`npm run demo` sets it). |
| `ESPLORA_URL`, `ONCHAIN_MIN_CONFIRMATIONS` | bot | The blockchain server the coordinator reads for on-chain groups (Mutinynet by default) and the confirmations a payment needs (1). |
| `ONCHAIN_TEST_MNEMONIC` | `e2e:bitcoin` | A funded signet wallet for the live on-chain test. Run the test once without it and it prints a fresh one and an address to fund. |
| `NWC_PAYER`, `NWC_RECIPIENT`, `NWC_AUTOPAY` | live tests, stand-in | Wallet connections described above. |
| `LNURL_INVOICE_EXPIRY` | stand-in | Seconds its invoices stay payable. By default the wallet's own (24 hours on Alby Hub). Short values are for testing refresh. |
| `LNURL_PORT` | stand-in | Port of the Lightning address stand-in. Default 3456. |
| `VITE_COORDINATOR` | web (build time) | Default coordinator npub for new groups. |
| `VITE_RELAY` | web (build time) | Relay address. By default the dev server uses `ws://localhost:7777` and a hosted build uses `/relay` on its own domain. |

Without `GEMINI_API_KEY`, reminders and answers come from fixed templates. Gemini's free tier has a
small daily quota per model, so the bot tries several models, skips one that is out of quota until
Google says it resets, spaces its calls, and falls back to templates when nothing is available.

## Tests

`npm test` runs the unit tests of all three packages and needs nothing else. The end-to-end tests
drive the real system and are run per package with `npm run <name> -w <package>`:

| Command | Needs | What it proves | Spends |
|---|---|---|---|
| `e2e -w @ajo/bot` | relay | a whole cycle through a real relay, following the calendar, with nothing readable on the relay | none |
| `e2e:assistant -w @ajo/bot` | relay | reminders sent once, in the member's language, questions answered with a cap, all encrypted | none |
| `e2e:autopay -w @ajo/bot` | relay | auto-pay with an encrypted grant and revocation (mocked Lightning) | none |
| `e2e:stale-round -w @ajo/bot` | relay | a leftover round state can't stop a started group | none |
| `e2e:reputation -w @ajo/web` | relay, web dev server, Chrome | a member who collects and stops paying is recorded as defaulted, shown in the UI | none |
| `e2e:live -w @ajo/bot` | relay, `NWC_PAYER`, `NWC_RECIPIENT` | a real Lightning payment verified by the bot | 1000 sats |
| `e2e:live-verify -w @ajo/bot` | same | a payment from outside the app, confirmed by the bot with no receipt | 1000 sats |
| `e2e:live-refresh -w @ajo/bot` | relay, `NWC_PAYER`, `NWC_RECIPIENT` | with invoices that expire in 90 seconds, the bot replaces one before it dies, the old one is really unpayable, and a payment on the new one is confirmed (about 2 minutes) | 1000 sats |
| `e2e:live-autopay -w @ajo/bot` | relay, `NWC_AUTOPAY`, `NWC_RECIPIENT` | the bot pays from a budgeted connection and the wallet refuses an overspend | 1000 sats |
| `e2e:live-ai -w @ajo/bot` | `GEMINI_API_KEY` | what Gemini writes in all four languages | none |
| `e2e:browser -w @ajo/web` | relay, web dev server, Chrome, `NWC_PAYER`, `NWC_RECIPIENT` | create, join, pay and confirm in real Chrome | 1000 sats |
| `e2e:bitcoin -w @ajo/web` | web dev server, Chrome, internet (Mutinynet); `ONCHAIN_TEST_MNEMONIC` for the funded half | the on-chain wallet: create, verify backup, lock/unlock, restore on a second device; with funds, real balance and a real signed payment confirmed in a block | network fee only |
| `e2e:onchain-group -w @ajo/web` | relay, web dev server, Chrome, internet; funded `ONCHAIN_TEST_MNEMONIC` for the payment half | a group paid in Bitcoin: invite, join with the wallet's address, pay from the group page, the coordinator closes the round from the blockchain | ~1,200 test sats |
| `e2e:wallet -w @ajo/web` | web dev server, Chrome, `NWC_PAYER`, `NWC_RECIPIENT`, `NWC_AUTOPAY` | the Wallet page: connect, balance, receive from another wallet, send to an invoice and to a Lightning address, budget meter, over-budget payment refused (about 1400 sats) | ~1400 sats |
| `e2e:invite -w @ajo/web` | same | two browser identities: invite link, approval, start, payment from outside the app, confirmation | 1000 sats |

The browser tests expect Chrome at `/usr/bin/google-chrome` and the web dev server on port 5173. The
live tests spend small amounts of test coins from `NWC_PAYER` each run, and `e2e:live-autopay` uses
most of its budgeted connection's weekly allowance, so run it sparingly.

## Hosting it (one address)

`docker compose` runs the relay, the coordinator and the web app together behind
[Caddy](https://caddyserver.com), which gets and renews an HTTPS certificate for your domain by itself.
The web app finds the relay on the same domain (`wss://your-domain/relay`), so users configure nothing.

```
npm run keygen -w @ajo/bot            # a key pair for the coordinator
cp deploy/.env.example deploy/.env    # fill in SITE_ADDRESS, BOT_NSEC, COORDINATOR_NPUB, ORGANIZERS
docker compose --env-file deploy/.env up -d --build
```

Point your domain's DNS at the server and open ports 80 and 443. Use `SITE_ADDRESS=:80` for a plain
http trial on a local port (set `HTTP_PORT` to avoid clashing with something else). If the build stalls
downloading packages, build one image at a time:
`COMPOSE_PARALLEL_LIMIT=1 docker compose --env-file deploy/.env build`.

Keep `deploy/.env` private and backed up; it holds the coordinator's secret key. On a real network,
Lightning addresses are real providers' addresses, so do not set `AJO_ALLOW_LOCAL_LNURL`.

Tested locally on plain http with the full invite-and-pay flow. **Not tested:** a real domain with
HTTPS, or the bot restarting under load.

## Limits and what's not done

**Things to know before trusting it**

- **The collector bears the risk of a default.** There is no pot and no collateral. The default record
  is a deterrent, not compensation. Collateral is the natural next step.
- **Very short invoices can't be kept alive.** The bot checks every 30 seconds and replaces an invoice a tenth
  of its life before it expires, so invoices that last only a few minutes can expire between checks. Normal
  ones (an hour or a day) are replaced with minutes to an hour to spare.
- **Verify links vary by provider.** The bot can confirm payments from any wallet only when the
  collector's Lightning provider offers an LNURL "verify" link. Alby does; Wallet of Satoshi does not,
  and others are unchecked. Without one, the member pastes the payment proof or pays with a connected wallet.
- **Accounts live in the browser.** The one-click account is a key stored on the device. Settings can
  show it for a backup, but nothing prompts people to save it, so losing the browser loses the account.
- **The coordinator is trusted with group data**, not funds. Whoever runs it can read the group.
- **AI text.** Gemini's Yoruba and Pidgin reminders were unreliable in testing, so Gemini writes
  reminders in English only by default. The Pidgin, Yoruba and Hausa template wording has not been
  reviewed by native speakers and should be before any real use.
- **Reminders only appear inside the app.** Nothing reaches a member outside it (no SMS, WhatsApp or
  standard Nostr DMs yet).

**Not built**

- Removing a member before a group starts.
- A reputation record that follows a person across groups (opt-in public attestations), and payout
  order chosen by trust.
- Collateral, or any other way to compensate a collector after a default.
- Real PWA features (icons, install prompt, offline shell). There is a manifest only.
- Signing and encryption through a real Nostr browser extension were not tried; only local keys were.
- A group of three or more members was exercised through the relay tests and the reputation test, but
  the live-payment tests used two members.

## License

MIT. See `LICENSE`.
