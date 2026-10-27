// A group is started after a round state was already published for it while it was still forming
// (one member). The bot must ignore that leftover state and open the round for the real members.
import bolt11 from 'bolt11';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { createGroupKey, groupEvent, joinEvent, openRound, secretKeyCipher, type GroupDef } from '@ajo/core';
import { runOnce } from '../src';
import { nostrLedger } from '../src/nostr-ledger';

const relay = process.env.RELAY ?? 'ws://localhost:7777';
const pool = new SimplePool();
const [aKey, bKey, botKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const [a, b] = [getPublicKey(aKey), getPublicKey(bKey)];
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) => Promise.all(pool.publish([relay], finalizeEvent(template, key)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const nodeKey = bytesToHex(randomBytes(32));
const fetchInvoice = async () => {
  const preimage = bytesToHex(randomBytes(32));
  const encoded = bolt11.encode({
    satoshis: 1000, timestamp: Math.floor(Date.now() / 1000),
    tags: [{ tagName: 'payment_hash', data: bytesToHex(sha256(hexToBytes(preimage))) }, { tagName: 'description', data: 'x' }, { tagName: 'payment_secret', data: bytesToHex(randomBytes(32)) }],
  });
  return { invoice: bolt11.sign(encoded, nodeKey).paymentRequest! };
};

const forming: GroupDef = {
  id: `stale-${Date.now()}`, name: 'stale', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [a], startDate: Math.floor(Date.now() / 1000) + 86_400, coordinator: getPublicKey(botKey), forming: true,
};
const groupKey = createGroupKey();
const ref = { author: a, id: forming.id };
const ledger = nostrLedger([relay], botKey);

await publish(await groupEvent(forming, groupKey, secretKeyCipher(aKey)), aKey);
await publish(joinEvent({ groupId: forming.id, lightningAddress: 'a@mock.test' }, groupKey), aKey);
const formingRead = (await ledger.group(ref))!;
// what an older coordinator did: open a round for the one-member group
await ledger.publishRound(openRound(formingRead, 0));
check((await ledger.round(formingRead, 0))!.payoutOrder?.length === 1, 'a stale one-member round state is on the relay');

// the organizer adds B and starts the group
await wait(1100);
const started: GroupDef = { ...forming, payoutOrder: [a, b], forming: undefined };
await publish(await groupEvent(started, groupKey, secretKeyCipher(aKey), Math.floor(Date.now() / 1000)), aKey);
await publish(joinEvent({ groupId: forming.id, lightningAddress: 'b@mock.test' }, groupKey), bKey);
await wait(500);

const actions = await runOnce(ledger, ref, fetchInvoice);
const group = (await ledger.group(ref))!;
check(group.payoutOrder.length === 2 && !group.forming, 'the started group has both members');
const state = (await ledger.round(group, 0))!;
check(state.payoutOrder?.length === 2 && !!state.invoices[b], `the bot recovered: round 1 now has both members and an invoice for B (actions: ${actions.map((x) => x.type).join(', ') || 'none'})`);
pool.close([relay]);
process.exit(0);
