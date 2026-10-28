// The whole easy path, in real Chrome with two separate identities and a real Lightning payment:
// organizer creates a group and shares a link → a stranger opens it, asks to join → organizer approves
// and starts → a wallet outside the app pays the invoice → the bot confirms by itself, no receipt.
// Needs the relay, `vite` on :5173, and NWC_PAYER / NWC_RECIPIENT.
import puppeteer from 'puppeteer-core';
import { SimplePool, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { KIND_REQUEST, checkVerify, fetchInvoice } from '@ajo/core';
import { devLnurlServer, nostrLedger, payInvoice, runOnce, safeFetch } from '@ajo/bot';

const { NWC_PAYER, NWC_RECIPIENT } = process.env;
if (!NWC_PAYER || !NWC_RECIPIENT) throw new Error('set NWC_PAYER and NWC_RECIPIENT');
const relay = process.env.RELAY ?? 'ws://localhost:7777';
const app = process.env.APP ?? 'http://localhost:5173';
const shots = process.env.SHOTS ?? '.';
const PORT = 3461;
const GUEST_ADDRESS = `guest-secret-address@localhost:${PORT}`;
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };

const botKey = generateSecretKey();
const server = await devLnurlServer(NWC_RECIPIENT, PORT);
const guarded = safeFetch({ allowLocal: true });
const pool = new SimplePool();
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });

try {
  const open = async (name: string) => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
    await page.setViewport({ width: 900, height: 1000 });
    const text = (t: string, timeout = 40000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
    const click = (label: string) => page.evaluate((l) => {
      const el = [...document.querySelectorAll('button, a.button')].find((b) => b.textContent?.trim() === l || b.textContent?.includes(l)) as HTMLElement | undefined;
      if (!el) throw new Error(`no button "${l}"`);
      el.click();
    }, label);
    return { page, text, click };
  };

  // --- organizer
  const org = await open('organizer');
  await org.page.goto(`${app}/#/`);
  await org.page.evaluate((c, r) => localStorage.setItem('ajo.settings', JSON.stringify({ relay: r, coordinator: c, nwcUrl: '' })), nip19.npubEncode(getPublicKey(botKey)), relay);
  await org.page.reload();
  await org.click('Create a test key');
  await org.text('Your groups');
  const orgPub = getPublicKey(nip19.decode((await org.page.evaluate(() => localStorage.getItem('ajo.localKey')!)) as `nsec1${string}`).data as Uint8Array);

  await org.page.goto(`${app}/#/new`);
  await org.text('New group');
  await org.page.type('input[placeholder="Office ajo"]', 'Invite test');
  const amount = await org.page.$('input[inputmode="numeric"]');
  await amount!.click({ clickCount: 3 });
  await amount!.type('1000');
  await org.click('Create group');
  await org.text('Invite people');
  const link = await org.page.$eval('input[aria-label="Invite link"]', (i) => (i as HTMLInputElement).value);
  const groupId = decodeURIComponent(org.page.url().split('/').pop()!);
  check(link.includes('/#/invite/') && !/nsec|secret/i.test(link), `organizer got an invite link without any secret in it`);
  await org.page.screenshot({ path: `${shots}/6-organizer-invite.png` });

  // the organizer is paid first, so they need an address that works
  await org.page.type('input[placeholder="you@wallet.com"]', `amaka@localhost:${PORT}`);
  await org.click('Join');
  await org.text('Invite people');

  // --- guest: a stranger with only the link, in a separate browser identity
  const guest = await open('guest');
  await guest.page.goto(link);
  await guest.text("You're invited to Invite test");
  await guest.page.screenshot({ path: `${shots}/7-invite-landing.png` });
  await guest.click('Continue');
  await guest.text('Ask to join');
  await guest.page.type('input[placeholder="you@wallet.com"]', GUEST_ADDRESS);
  await guest.click('Ask to join');
  await guest.text('Waiting for the organizer');
  check(true, 'a stranger opened the link, signed in with one click, and asked to join');

  const requests = await pool.querySync([relay], { kinds: [KIND_REQUEST], '#a': [groupId] });
  check(requests.length === 1 && !JSON.stringify(requests).includes('guest-secret'), 'the request is on the relay but its contents are not readable');

  // --- organizer approves and starts
  await org.text('Requests to join');
  await org.page.waitForFunction(() => document.body.innerText.includes('guest-secret-address@localhost'), { timeout: 40000 });
  await org.page.screenshot({ path: `${shots}/8-organizer-requests.png` });
  await org.click('Add to group');
  await org.page.waitForFunction(() => document.body.innerText.includes('2 in the group so far'), { timeout: 40000 });
  await org.click('Start the group');
  await org.text('Waiting for the coordinator to open this round');
  check(true, 'the organizer approved the request and started the group');

  // --- the guest's page opens the group by itself and finishes joining with the address they gave
  await guest.text('Waiting for the coordinator to open this round');
  check(true, 'the guest was taken into the group and joined automatically');

  // --- the bot runs; the guest pays from "any wallet"
  const ledger = nostrLedger([relay], botKey);
  const ref = { author: orgPub, id: groupId };
  const run = () => runOnce(ledger, ref, (a, s) => fetchInvoice(a, s, guarded), undefined, { checkPayment: (u) => checkVerify(u, guarded) });
  await run();
  await guest.page.waitForSelector('img[alt="Lightning invoice QR code"]', { timeout: 40000 });
  await guest.text('confirms the payment by itself');
  await guest.page.screenshot({ path: `${shots}/9-guest-pays.png` });
  check(true, 'the guest sees a QR code and is told the payment confirms by itself');

  const group = (await ledger.group(ref))!;
  const state = (await ledger.round(group, 0))!;
  const guestPub = group.payoutOrder.find((m) => m !== orgPub)!;
  const { preimage } = await payInvoice(NWC_PAYER, state.invoices[guestPub]!); // stands in for any wallet app
  check(/^[0-9a-f]{64}$/.test(preimage), 'a wallet outside the app paid the invoice over real Lightning');

  const actions = await run();
  check(actions.some((a) => a.type === 'payment-detected') && actions.some((a) => a.type === 'round-complete'), 'the bot confirmed it by itself and closed the round');
  // the round closed, so the guest's page moves on to round 2 and records round 1 as paid
  await guest.text('Paid 1 of 1');
  await guest.text('Complete');
  await guest.page.screenshot({ path: `${shots}/10-guest-paid.png` });
  check(true, "the guest's page shows round 1 complete and their payment on record");

  // Round 1 was paid within minutes, but round 2 must wait for its period: both people are told when it opens
  await guest.text('Round 2 opens');
  await org.text('Round 2 opens');
  await org.text('You can pay from');
  await org.page.screenshot({ path: `${shots}/11-round2-waits.png` });
  check(true, 'round 2 is announced with its opening date instead of opening at once');

  // "Catch me up": the member asks, the coordinator writes a recap from the group's facts, and it shows up in the thread
  await guest.click('Catch me up');
  await run();
  await guest.text('rounds are complete');
  check(true, '"Catch me up" produced a recap of the group in the member\'s thread');
} finally {
  await browser.close();
  server.close();
  pool.close([relay]);
}
process.exit(0);
