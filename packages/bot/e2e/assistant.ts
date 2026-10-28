// Reminders and the assistant through a real relay (templates, no AI key needed).
import bolt11 from 'bolt11';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  KIND_ANSWER, KIND_ASK, KIND_NOTICE, askEvent, createGroupKey, groupEvent, joinEvent, parseAnswer, parseNotice,
  secretKeyCipher, type GroupDef,
} from '@ajo/core';
import { runOnce } from '../src';
import { nostrLedger } from '../src/nostr-ledger';

const relay = process.env.RELAY ?? 'ws://localhost:7777';
const pool = new SimplePool();
const [aKey, bKey, botKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
const [a, b, bot] = [getPublicKey(aKey), getPublicKey(bKey), getPublicKey(botKey)];
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) => Promise.all(pool.publish([relay], finalizeEvent(template, key)));

const nodeKey = bytesToHex(randomBytes(32));
const fetchInvoice = async () => {
  const preimage = bytesToHex(randomBytes(32));
  const encoded = bolt11.encode({
    satoshis: 1000, timestamp: Math.floor(Date.now() / 1000),
    tags: [{ tagName: 'payment_hash', data: bytesToHex(sha256(hexToBytes(preimage))) }, { tagName: 'expire_time', data: 315_360_000 }, { tagName: 'description', data: 'x' }, { tagName: 'payment_secret', data: bytesToHex(randomBytes(32)) }],
  });
  return { invoice: bolt11.sign(encoded, nodeKey).paymentRequest! };
};

// Due in an hour, so the "due" reminder window is open.
const group: GroupDef = {
  id: `asst-${Date.now()}`, name: 'assistant', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [a, b], startDate: Math.floor(Date.now() / 1000) + 3600, coordinator: bot,
};
const groupKey = createGroupKey();
const ref = { author: a, id: group.id };
await publish(await groupEvent(group, groupKey, secretKeyCipher(aKey)), aKey);
await publish(joinEvent({ groupId: group.id, lightningAddress: 'a@mock.test', language: 'pcm' }, groupKey), aKey);
await publish(joinEvent({ groupId: group.id, lightningAddress: 'b@mock.test', language: 'yo' }, groupKey), bKey);

const ledger = nostrLedger([relay], botKey);
const bCipher = secretKeyCipher(bKey);
const readNotices = async () => {
  const events = await pool.querySync([relay], { kinds: [KIND_NOTICE], '#a': [group.id], '#p': [b] });
  return Promise.all(events.map((e) => parseNotice(e, bot, bCipher)));
};

await runOnce(ledger, ref, fetchInvoice);
const first = await readNotices();
check(first.length === 1 && first[0]!.text.includes('Ìránnilétí'), 'the payer got a reminder in Yoruba');
check(!(await pool.querySync([relay], { kinds: [KIND_NOTICE], '#a': [group.id] })).some((e) => e.content.includes('Ìránnilétí')), 'the reminder is not readable on the relay');

await new Promise((r) => setTimeout(r, 1100));
await runOnce(ledger, ref, fetchInvoice);
check((await readNotices()).length === 1, 'running again does not send the same reminder twice');

// questions: 8 at once, only 5 are answered per run, the rest on the next run
for (let i = 0; i < 8; i++) await publish(await askEvent(group.id, `when is my turn? (${i})`, bot, bCipher), bKey);
const asks = await pool.querySync([relay], { kinds: [KIND_ASK], '#a': [group.id] });
check(asks.length === 8 && !JSON.stringify(asks).includes('turn'), 'questions are not readable on the relay');

const answersFor = () => pool.querySync([relay], { kinds: [KIND_ANSWER], '#a': [group.id], '#p': [b] });
await new Promise((r) => setTimeout(r, 1100));
await runOnce(ledger, ref, fetchInvoice);
check((await answersFor()).length === 5, 'only five questions are answered in one run');
await new Promise((r) => setTimeout(r, 1100));
await runOnce(ledger, ref, fetchInvoice);
const answers = await answersFor();
check(answers.length === 8, 'the rest are answered on the next run, none twice');

const reply = await parseAnswer(answers[0]!, bot, bCipher);
check(reply.text.includes('You receive in round 2'), 'the answer tells the member when their turn is');
let outsiderRead = true;
try { await parseAnswer(answers[0]!, bot, secretKeyCipher(aKey)); } catch { outsiderRead = false; }
check(!outsiderRead, "another member can't read someone else's answer");
pool.close([relay]);
process.exit(0);
