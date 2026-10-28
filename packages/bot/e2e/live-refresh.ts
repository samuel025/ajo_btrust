// A round outlasts its invoices. With invoices that live 90 seconds on a real wallet, the coordinator must
// replace one before it dies, the first one must really be unpayable by then, and a payment on the
// replacement must be confirmed. Takes about two minutes and spends 1000 test sats.
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { checkVerify, createGroupKey, fetchInvoice, groupEvent, joinEvent, parseInvoice, secretKeyCipher, type GroupDef } from '@ajo/core';
import { devLnurlServer, payInvoice, runOnce, safeFetch } from '../src';
import { nostrLedger } from '../src/nostr-ledger';

const { NWC_PAYER, NWC_RECIPIENT } = process.env;
if (!NWC_PAYER || !NWC_RECIPIENT) throw new Error('set NWC_PAYER and NWC_RECIPIENT');
const relay = process.env.RELAY ?? 'ws://localhost:7777';
const PORT = 3462;
const EXPIRY = 90;
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = new SimplePool();
const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) => Promise.all(pool.publish([relay], finalizeEvent(template, key)));

const [recipientKey, payerKey, botKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const now = () => Math.floor(Date.now() / 1000);
const group: GroupDef = {
  id: `live-refresh-${Date.now()}`, name: 'live refresh', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [getPublicKey(recipientKey), getPublicKey(payerKey)], startDate: now() + 7 * 86_400, startedAt: now(),
  coordinator: getPublicKey(botKey),
};
const server = await devLnurlServer(NWC_RECIPIENT, PORT, { expirySeconds: EXPIRY });
const guarded = safeFetch({ allowLocal: true });
const lookup = (address: string, sats: number) => fetchInvoice(address, sats, guarded);
const deps = { checkPayment: (url: string) => checkVerify(url, guarded) };

try {
  const groupKey = createGroupKey();
  const ref = { author: getPublicKey(recipientKey), id: group.id };
  await publish(await groupEvent(group, groupKey, secretKeyCipher(recipientKey)), recipientKey);
  await publish(joinEvent({ groupId: group.id, lightningAddress: `amaka@localhost:${PORT}` }, groupKey), recipientKey);
  await publish(joinEvent({ groupId: group.id, lightningAddress: 'payer@unused.test' }, groupKey), payerKey);

  const ledger = nostrLedger([relay], botKey);
  const payer = getPublicKey(payerKey);
  const current = async () => (await ledger.round(group, 0))?.invoices[payer];

  await runOnce(ledger, ref, lookup, undefined, deps);
  const first = (await current())!;
  const firstInfo = parseInvoice(first);
  check(firstInfo.expirySeconds === EXPIRY, `the wallet's invoice lives ${EXPIRY} seconds, so it will die long before the round does`);

  // the bot keeps running; nobody pays; it must replace the invoice before this one expires
  let second = first;
  while (second === first && now() < firstInfo.expiresAt! + 30) {
    await sleep(8000);
    await runOnce(ledger, ref, lookup, undefined, deps);
    second = (await current())!;
  }
  check(second !== first, 'the coordinator replaced the invoice');
  check(now() < firstInfo.expiresAt!, `and did it before the old one expired (${firstInfo.expiresAt! - now()}s to spare)`);
  const secondInfo = parseInvoice(second);
  check(!!secondInfo.expiresAt && secondInfo.expiresAt > now() + 40, 'the new invoice has plenty of life left');

  // prove the old invoice really is dead: the wallet refuses it once it has expired
  await sleep(Math.max(0, (firstInfo.expiresAt! + 3 - now()) * 1000));
  let refused = '';
  try { await payInvoice(NWC_PAYER, first); } catch (e) { refused = (e as Error).message || 'refused'; }
  check(refused !== '', `the first invoice really had expired: the wallet refused it (${refused.slice(0, 70)})`);

  // pay the replacement; the coordinator confirms it
  const live = (await current())!;
  const { preimage } = await payInvoice(NWC_PAYER, live);
  check(/^[0-9a-f]{64}$/.test(preimage), 'the replacement invoice was paid over real Lightning');
  let done = false;
  for (let i = 0; i < 12 && !done; i++) {
    const actions = await runOnce(ledger, ref, lookup, undefined, deps);
    done = actions.some((a) => a.type === 'round-complete');
    if (!done) await sleep(5000);
  }
  check(done, 'the coordinator confirmed the payment and closed the round');
} finally {
  server.close();
  pool.close([relay]);
}
process.exit(0);
