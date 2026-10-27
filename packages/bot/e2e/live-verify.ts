// Pay from "any wallet": the invoice is paid over real Lightning by something outside the app (here a
// script through NWC_PAYER, standing in for any wallet app), no receipt is published, and the bot must
// notice the payment by itself through the LNURL verify link.
import { NWCClient } from '@getalby/sdk';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { checkVerify, createGroupKey, fetchInvoice, groupEvent, joinEvent, secretKeyCipher, type GroupDef } from '@ajo/core';
import { devLnurlServer, payInvoice, runOnce, safeFetch } from '../src';
import { nostrLedger } from '../src/nostr-ledger';

const { NWC_PAYER, NWC_RECIPIENT } = process.env;
if (!NWC_PAYER || !NWC_RECIPIENT) throw new Error('set NWC_PAYER and NWC_RECIPIENT');
const relay = process.env.RELAY ?? 'ws://localhost:7777';
const PORT = 3459;
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const pool = new SimplePool();
const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) => Promise.all(pool.publish([relay], finalizeEvent(template, key)));

const [recipientKey, payerKey, botKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const group: GroupDef = {
  id: `live-verify-${Date.now()}`, name: 'live verify', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [getPublicKey(recipientKey), getPublicKey(payerKey)],
  startDate: Math.floor(Date.now() / 1000) + 86_400, coordinator: getPublicKey(botKey),
};
const server = await devLnurlServer(NWC_RECIPIENT, PORT);
const guarded = safeFetch({ allowLocal: true }); // the local dev server stands in for a public provider
const lookup = (address: string, sats: number) => fetchInvoice(address, sats, guarded);
const checkPayment = (url: string) => checkVerify(url, guarded);

try {
  const groupKey = createGroupKey();
  const ref = { author: getPublicKey(recipientKey), id: group.id };
  await publish(await groupEvent(group, groupKey, secretKeyCipher(recipientKey)), recipientKey);
  await publish(joinEvent({ groupId: group.id, lightningAddress: `amaka@localhost:${PORT}` }, groupKey), recipientKey);
  await publish(joinEvent({ groupId: group.id, lightningAddress: 'payer@unused.test' }, groupKey), payerKey);

  const ledger = nostrLedger([relay], botKey);
  const deps = { checkPayment };
  await runOnce(ledger, ref, lookup, undefined, deps);
  const state = (await ledger.round(group, 0))!;
  const payer = getPublicKey(payerKey);
  check(!!state.invoices[payer] && !!state.verify?.[payer], 'the bot issued an invoice and kept its verify link');

  const before = await runOnce(ledger, ref, lookup, undefined, deps);
  check(!before.some((a) => a.type === 'payment-detected') && (await ledger.round(group, 0))!.paid.length === 0, 'before anyone pays, the bot sees nothing paid');

  // Some wallet pays the invoice. Nobody tells the bot or publishes a receipt.
  const { preimage } = await payInvoice(NWC_PAYER, state.invoices[payer]!);
  check(/^[0-9a-f]{64}$/.test(preimage), 'a wallet outside the app paid the invoice over real Lightning');

  const after = await runOnce(ledger, ref, lookup, undefined, deps);
  for (const a of after) console.log('bot action:', JSON.stringify(a));
  check(after.some((a) => a.type === 'payment-detected'), 'the bot noticed the payment through the verify link by itself');
  check(after.some((a) => a.type === 'round-complete') && (await ledger.round(group, 0))!.status === 'complete', 'and closed the round');
} finally {
  server.close();
  pool.close([relay]);
}
process.exit(0);
