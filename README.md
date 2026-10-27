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
