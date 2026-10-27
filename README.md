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

Without `ANTHROPIC_API_KEY` the bot uses fixed templates. With it, Claude writes the reminders and
answers from group facts only (never keys, invoices or wallets), and any failure falls back to the
templates. Set `ANTHROPIC_MODEL` to use a different model than the default `claude-opus-5-5`.

```
npm run e2e:assistant -w @ajo/bot   # relay, templates
npm run e2e:live-ai -w @ajo/bot     # needs ANTHROPIC_API_KEY, calls the real API
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
