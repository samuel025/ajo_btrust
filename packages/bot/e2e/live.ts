// One real round on Mutinynet: relay + bot + LNURL stand-in + two Alby Hubs.
// Needs NWC_PAYER (pays) and NWC_RECIPIENT (receives) in the environment, and a channel between them.
import { NWCClient } from '@getalby/sdk';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { createGroupKey, fetchInvoice, groupEvent, joinEvent, receiptEvent, secretKeyCipher, type GroupDef } from '@ajo/core';
import { devLnurlServer, payInvoice, runOnce } from '../src';
import { nostrLedger } from '../src/nostr-ledger';

const { NWC_PAYER, NWC_RECIPIENT } = process.env;
if (!NWC_PAYER || !NWC_RECIPIENT) throw new Error('set NWC_PAYER and NWC_RECIPIENT');
const relay = process.env.RELAY ?? 'ws://localhost:7777';
const PORT = 3456;
const AMOUNT_SATS = 1000;

const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const pool = new SimplePool();
const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) =>
  Promise.all(pool.publish([relay], finalizeEvent(template, key)));

const [recipientKey, payerKey, botKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const group: GroupDef = {
  id: `live-${Date.now()}`, name: 'live', amountSats: AMOUNT_SATS, frequency: 'weekly',
  payoutOrder: [getPublicKey(recipientKey), getPublicKey(payerKey)],
  startDate: Math.floor(Date.now() / 1000) + 86_400, coordinator: getPublicKey(botKey),
};

const server = await devLnurlServer(NWC_RECIPIENT, PORT);
const recipientWallet = new NWCClient({ nostrWalletConnectUrl: NWC_RECIPIENT });

try {
  const groupKey = createGroupKey();
  const ref = { author: getPublicKey(recipientKey), id: group.id };
  await publish(await groupEvent(group, groupKey, secretKeyCipher(recipientKey)), recipientKey);
  await publish(joinEvent({ groupId: group.id, lightningAddress: `amaka@localhost:${PORT}` }, groupKey), recipientKey);
  await publish(joinEvent({ groupId: group.id, lightningAddress: 'payer@unused.test' }, groupKey), payerKey);

  const ledger = nostrLedger([relay], botKey);
  const lookup = (address: string, sats: number) => fetchInvoice(address, sats);
  const issued = await runOnce(ledger, ref, lookup);
  for (const a of issued) console.log('bot action:', JSON.stringify(a));
  const state = (await ledger.round(group, 0))!;
  const invoice = state.invoices[getPublicKey(payerKey)];
  check(!!invoice, 'bot published an invoice from the recipient hub for the payer');

  const { preimage } = await payInvoice(NWC_PAYER, invoice!);
  check(/^[0-9a-f]{64}$/.test(preimage), 'payer hub paid it over Lightning and returned a preimage');

  await publish(receiptEvent({
    groupId: group.id, round: 0, payer: getPublicKey(payerKey),
    recipient: state.recipient, invoice: invoice!, preimage,
  }, groupKey), payerKey);
  await new Promise((r) => setTimeout(r, 500));

  const actions = await runOnce(ledger, ref, lookup);
  check(actions.some((a) => a.type === 'round-complete'), 'bot verified the real preimage and closed the round');
  check((await ledger.round(group, 0))!.status === 'complete', 'relay holds the completed round');
  // Balance isn't a reliable signal: the channel reserve can hide a small first payment.
  const received = await recipientWallet.lookupInvoice({ invoice: invoice! });
  check(received.state === 'settled' && received.preimage === preimage, 'recipient hub shows the invoice settled with the same preimage');
} finally {
  recipientWallet.close();
  server.close();
  pool.close([relay]);
}
