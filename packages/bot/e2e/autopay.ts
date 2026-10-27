// Auto-pay through a real relay with mocked Lightning: the grant is encrypted on the wire,
// the bot reads it, pays once, and the round closes with no action from the member.
import bolt11 from 'bolt11';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { KIND_AUTOPAY, autopayEvent, createGroupKey, groupEvent, joinEvent, secretKeyCipher, type GroupDef } from '@ajo/core';
import { runOnce } from '../src';
import { nostrLedger } from '../src/nostr-ledger';

const relay = process.env.RELAY ?? 'ws://localhost:7777';
const pool = new SimplePool();
const [recipientKey, payerKey, botKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) => Promise.all(pool.publish([relay], finalizeEvent(template, key)));

const preimages = new Map<string, string>();
const nodeKey = bytesToHex(randomBytes(32));
const fetchInvoice = async () => {
  const preimage = bytesToHex(randomBytes(32));
  const encoded = bolt11.encode({
    satoshis: 1000, timestamp: Math.floor(Date.now() / 1000),
    tags: [{ tagName: 'payment_hash', data: bytesToHex(sha256(hexToBytes(preimage))) }, { tagName: 'description', data: 'x' }, { tagName: 'payment_secret', data: bytesToHex(randomBytes(32)) }],
  });
  const invoice = bolt11.sign(encoded, nodeKey).paymentRequest!;
  preimages.set(invoice, preimage);
  return { invoice };
};

const group: GroupDef = {
  id: `auto-${Date.now()}`, name: 'auto', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [getPublicKey(recipientKey), getPublicKey(payerKey)],
  startDate: Math.floor(Date.now() / 1000) + 86_400, coordinator: getPublicKey(botKey),
};
const groupKey = createGroupKey();
const ref = { author: getPublicKey(recipientKey), id: group.id };
const secret = 'topsecret-wallet-key';
const grantUrl = `nostr+walletconnect://abc?relay=wss://r&secret=${secret}`;

await publish(await groupEvent(group, groupKey, secretKeyCipher(recipientKey)), recipientKey);
await publish(joinEvent({ groupId: group.id, lightningAddress: 'r@mock.test' }, groupKey), recipientKey);
await publish(joinEvent({ groupId: group.id, lightningAddress: 'p@mock.test' }, groupKey), payerKey);
await publish(await autopayEvent(group.id, grantUrl, group.coordinator, secretKeyCipher(payerKey)), payerKey);

const onRelay = await pool.querySync([relay], { kinds: [KIND_AUTOPAY], '#a': [group.id] });
check(onRelay.length === 1 && !JSON.stringify(onRelay).includes(secret), 'the wallet connection is not readable on the relay');

const ledger = nostrLedger([relay], botKey);
const paid: string[] = [];
const pay = async (nwcUrl: string, invoice: string) => { paid.push(nwcUrl); return { preimage: preimages.get(invoice)! }; };
const memo = new Map<string, string>();

const first = await runOnce(ledger, ref, fetchInvoice, undefined, { pay, paid: memo });
check(first.some((a) => a.type === 'autopaid') && paid.length === 1 && paid[0] === grantUrl, 'the bot read the grant and paid once with it');
check(first.some((a) => a.type === 'round-complete'), 'the round closed with no action from the member');

// revoke: a newer grant event with no connection must stop any further payment
await new Promise((r) => setTimeout(r, 1100));
await publish(await autopayEvent(group.id, null, group.coordinator, secretKeyCipher(payerKey)), payerKey);
const grants = await ledger.grants(group);
check(Object.keys(grants).length === 0, 'a revoked grant is no longer used');
pool.close([relay]);
process.exit(0);
