// The on-chain wallet, in real Chrome, against the real Mutinynet signet blockchain.
// Part A (always): create a wallet, back it up, lock/unlock, restore on a "second device" and get the same address.
// Part B (when ONCHAIN_TEST_MNEMONIC holds a funded signet wallet): its real balance shows, and a real payment
// to a fresh address of its own is signed in the page, broadcast, and seen confirmed. Costs only the network fee.
// Needs `vite` on :5173. To fund part B, run once without the variable: it prints a mnemonic and an address.
import puppeteer from 'puppeteer-core';
import { Account, Esplora, chosenNetwork, newMnemonic, scanWallet, seedFromMnemonic } from '../src/lib/onchain/index';

const app = process.env.APP ?? 'http://localhost:5173';
const shots = process.env.SHOTS ?? '.';
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const net = chosenNetwork({});
const api = new Esplora(net.esplora);

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const newDevice = async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 900, height: 1200 });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  const text = (t: string, timeout = 60000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
  const click = (label: string) => page.evaluate((l) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === l) as HTMLElement | undefined;
    if (!el) throw new Error(`no button "${l}"`);
    el.click();
  }, label);
  await page.goto(`${app}/#/`);
  await click('Create a test key');
  await text('Your groups');
  await page.goto(`${app}/#/wallet`);
  await page.reload();
  return { ctx, page, text, click };
};
const typeInto = async (page: any, selector: string, value: string) => { const el = await page.$(selector); await el.click({ clickCount: 3 }); await el.type(value); };
const passwords = async (page: any, pw: string) => {
  const inputs = await page.$$('input[type="password"]');
  await inputs[0].type(pw);
  await inputs[1].type(pw);
};

try {
  // ---- Part A
  const a = await newDevice();
  await a.text('Your own Bitcoin wallet');
  check(await a.page.evaluate(() => document.body.innerText.includes('test network')), 'the page says it is a test network');
  await a.click('Create a new wallet');
  await a.text('Write these twelve words down');
  const words: string[] = await a.page.$$eval('.words li', (lis) => lis.map((li) => li.textContent!.replace(/^\d+\s*/, '').trim()));
  check(words.length === 12, 'twelve recovery words are shown');
  await a.page.screenshot({ path: `${shots}/13-btc-words.png` });
  await a.click('I wrote them down');
  await a.text('Check your backup');
  const positions: number[] = await a.page.$$eval('label', (ls) => ls.map((l) => /^Word (\d+)/.exec(l.textContent ?? '')?.[1]).filter(Boolean).map(Number));
  // a wrong answer is refused
  const boxes = await a.page.$$('input[autocomplete="off"]');
  for (const box of boxes) await box.type('wrong');
  await a.click('Continue');
  await a.text("Those don't match");
  check(true, 'a wrong backup check is refused');
  for (const [i, box] of boxes.entries()) { await box.click({ clickCount: 3 }); await box.type(words[positions[i]! - 1]!); }
  await a.click('Continue');
  await a.text('Lock it with a password');
  await passwords(a.page, 'correct horse battery');
  await a.click('Create wallet');
  await a.page.waitForSelector('.balance', { timeout: 60000 });
  await a.text('Receive Bitcoin');
  const address = await a.page.$eval('[data-testid="receive-address"]', (e) => e.textContent!.trim());
  const expected = new Account(seedFromMnemonic(words.join(' ')), net).address(0, 0);
  check(address === expected, `the receive address (${address}) is the first BIP-84 address of the shown words`);
  check(address.startsWith('tb1q'), 'it is a native SegWit signet address');
  await a.page.waitForSelector('img[alt="Bitcoin address QR code"]');
  await a.page.screenshot({ path: `${shots}/14-btc-receive.png` });
  check((await a.page.$eval('.balance', (e) => e.textContent)) === '0 sats', 'a brand-new wallet shows 0 sats');

  // lock, wrong password, right password, and it survives a reload
  await a.click('Lock');
  await a.text('Unlock your wallet');
  await a.page.type('input[type="password"]', 'nope nope nope');
  await a.click('Unlock');
  await a.text('Wrong password');
  check(true, 'a wrong password is refused');
  await typeInto(a.page, 'input[type="password"]', 'correct horse battery');
  await a.click('Unlock');
  await a.page.waitForSelector('.balance', { timeout: 60000 });
  await a.page.reload();
  await a.text('Unlock your wallet');
  check(true, 'after a reload the wallet is still there, locked');
  await a.page.type('input[type="password"]', 'correct horse battery');
  await a.click('Unlock');
  await a.page.waitForSelector('.balance', { timeout: 60000 });

  // backup shows the same words only after the password
  await a.click('Backup');
  await a.page.type('input[type="password"]', 'correct horse battery');
  await a.click('Show the words');
  await a.page.waitForSelector('.words');
  const again: string[] = await a.page.$$eval('.words li', (lis) => lis.map((li) => li.textContent!.replace(/^\d+\s*/, '').trim()));
  check(again.join(' ') === words.join(' '), 'Backup shows the same twelve words after the password');
  await a.ctx.close();

  // a "second device" restores from the words
  const b = await newDevice();
  await b.click('Restore from twelve words');
  await b.page.type('textarea', words.join(' '));
  await passwords(b.page, 'another password');
  await b.click('Create wallet');
  await b.page.waitForSelector('[data-testid="receive-address"]', { timeout: 60000 });
  check((await b.page.$eval('[data-testid="receive-address"]', (e) => e.textContent!.trim())) === address, 'restoring the words on another device gives the same address');
  await b.ctx.close();

  // ---- Part B
  const mnemonic = process.env.ONCHAIN_TEST_MNEMONIC;
  if (!mnemonic) {
    const fresh = newMnemonic();
    const first = new Account(seedFromMnemonic(fresh), net).address(0, 0);
    console.log(`\nPart B skipped. To run it, add this to .env and fund the address with test coins (${net.faucet}):\n`);
    console.log(`ONCHAIN_TEST_MNEMONIC="${fresh}"\nfund: ${first}\n`);
  } else {
    const mine = new Account(seedFromMnemonic(mnemonic), net);
    const before = await scanWallet(mine, api);
    check(before.confirmedSats > 2000, `the test wallet holds ${before.confirmedSats} confirmed sats (needs > 2000)`);
    const c = await newDevice();
    await c.click('Restore from twelve words');
    await c.page.type('textarea', mnemonic);
    await passwords(c.page, 'test password 1');
    await c.click('Create wallet');
    await c.page.waitForFunction((n) => document.querySelector('.balance')?.textContent === `${n.toLocaleString('en')} sats`, { timeout: 60000 }, before.confirmedSats);
    check(true, `the page shows the real balance from the blockchain (${before.confirmedSats} sats)`);
    await c.page.screenshot({ path: `${shots}/15-btc-funded.png` });

    // pay a fresh address of its own: the only cost is the fee
    const target = mine.address(0, before.nextReceive);
    await c.click('Send');
    await c.page.type('input[placeholder="tb1q…"]', target);
    await c.page.type('input[inputmode="numeric"]', '1000');
    await c.click('Review');
    await c.text('Check before you send');
    await c.page.screenshot({ path: `${shots}/16-btc-review.png` });
    await c.click('Sign and send');
    await c.text('The network accepted your payment');
    const txid = await c.page.$eval('a[href*="/tx/"] code', (e) => e.textContent!.replace('…', ''));
    check(txid.length === 16, `broadcast accepted (tx ${txid}…)`);

    // the chain agrees, then the page shows it confirmed
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      const snap = await scanWallet(mine, api);
      seen = snap.txs.some((t) => t.txid.startsWith(txid) && t.confirmed);
      if (!seen) await new Promise((r) => setTimeout(r, 5000));
    }
    check(seen, 'the payment was mined into a block (signet blocks come every ~30s)');
    await c.click('Send another');
    await c.click('History');
    await c.page.waitForFunction(() => /confirmation/.test(document.body.innerText), { timeout: 90000 });
    check(true, 'History shows it with its confirmations');
    await c.page.screenshot({ path: `${shots}/17-btc-history.png` });
    await c.ctx.close();
  }
  console.log('\nALL ON-CHAIN WALLET CHECKS PASSED');
} finally {
  await browser.close();
}
