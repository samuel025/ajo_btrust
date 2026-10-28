// Full cycle against a real relay (RELAY=ws://localhost:7777). Lightning is mocked:
// invoices are signed locally and "payment" is the payer publishing the preimage.
import bolt11 from 'bolt11';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { KIND_GROUP, KIND_JOIN, KIND_RECEIPT, KIND_ROUND, createGroupKey, groupEvent, joinEvent, receiptEvent, secretKeyCipher, type GroupDef } from '@ajo/core';
import { roundDeadline, roundOpensAt } from '@ajo/core';
import { runOnce } from '../src';
import { nostrLedger } from '../src/nostr-ledger';
import type { FetchInvoice } from '../src';

const relay = process.env.RELAY ?? 'ws://localhost:7777';
const pool = new SimplePool();
const [orgKey, ...memberKeys] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const botKey = generateSecretKey();
const members = [orgKey, ...memberKeys];

const nodeKey = bytesToHex(randomBytes(32));
const preimages = new Map<string, string>();
const fetchInvoice: FetchInvoice = async (_address, amountSats) => {
  const preimage = bytesToHex(randomBytes(32));
  const encoded = bolt11.encode({
    satoshis: amountSats, timestamp: Math.floor(Date.now() / 1000),
    tags: [
      { tagName: 'payment_hash', data: bytesToHex(sha256(hexToBytes(preimage))) },
      { tagName: 'expire_time', data: 315_360_000 }, { tagName: 'description', data: 'ajo e2e' },
      { tagName: 'payment_secret', data: bytesToHex(randomBytes(32)) },
    ],
  });
  const invoice = bolt11.sign(encoded, nodeKey).paymentRequest!;
  preimages.set(invoice, preimage);
  return { invoice };
};

const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) =>
  Promise.all(pool.publish([relay], finalizeEvent(template, key)));
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };

const group: GroupDef = {
  id: `e2e-${Date.now()}`, name: 'e2e', amountSats: 1000, frequency: 'weekly',
  payoutOrder: members.map(getPublicKey), startDate: Math.floor(Date.now() / 1000) + 86_400,
  startedAt: Math.floor(Date.now() / 1000), coordinator: getPublicKey(botKey),
};
const groupKey = createGroupKey();
const ref = { author: getPublicKey(orgKey), id: group.id };
await publish(await groupEvent(group, groupKey, secretKeyCipher(orgKey)), orgKey);
for (const [i, key] of members.entries()) {
  await publish(joinEvent({ groupId: group.id, lightningAddress: `m${i}@mock.test` }, groupKey), key);
}

const ledger = nostrLedger([relay], botKey);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The clock is moved by hand: a cycle follows its calendar, one round per period, however fast people pay.
const opens = (round: number) => roundOpensAt(group, round) + 60;

for (let round = 0; round < members.length; round++) {
  const actions = await runOnce(ledger, ref, fetchInvoice, opens(round));
  const state = (await ledger.round(group, round))!;
  check(state.status === 'open' && Object.keys(state.invoices).length === members.length - 1,
    `round ${round}: open with ${members.length - 1} invoices (actions: ${actions.map((a) => a.type).join(',') || 'none'})`);

  for (const [i, key] of members.entries()) {
    if (i === round) continue;
    const invoice = state.invoices[getPublicKey(key)]!;
    await publish(receiptEvent({
      groupId: group.id, round, payer: getPublicKey(key), recipient: state.recipient,
      invoice, preimage: preimages.get(invoice)!,
    }, groupKey), key);
  }
  await sleep(300);

  const done = await runOnce(ledger, ref, fetchInvoice, opens(round) + 600);
  check(done.some((a) => a.type === 'round-complete'), `round ${round}: closed after receipts`);
  check((await ledger.round(group, round))!.status === 'complete', `round ${round}: relay holds the completed state`);

  if (round + 1 < members.length) {
    // paid within minutes, but the next round waits for its period: announced, with no invoices yet
    await sleep(1100);
    await runOnce(ledger, ref, fetchInvoice, roundDeadline(group, round) - 3600);
    const next = (await ledger.round(group, round + 1))!;
    check(next.opensAt === roundDeadline(group, round) && Object.keys(next.invoices).length === 0,
      `round ${round + 1}: waiting for ${new Date(next.opensAt! * 1000).toISOString().slice(0, 10)}, no invoices issued yet`);
    await sleep(1100);
  }
}

const last = await runOnce(ledger, ref, fetchInvoice, roundDeadline(group, members.length) + 60);
check(last.length === 0, 'cycle finished, nothing left to do');

// Everything a relay operator could read: no group name, address, invoice or preimage in clear.
const onRelay = await pool.querySync([relay], { kinds: [KIND_GROUP, KIND_JOIN, KIND_ROUND, KIND_RECEIPT], '#a': [group.id] });
const groupOnRelay = await pool.querySync([relay], { kinds: [KIND_GROUP], '#d': [group.id] });
const wire = JSON.stringify([...onRelay, ...groupOnRelay]);
const secrets = ['e2e ', '@mock.test', 'lnbc', ...preimages.values()];
check(onRelay.length > 0 && secrets.every((x) => !wire.includes(x)), `no readable group data among ${onRelay.length + groupOnRelay.length} relay events`);
pool.close([relay]);
