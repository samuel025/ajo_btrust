# Bitcoin Ajo

A non-custodial rotating savings group (ajo/esusu) on Lightning and Nostr. The app never holds
funds: each round, every member pays that round's recipient directly, and signed Nostr events
record the group, the schedule and payment receipts.

## Layout

- `packages/core` – event kinds, schedule logic, receipt verification, LNURL-pay (`npm test`)
- `packages/bot` – coordinator bot: round engine, relay runner (`npm test`; run with `BOT_NSEC`, `RELAYS`, `GROUPS=<organizer npub>:<group id>` or `ORGANIZERS=<npub>,…`)
- `apps/web` – frontend (Vite + React): Nostr login, create/join groups, schedule, pay with NWC (`npm run dev -w @ajo/web`)

## Development

Use Mutinynet or regtest only, never real funds.

```
npm install
npm test
```

MIT licensed.

## End-to-end test (local relay, mocked Lightning)

```
docker run -d --name ajo-relay -p 7777:8080 scsibug/nostr-rs-relay:latest
npm run e2e -w @ajo/bot
```

Runs a three-member cycle through a real relay. Invoices are signed locally and payment is
simulated by publishing the preimage, so no Lightning node is needed.

## Live test on Mutinynet (real Lightning, test sats)

Needs two Alby Hubs on Mutinynet with a channel between them, and `.env` containing `NWC_PAYER`
(pays) and `NWC_RECIPIENT` (receives). A local LNURL server stands in for the recipient's
Lightning address, since Alby's hosted addresses are mainnet only.

```
npm run e2e:live -w @ajo/bot
```

## Browser test (real Chrome, real Lightning)

With the relay running, `npm run dev -w @ajo/web` in one terminal, then:

```
npm run e2e:browser -w @ajo/web
```

A fresh test user creates a group, joins, pays over Lightning and the bot confirms the round.

## Auto-pay

A member can let the coordinator pay their contribution each round. They create a wallet
connection that can only pay invoices, with a budget of about one contribution per period, and
paste it into the group page. It is encrypted to the coordinator. The wallet enforces the budget.

```
npm run e2e:autopay -w @ajo/bot        # relay + mocked Lightning
npm run e2e:live-autopay -w @ajo/bot   # needs NWC_AUTOPAY (budgeted) and NWC_RECIPIENT in .env
```

## Reminders and the assistant

The coordinator sends each member a reminder a day before a round is due and another when it is
overdue, in the language they chose when joining (English, Pidgin, Yoruba or Hausa). Members can
also ask the assistant questions ("when is my turn?", "who hasn't paid?") on the group page.
Reminders and answers are encrypted between the member and the coordinator.

Without `GEMINI_API_KEY` the bot uses fixed templates. With it, Google Gemini writes the assistant's
answers, and reminders in the languages listed in `AI_REMINDER_LANGUAGES` (default `en` only: Gemini's
Yoruba and Pidgin reminders were unreliable in testing, so those use the fixed templates unless you opt
in). Only group facts are sent (never keys, invoices or wallets), and any failure falls back to the
templates.

Models are tried in order: `gemini-3.1-flash-lite`, then `gemini-2.5-flash` (set `GEMINI_MODELS` to a
comma-separated list to change it). Free-tier daily quotas are per model and small, so a model that
runs out of quota, is overloaded or doesn't exist is skipped for a while (until Google's reported reset
time for quota errors) and the next one is tried. Calls are spaced 5 seconds apart. When nothing is
available, members get the template text, so they always get a message.

**Privacy:** with the assistant on, members' questions and the group's schedule are sent to Google.
Google's free tier may use them to improve its products, so the app tells members not to put anything
private in a question. Reminders and answers are still encrypted on the relay.

```
npm run e2e:assistant -w @ajo/bot   # relay, templates
npm run e2e:live-ai -w @ajo/bot     # needs GEMINI_API_KEY, calls the real API
```

The Pidgin, Yoruba and Hausa template wording has not been reviewed by native speakers.

## Defaults and reputation

If a member who was given an invoice still hasn't paid a week after the deadline, and at least one
other member's payment got through (so the recipient was reachable), the coordinator records them as
having defaulted and closes the round so the group can continue. The recipient is short by that
contribution, which is the risk of a non-custodial circle. Each member's record (paid on time, late,
missed, rounds received, and whether they received a payout and then stopped paying) is computed from
the coordinator-signed round states and shown on the group page.

```
npm run e2e:reputation -w @ajo/web   # collect-and-leave through the real relay and UI (needs vite on :5173)
```

## Naira estimates

Amounts are always in sats; the app shows an approximate naira value next to them. The rate is the
median of Yadio, blockchain.info and CoinGecko (public, no keys), cached for 10 minutes. If none
respond, only sats are shown. Organizers can set a contribution in naira, which is converted to sats
once at the time; the group is fixed in sats, so its naira value drifts with the market.

## Invite links and paying from any wallet

An organizer can create a group "with an invite link": the group starts in a *forming* state (the
coordinator ignores it), the organizer shares a link, and people open it, continue with one click
(an account is created on their device), enter their Lightning address and ask to join. The
organizer approves each request and then starts the group. The link carries only the group's name,
amount and frequency, never its key; requests are encrypted to the organizer.

Members pay with any Lightning wallet by scanning the QR code on the pay card. If the recipient's
Lightning provider offers a verify link (LUD-21; Alby does, Wallet of Satoshi does not), the
coordinator confirms the payment by itself. Otherwise the member pastes the payment proof or pays
with a connected wallet. Everything the coordinator fetches from member-controlled addresses goes
through a guard that refuses private and local addresses.

```
npm run e2e:invite -w @ajo/web         # two browser identities, a real payment from outside the app
npm run e2e:live-verify -w @ajo/bot    # the bot confirming an outside payment through a verify link
```
