// Paying with a browser wallet extension (WebLN), in real Chrome with a real Lightning payment. The extension is a stand-in
// that pays through hub 1; what is tested is the page: it must show the payment as made, must not offer to pay a second
// time (not even after a reload), and the bot must close the round. MODE=noproof: the extension pays but returns no payment
// proof. MODE=unknown: it pays, then errors (a timeout), so the page can't know the outcome and must lock until the person checks. Needs the relay, `vite` on :5173, NWC_PAYER and NWC_RECIPIENT.
import puppeteer from 'puppeteer-core';
import { SimplePool, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { KIND_REQUEST, checkVerify, fetchInvoice } from '@ajo/core';
import { devLnurlServer, nostrLedger, payInvoice, runOnce, safeFetch } from '@ajo/bot';

const { NWC_PAYER, NWC_RECIPIENT } = process.env;
if (!NWC_PAYER || !NWC_RECIPIENT) throw new Error('set NWC_PAYER and NWC_RECIPIENT');
const relay = process.env.RELAY ?? 'ws://localhost:7777';
const app = process.env.APP ?? 'http://localhost:5173';
const shots = process.env.SHOTS ?? '.';
const PORT = 3472;
const MODE = process.env.MODE ?? 'normal';
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
  let paidCalls = 0;
  await guest.page.exposeFunction('__payThroughHub', async (invoice: string) => {
    paidCalls++;
    const { preimage } = await payInvoice(NWC_PAYER, invoice);
    await new Promise((r) => setTimeout(r, 2500)); // the wallet window is open for a moment: the page must stay locked meanwhile
    return preimage;
  });
  await guest.page.evaluateOnNewDocument(`window.webln = { enable: async () => undefined, sendPayment: async (inv) => { const p = await window.__payThroughHub(inv); if ('${MODE}' === 'noproof') return { preimage: 'not-a-preimage' }; if ('${MODE}' === 'unknown') throw new Error('timeout waiting for the wallet'); return { preimage: p }; } };`);
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
  await guest.text('with my browser wallet');
  check(true, 'with a wallet extension and no connected wallet, the page offers "Pay … with my browser wallet"');

  // pay through the extension. While the wallet works, EVERYTHING that could start a payment is locked.
  await guest.click('Pay 1,000 sats with my browser wallet');
  await guest.page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Waiting for your wallet/.test(b.textContent ?? '') && b.disabled), { timeout: 10000 });
  const locked = await guest.page.evaluate(() => ({
    mainDisabled: [...document.querySelectorAll('button')].filter((b) => /with my browser wallet|Waiting for your wallet/.test(b.textContent ?? '')).every((b) => b.disabled),
    openLink: document.querySelector('a[href^="lightning:"]')?.getAttribute('aria-disabled'),
    copyDisabled: [...document.querySelectorAll('button')].find((b) => /Copy invoice/.test(b.textContent ?? ''))?.disabled,
  }));
  check(locked.mainDisabled && locked.openLink === 'true' && locked.copyDisabled === true, 'while the wallet is working, the pay button, "Open in a wallet app" and "Copy invoice" are all disabled');
  const offersAgain = () => guest.page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Pay .* with my browser wallet/.test(b.textContent ?? '') && !b.disabled));

  if (MODE === 'unknown') {
    await guest.text('check your wallet first');
    check(!(await offersAgain()), 'the wallet paid but then errored: the page asks the person to check their wallet and offers no way to pay again');
    await guest.page.reload();
    await guest.text('check your wallet first');
    check(!(await offersAgain()), 'after a reload it is still locked');
  } else {
    await guest.text("You've paid");
    check(true, "the page says \"You've paid\" as soon as the wallet has paid" + (MODE === 'noproof' ? ' (even though no proof came back)' : ''));
    if (MODE === 'noproof') check(await guest.page.evaluate(() => document.body.innerText.includes("didn't return a payment proof")), 'it explains that no proof came back and what happens next');
    check(!(await offersAgain()), 'the pay button is gone, so it cannot be pressed a second time');
    await guest.page.reload();
    await guest.text("You've paid");
    check(!(await offersAgain()), 'after a reload the page still knows it was paid and does not offer to pay again');
  }
  check(paidCalls === 1, 'the wallet was asked to pay exactly once');

  // the bot sees the payment through the provider and closes the round
  let done = false;
  for (let i = 0; i < 12 && !done; i++) { done = (await run()).some((a) => a.type === 'round-complete'); if (!done) await new Promise((r) => setTimeout(r, 3000)); }
  check(done, 'the bot confirmed the payment and closed the round');
  await guest.page.reload();
  await guest.text('Complete');
  check(true, "the member's page shows the round complete");
} finally {
  await browser.close();
  server.close();
  pool.close([relay]);
}
process.exit(0);
