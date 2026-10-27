// Auto-pay on Mutinynet with a budgeted wallet connection. NWC_AUTOPAY must be a connection on the
// payer's hub limited to a budget that allows one contribution but not two (e.g. 1500 sats/week).
import { NWCClient } from '@getalby/sdk';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { autopayEvent, createGroupKey, fetchInvoice, groupEvent, joinEvent, secretKeyCipher, type GroupDef } from '@ajo/core';
import { devLnurlServer, payInvoice, runOnce } from '../src';
import { nostrLedger } from '../src/nostr-ledger';

const { NWC_AUTOPAY, NWC_RECIPIENT } = process.env;
if (!NWC_AUTOPAY || !NWC_RECIPIENT) throw new Error('set NWC_AUTOPAY and NWC_RECIPIENT');
const relay = process.env.RELAY ?? 'ws://localhost:7777';
const PORT = 3458;
const AMOUNT_SATS = 1000;

const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const pool = new SimplePool();
const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) => Promise.all(pool.publish([relay], finalizeEvent(template, key)));

const [recipientKey, payerKey, botKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const group: GroupDef = {
  id: `live-auto-${Date.now()}`, name: 'live auto', amountSats: AMOUNT_SATS, frequency: 'weekly',
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
  await publish(await autopayEvent(group.id, NWC_AUTOPAY, group.coordinator, secretKeyCipher(payerKey)), payerKey);

  // The bot sees the grant, fetches the invoice and pays it, with no action from the member.
  const ledger = nostrLedger([relay], botKey);
  const actions = await runOnce(ledger, ref, (address, sats) => fetchInvoice(address, sats), undefined, { pay: payInvoice, paid: new Map() });
  for (const a of actions) console.log('bot action:', JSON.stringify(a));
  check(actions.some((a) => a.type === 'autopaid'), 'the bot paid the contribution from the budgeted connection');
  check(actions.some((a) => a.type === 'round-complete'), 'the round closed with no action from the member');
  const state = (await ledger.round(group, 0))!;
  const invoice = state.invoices[getPublicKey(payerKey)]!;
  const settled = await recipientWallet.lookupInvoice({ invoice });
  check(settled.state === 'settled', 'the recipient hub shows the invoice settled');

  // The wallet, not the bot, enforces the budget: a second contribution must be refused.
  const extra = await recipientWallet.makeInvoice({ amount: AMOUNT_SATS * 1000, description: 'over budget' });
  let refused = '';
  try { await payInvoice(NWC_AUTOPAY, extra.invoice); } catch (e) { refused = `${(e as { code?: string }).code ?? ''} ${(e as Error).message}`.trim(); }
  check(refused !== '', `the wallet refused a payment beyond the budget (${refused})`);
} finally {
  recipientWallet.close();
  server.close();
  pool.close([relay]);
}
process.exit(0);
