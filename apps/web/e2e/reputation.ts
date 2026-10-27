// "Collect and leave" through a real relay and the real UI, with mocked Lightning and a fast-forwarded
// clock. Member A is paid in round 1, then stops paying. Needs the relay and `vite` on :5173.
import bolt11 from 'bolt11';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import puppeteer from 'puppeteer-core';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { createGroupKey, groupEvent, joinEvent, receiptEvent, secretKeyCipher, standings, type GroupDef } from '@ajo/core';
import { nostrLedger, runOnce } from '@ajo/bot';

const relay = 'ws://localhost:7777';
const app = process.env.APP ?? 'http://localhost:5173';
const shots = process.env.SHOTS ?? '.';
const pool = new SimplePool();
const [aKey, bKey, cKey, botKey] = [generateSecretKey(), generateSecretKey(), generateSecretKey(), generateSecretKey()];
const [a, b, c] = [aKey, bKey, cKey].map(getPublicKey) as [string, string, string];
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const publish = (template: Parameters<typeof finalizeEvent>[0], key: Uint8Array) => Promise.all(pool.publish([relay], finalizeEvent(template, key)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const DAY = 86_400;
const start = Math.floor(Date.now() / 1000) + DAY;
const group: GroupDef = {
  id: `rep-${Date.now()}`, name: 'Reputation test', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [a, b, c], startDate: start, coordinator: getPublicKey(botKey),
};
const groupKey = createGroupKey();
const ref = { author: a, id: group.id };
await publish(await groupEvent(group, groupKey, secretKeyCipher(aKey)), aKey);
for (const [i, key] of [aKey, bKey, cKey].entries()) await publish(joinEvent({ groupId: group.id, lightningAddress: `m${i}@mock.test` }, groupKey), key);

const ledger = nostrLedger([relay], botKey);
const pay = async (payers: [string, Uint8Array][], round: number, at: number) => {
  const state = (await ledger.round(group, round))!;
  for (const [pk, key] of payers) {
    const invoice = state.invoices[pk]!;
    await publish(receiptEvent({ groupId: group.id, round, payer: pk, recipient: state.recipient, invoice, preimage: preimages.get(invoice)! }, groupKey), key);
  }
  await wait(400);
  await runOnce(ledger, ref, fetchInvoice, at);
  await wait(1100);
};

// Round 1 (A receives): B and C pay on time.
await runOnce(ledger, ref, fetchInvoice, start - 3 * DAY); await wait(1100);
await pay([[b, bKey], [c, cKey]], 0, start - 3600);
check((await ledger.round(group, 0))!.status === 'complete', 'round 1 closed after B and C paid');

// Round 2 (B receives): C pays, A (who collected in round 1) never does.
const d1 = start + 7 * DAY;
await runOnce(ledger, ref, fetchInvoice, d1 - 3 * DAY); await wait(1100);
await pay([[c, cKey]], 1, d1 - 3600);
const stuck = (await ledger.round(group, 1))!;
check(stuck.status === 'open', 'round 2 stays open while A hasn\'t paid');
await runOnce(ledger, ref, fetchInvoice, d1 + 6 * DAY); await wait(1100);
check((await ledger.round(group, 1))!.status === 'open', 'and is still open six days after the deadline');
const actions = await runOnce(ledger, ref, fetchInvoice, d1 + 8 * DAY); await wait(1100);
check(actions.some((x) => x.type === 'defaulted'), 'a week after the deadline the bot records A as defaulted');
const closed = (await ledger.round(group, 1))!;
check(closed.status === 'complete' && closed.defaulted?.[0] === a, 'round 2 closed without A\'s contribution');

const rounds = [(await ledger.round(group, 0))!, closed];
const s = standings(group, rounds);
check(s[a]!.collectedAndLeft && s[a]!.defaulted === 1 && s[a]!.received === 1, 'A is recorded as having collected and left');
check(!s[c]!.collectedAndLeft && s[c]!.onTime === 2, 'C has a clean record: paid on time in both rounds');

// The real UI, signed in as C.
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1000 });
  await page.goto(`${app}/#/`);
  await page.evaluate((nsec, relayUrl) => {
    localStorage.setItem('ajo.localKey', nsec);
    localStorage.setItem('ajo.settings', JSON.stringify({ relay: relayUrl, coordinator: '', nwcUrl: '' }));
  }, nip19.nsecEncode(cKey), relay);
  await page.goto(`${app}/#/g/${a}/${encodeURIComponent(group.id)}`);
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes('Received a payout, then stopped paying'), { timeout: 30000 });
  const text = await page.evaluate(() => document.body.innerText);
  check(text.includes("1 didn't pay"), 'the schedule shows round 2 closed with one member not paying');
  check(text.includes('Paid 2 of 2'), 'C\'s own record reads "Paid 2 of 2"');
  // the live naira estimate (fetched from public price sources by the page itself)
  await page.waitForFunction(() => document.body.innerText.includes('≈ ₦'), { timeout: 30000 });
  const withRate = await page.evaluate(() => document.body.innerText);
  const naira = Number(withRate.match(/1,000 sats \(≈ ₦([\d,]+)\)/)?.[1]?.replace(/,/g, ''));
  check(naira > 100 && naira < 100_000, `1,000 sats shows a plausible naira estimate (₦${naira})`);
  await page.screenshot({ path: `${shots}/5-reputation.png`, fullPage: true });
} finally {
  await browser.close();
  pool.close([relay]);
}
process.exit(0);
