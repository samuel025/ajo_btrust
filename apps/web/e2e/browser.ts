// Drives the real app in Chrome through one live round: create group → join → pay over
// Lightning → bot confirms. Needs the local relay, vite dev server on :5173, and NWC_PAYER/NWC_RECIPIENT.
import puppeteer from 'puppeteer-core';
import { generateSecretKey, getPublicKey, nip19, SimplePool, finalizeEvent } from 'nostr-tools';
import { KIND_GROUP, fetchInvoice, joinEvent, parseGroup, secretKeyCipher } from '@ajo/core';
import { devLnurlServer, nostrLedger, runOnce } from '@ajo/bot';

const { NWC_PAYER, NWC_RECIPIENT } = process.env;
if (!NWC_PAYER || !NWC_RECIPIENT) throw new Error('set NWC_PAYER and NWC_RECIPIENT');
const relay = 'ws://localhost:7777';
const app = process.env.APP ?? 'http://localhost:5173';
const shots = process.env.SHOTS ?? '.';
const PORT = 3457;

const recipientKey = generateSecretKey();
const botKey = generateSecretKey();
const server = await devLnurlServer(NWC_RECIPIENT, PORT);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const pool = new SimplePool();
const step = (msg: string) => console.log('ok  ', msg);
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); step(msg); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`${app}/#/`);
  const text = (t: string, timeout = 30000) =>
    page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
  const clickButton = (label: string) =>
    page.evaluate((l) => { [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(l))!.click(); }, label);

  await page.screenshot({ path: `${shots}/1-login.png` });
  await clickButton('Create a test key');
  await text('Your groups');
  const nsec = await page.evaluate(() => localStorage.getItem('ajo.localKey')!);
  const mePub = getPublicKey((nip19.decode(nsec as `nsec1${string}`).data as Uint8Array));
  step('signed in with a test key');

  await page.evaluate((s) => localStorage.setItem('ajo.settings', JSON.stringify(s)),
    { relay, coordinator: nip19.npubEncode(getPublicKey(botKey)), nwcUrl: NWC_PAYER });
  await page.goto(`${app}/#/new`);
  await page.reload();
  await text('New group');
  await page.type('input[placeholder="Office ajo"]', 'Browser ajo');
  const amount = await page.$('input[inputmode="numeric"]');
  await amount!.click({ clickCount: 3 });
  await amount!.type('1000');
  // this test adds members by their keys; invite links have their own test
  await page.evaluate(() => { [...document.querySelectorAll('label.radio')].find((l) => l.textContent?.includes('already have'))!.querySelector('input')!.click(); });
  await page.waitForSelector('textarea');
  const members = await page.$('textarea');
  await members!.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await members!.type(`${nip19.npubEncode(getPublicKey(recipientKey))}\n${nip19.npubEncode(mePub)}`);
  await page.screenshot({ path: `${shots}/2-new-group.png` });
  await clickButton('Create group');
  await text('Join this group');
  const groupId = decodeURIComponent(page.url().split('/').pop()!);
  step(`group created (${groupId})`);

  // The recipient is a member too: unwrap the group key the browser user published for them.
  const [groupEv] = await pool.querySync([relay], { kinds: [KIND_GROUP], authors: [mePub], '#d': [groupId] });
  if (!groupEv) throw new Error('group event not on the relay');
  check(!groupEv.content.includes('Browser ajo'), 'group name is not readable on the relay');
  const { key: groupKey } = await parseGroup(groupEv, getPublicKey(recipientKey), secretKeyCipher(recipientKey));
  await pool.publish([relay], finalizeEvent(joinEvent({ groupId, lightningAddress: `amaka@localhost:${PORT}` }, groupKey), recipientKey))[0];
  await page.type('input[placeholder="you@wallet.com"]', 'me@unused.test');
  await clickButton('Join');
  await text('Waiting for the coordinator to open this round');
  step('joined; UI waits for the coordinator');

  // ask the assistant through the real UI before the bot's next pass
  await page.type('input[placeholder="Ask a question"]', 'when is my turn?');
  await clickButton('Ask');
  await text('Thinking');
  const ledger = nostrLedger([relay], botKey);
  await runOnce(ledger, { author: mePub, id: groupId }, (a, s) => fetchInvoice(a, s));
  await text('You receive in round 2', 30000);
  step('the assistant answered the question in the UI');
  await text('Pay 1,000 sats');
  await page.screenshot({ path: `${shots}/3-pay.png` });
  await page.waitForSelector('img[alt="Lightning invoice QR code"]', { timeout: 15000 });
  const qrOk = await page.evaluate(() => { const i = document.querySelector('img[alt="Lightning invoice QR code"]') as HTMLImageElement; return i.naturalWidth > 100; });
  check(qrOk, 'the pay card shows a scannable QR code for the invoice');
  step('bot issued an invoice; Pay button is shown');

  await clickButton('Pay 1,000 sats');
  await text("You've paid", 90000);
  step('paid over Lightning from the browser and published the receipt');

  await runOnce(ledger, { author: mePub, id: groupId }, (a, s) => fetchInvoice(a, s));
  await text('Complete', 30000);
  await text('The coordinator has confirmed it', 30000).catch(() => undefined);
  await page.screenshot({ path: `${shots}/4-done.png` });
  step('bot confirmed the receipt; schedule shows the round complete');
} finally {
  await browser.close();
  server.close();
  pool.close([relay]);
}
process.exit(0);
