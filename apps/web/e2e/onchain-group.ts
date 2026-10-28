// An ajo that is paid in Bitcoin on-chain, in real Chrome, on the real Mutinynet signet:
// organizer makes an on-chain group and an invite link → a member (who has a funded in-app wallet) joins with
// "Use my wallet's address" → the member pays from the group page, the payment carrying its tag →
// the coordinator reads the blockchain and closes the round by itself, with no receipt and no proof.
// Needs the relay, `vite` on :5173, internet, and ONCHAIN_TEST_MNEMONIC holding some signet coins (see e2e:bitcoin).
import puppeteer from 'puppeteer-core';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { esploraChain, nostrLedger, runOnce } from '@ajo/bot';
import { Account, Esplora, chosenNetwork, newMnemonic, scanWallet, seedFromMnemonic } from '../src/lib/onchain/index';

const mnemonic = process.env.ONCHAIN_TEST_MNEMONIC;
if (!mnemonic) throw new Error('set ONCHAIN_TEST_MNEMONIC (run `npm run e2e:bitcoin -w @ajo/web` once to get one)');
const relay = process.env.RELAY ?? 'ws://localhost:7777';
const app = process.env.APP ?? 'http://localhost:5173';
const shots = process.env.SHOTS ?? '.';
const AMOUNT = 1000;
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };

const net = chosenNetwork({});
const api = new Esplora(net.esplora);
const payer = new Account(seedFromMnemonic(mnemonic), net);
const funds = (await scanWallet(payer, api)).confirmedSats;
const organizerAddress = new Account(seedFromMnemonic(newMnemonic()), net).address(0, 0);
console.log(`test wallet holds ${funds} confirmed sats; the organizer (recipient) will be paid at ${organizerAddress}`);

const botKey = generateSecretKey();
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const open = async (name: string) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  await page.setViewport({ width: 900, height: 1100 });
  const text = (t: string, timeout = 60000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
  const click = (label: string) => page.evaluate((l) => {
    const el = [...document.querySelectorAll('button, a.button')].find((b) => b.textContent?.trim() === l || b.textContent?.trim().startsWith(l)) as HTMLElement | undefined;
    if (!el) throw new Error(`no button "${l}"`);
    el.click();
  }, label);
  return { page, text, click };
};

try {
  // --- organizer makes an on-chain group
  const org = await open('organizer');
  await org.page.goto(`${app}/#/`);
  await org.page.evaluate((c, r) => localStorage.setItem('ajo.settings', JSON.stringify({ relay: r, coordinator: c, nwcUrl: '' })), nip19.npubEncode(getPublicKey(botKey)), relay);
  await org.page.reload();
  await org.click('Create a test key');
  await org.text('Your groups');
  const orgPub = getPublicKey(nip19.decode((await org.page.evaluate(() => localStorage.getItem('ajo.localKey')!)) as `nsec1${string}`).data as Uint8Array);
  await org.page.goto(`${app}/#/new`);
  await org.text('New group');
  await org.page.type('input[placeholder="Office ajo"]', 'On-chain ajo');
  const amount = await org.page.$('input[inputmode="numeric"]');
  await amount!.click({ clickCount: 3 });
  await amount!.type(String(AMOUNT));
  await org.page.evaluate(() => (([...document.querySelectorAll('label.radio')].find((l) => l.textContent?.includes('Bitcoin on-chain'))?.querySelector('input')) as HTMLInputElement).click());
  await org.click('Create group');
  await org.text('Invite people');
  const link = await org.page.$eval('input[aria-label="Invite link"]', (i) => (i as HTMLInputElement).value);
  const groupId = decodeURIComponent(org.page.url().split('/').pop()!);
  check(link.includes('r=onchain'), 'the invite link says the group is paid on-chain');
  await org.page.type('input[placeholder="tb1q…"]', organizerAddress);
  await org.click('Join');
  await org.text('Invite people');

  // --- the member restores the funded wallet, opens the link and asks to join with the wallet's address
  const guest = await open('member');
  await guest.page.goto(`${app}/#/`);
  await guest.click('Create a test key');
  await guest.text('Your groups');
  await guest.page.goto(`${app}/#/wallet`);
  await guest.page.reload();
  await guest.text('Your own Bitcoin wallet');
  await guest.click('Restore from twelve words');
  await guest.page.type('textarea', mnemonic);
  const pws = await guest.page.$$('input[type="password"]');
  await pws[0]!.type('member password');
  await pws[1]!.type('member password');
  await guest.click('Create wallet');
  await guest.page.waitForSelector('.balance', { timeout: 60000 });
  await guest.page.goto(link);
  await guest.page.reload();
  await guest.text("You're invited to On-chain ajo");
  check(await guest.page.evaluate(() => document.body.innerText.includes('paid in Bitcoin on-chain')), 'the invite page says the group is paid on-chain');
  await guest.text('Ask to join');
  await guest.click("Use my wallet's address");
  check((await guest.page.$eval('input[placeholder="tb1q…"]', (i) => (i as HTMLInputElement).value)) === payer.address(0, 0), "'Use my wallet's address' filled in the wallet's own address");
  await guest.click('Ask to join');
  await guest.text('Waiting for the organizer');

  await org.page.waitForFunction((a) => document.body.innerText.includes(a), { timeout: 60000 }, payer.address(0, 0));
  await org.click('Add to group');
  await org.page.waitForFunction(() => document.body.innerText.includes('2 in the group so far'), { timeout: 40000 });
  await org.click('Start the group');
  await guest.text('Waiting for the coordinator to open this round');
  check(true, 'the group started with Bitcoin addresses for both members');

  // --- the coordinator opens the round; it asks for no invoices
  const ledger = nostrLedger([relay], botKey);
  const ref = { author: orgPub, id: groupId };
  const chain = esploraChain(net.esplora);
  const run = () => runOnce(ledger, ref, async () => { throw new Error('an on-chain group must not ask for invoices'); }, undefined, { chain, minConfirmations: 1 });
  await run();
  await guest.text('plus the network fee');
  await guest.page.screenshot({ path: `${shots}/18-onchain-group-pay.png` });
  check(true, 'the member sees "pay from my wallet" for the round');

  if (funds < AMOUNT + 600) {
    // not enough coins: the page must say so plainly
    await guest.page.reload();
    await guest.text('plus the network fee');
    await guest.page.type('input[type="password"]', 'member password');
    await guest.click('Unlock');
    await guest.text('from my wallet');
    await guest.page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('from my wallet') && !b.disabled), { timeout: 60000 });
    await guest.click('Pay');
    await guest.text('not enough confirmed Bitcoin');
    check(true, 'with too few coins, the page explains it instead of failing');
    console.log(`\nPARTIAL: fund ${payer.address(0, 0)} with some signet coins (${net.faucet}), then run this again for the real payment.\n`);
  } else {
    await guest.page.reload();
    await guest.text('plus the network fee');
    await guest.page.type('input[type="password"]', 'member password');
    await guest.click('Unlock');
    await guest.text('from my wallet');
    await guest.page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('from my wallet') && !b.disabled), { timeout: 60000 });
    await guest.click('Pay');
    await guest.text('Network fee');
    await guest.page.screenshot({ path: `${shots}/19-onchain-review.png` });
    await guest.click('Sign and send');
    await guest.text('Your payment is on the blockchain');
    check(true, 'the member signed and broadcast a tagged payment from the group page');

    // reloading must not offer a second payment
    await guest.page.reload();
    await guest.text('Your payment is on the blockchain');
    check(!(await guest.page.evaluate(() => document.body.innerText.includes('from my wallet'))), 'after a reload the page recognises the payment and does not offer to pay again');

    // the coordinator closes the round once the blockchain confirms it (~30 s on signet)
    let done = false;
    for (let i = 0; i < 40 && !done; i++) {
      const actions = await run();
      done = actions.some((a) => a.type === 'round-complete');
      if (!done) await new Promise((r) => setTimeout(r, 5000));
    }
    check(done, 'the coordinator read the blockchain, found the tagged payment and closed the round by itself');
    const state = (await ledger.round((await ledger.group(ref))!, 0))!;
    check(!!Object.values(state.txids ?? {})[0] && Object.keys(state.invoices).length === 0, 'the round records the transaction id and no invoices');
    await guest.page.reload();
    await guest.text('Complete');
    await guest.page.screenshot({ path: `${shots}/20-onchain-complete.png` });
    check(true, "the member's page shows the round complete");
  }
} finally {
  await browser.close();
}
process.exit(0);
