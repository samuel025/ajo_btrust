// The wallet, in real Chrome, against real Lightning on Mutinynet. The page connects to a wallet over NWC,
// then: shows its balance, receives a payment (made from outside the page), sends to an invoice, sends
// to a Lightning address, shows a spending budget, and explains it when the budget refuses a payment.
// Needs the relay is NOT required. Needs `vite` on :5173 and NWC_PAYER, NWC_RECIPIENT, NWC_AUTOPAY. Spends ~1400 test sats.
import { NWCClient } from '@getalby/sdk';
import puppeteer from 'puppeteer-core';
import { devLnurlServer } from '@ajo/bot';

const { NWC_PAYER, NWC_RECIPIENT, NWC_AUTOPAY } = process.env;
if (!NWC_PAYER || !NWC_RECIPIENT || !NWC_AUTOPAY) throw new Error('set NWC_PAYER, NWC_RECIPIENT and NWC_AUTOPAY');
const app = process.env.APP ?? 'http://localhost:5173';
const shots = process.env.SHOTS ?? '.';
const PORT = 3463;
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };

const hub1 = new NWCClient({ nostrWalletConnectUrl: NWC_PAYER });
const hub2 = new NWCClient({ nostrWalletConnectUrl: NWC_RECIPIENT });
const stand = await devLnurlServer(NWC_RECIPIENT, PORT);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1100 });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  const text = (t: string, timeout = 45000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
  const click = (label: string) => page.evaluate((l) => {
    const el = [...document.querySelectorAll('button, summary')].find((b) => b.textContent?.trim() === l || b.textContent?.trim().startsWith(l)) as HTMLElement | undefined;
    if (!el) throw new Error(`no button "${l}"`);
    el.click();
  }, label);
  const connect = async (url: string) => {
    await click('I have a connection code to paste instead'); // the pasted code lives in a collapsed section
    await page.type('input[type="password"]', url);
    await page.evaluate(() => (document.querySelector('details form button') as HTMLElement).click());
    await page.waitForSelector('.balance', { timeout: 45000 });
  };

  await page.goto(`${app}/#/`);
  await click('Create a test key');
  await text('Your groups');
  await page.goto(`${app}/#/wallet`);
  await page.reload();

  // 1. connect hub 2 as "my wallet" and show its balance
  await click('Lightning');
  await text('Connect your wallet');
  await connect(NWC_RECIPIENT);
  await text('signet (test coins)');
  const expected = Math.floor((await hub2.getBalance()).balance / 1000);
  await page.waitForFunction((n) => document.querySelector('.balance')?.textContent === `${n.toLocaleString('en')} sats`, { timeout: 30000 }, expected);
  check(true, `the wallet page connected and shows the wallet's balance (${expected.toLocaleString('en')} sats, test coins, so no naira)`);
  check(!(await page.evaluate(() => document.body.innerText.includes('≈ ₦'))), 'it does not put a naira value on test coins');

  // 2. receive: an invoice appears as a QR code, and a payment from outside the page is noticed
  await click('Receive');
  const amount = await page.$('input[inputmode="numeric"]');
  await amount!.click({ clickCount: 3 });
  await amount!.type('700');
  await click('Create invoice');
  await page.waitForSelector('img[alt="Lightning invoice QR code"]', { timeout: 45000 });
  const invoice = (await page.$eval('a.button[href^="lightning:"]', (a) => a.getAttribute('href')!)).replace(/^lightning:/, '');
  await page.screenshot({ path: `${shots}/12-wallet-receive.png` });
  await hub1.payInvoice({ invoice }); // someone else's wallet pays it
  await text('arrived in your wallet', 60000);
  check(true, 'receive: the page made a QR invoice, and noticed when it was paid from another wallet');

  await click('History');
  await text('+700 sats');
  check(true, 'history lists the received payment');

  // 3. switch to hub 1 and send to an invoice
  await click('About this connection');
  await click('Disconnect this wallet');
  await text('Connect your wallet');
  await connect(NWC_PAYER);
  await click('Send');
  const bill = await hub2.makeInvoice({ amount: 400_000, description: 'e2e invoice' });
  await page.type('textarea', bill.invoice);
  await text('Pay 400 sats');
  await page.screenshot({ path: `${shots}/13-wallet-send.png` });
  await click('Pay 400 sats');
  await text('Sent', 60000);
  check((await hub2.lookupInvoice({ payment_hash: bill.payment_hash })).state === 'settled', 'send to an invoice: the page paid it and the receiving wallet shows it settled');

  // 4. send to a Lightning address (the page asks the provider for an invoice itself)
  await click('Send another');
  await page.type('textarea', `shop@localhost:${PORT}`);
  const sats = await page.$('input[inputmode="numeric"]');
  await sats!.type('300');
  await click('Get invoice');
  await text('to shop@localhost');
  await click('Pay 300 sats');
  await text('Sent', 60000);
  const recent = (await hub2.listTransactions({ limit: 6 })).transactions;
  check(recent.some((t) => t.type === 'incoming' && t.state === 'settled' && t.amount === 300_000), 'send to a Lightning address: the page fetched an invoice from the provider and paid 300 sats');

  // 5. a connection with a spending budget: it is shown, and a payment beyond it is refused in plain words
  await click('About this connection');
  await click('Disconnect this wallet');
  await text('Connect your wallet');
  await connect(NWC_AUTOPAY);
  await text('Spending budget');
  await page.screenshot({ path: `${shots}/14-wallet-budget.png` });
  check(true, 'a connection with a budget shows how much of it is used');
  await click('Send');
  const big = await hub2.makeInvoice({ amount: 5_000_000, description: 'over budget' });
  await page.type('textarea', big.invoice);
  await text('Pay 5,000 sats');
  await click('Pay 5,000 sats');
  await text('spending budget is used up', 60000);
  check((await hub2.lookupInvoice({ payment_hash: big.payment_hash })).state !== 'settled', 'a payment beyond the budget was refused with a plain explanation, and no money moved');
} finally {
  await browser.close();
  stand.close();
  hub1.close(); hub2.close();
}
process.exit(0);
