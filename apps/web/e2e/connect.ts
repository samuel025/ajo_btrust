// "Connect your wallet" in real Chrome: the app opens the wallet's approval window, the (stand-in) wallet approves,
// and the app keeps the connection it gets back. The stand-in wallet is a tiny local web page that answers the way
// Alby Hub's approval page does, so this checks the app's side; a real hub is tried by hand (see README).
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { getPublicKey, generateSecretKey } from 'nostr-tools';

const app = process.env.APP ?? 'http://localhost:5173';
const PORT = 3471;
const walletPubkey = getPublicKey(generateSecretKey());
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };

let asked: URL | undefined;
const hub = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  if (url.pathname !== '/apps/new') { res.writeHead(404).end(); return; }
  asked = url;
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Approve</title><p>Approve Bitcoin Ajo?</p>
<script>setTimeout(() => { window.opener.postMessage({ type: 'nwc:success', relayUrls: ['ws://localhost:7777'], walletPubkey: '${walletPubkey}', lud16: 'me@wallet.test' }, '*'); }, 300);</script>`);
}).listen(PORT);

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.setViewport({ width: 900, height: 1100 });
  const text = (t: string, timeout = 30000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
  const click = (label: string) => page.evaluate((l) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(l)) as HTMLElement | undefined;
    if (!el) throw new Error(`no button "${l}"`);
    el.click();
  }, label);

  await page.goto(`${app}/#/`);
  await click('Create a test key');
  await text('Your groups');
  await page.goto(`${app}/#/wallet`);
  await page.reload();
  await click('Lightning');
  await text("Your wallet's address");
  check(await page.evaluate(() => document.body.innerText.includes("I don't have a Lightning wallet yet")), 'a first-time user is shown how to get a wallet');
  check(await page.evaluate(() => document.body.innerText.includes('I have a connection code to paste instead')), 'pasting a connection code is still available, tucked away');

  // pressing Connect with no address is not possible; an insecure address is refused in words
  await page.type('input[placeholder="localhost:8080"]', 'http://wallet.example.com');
  await click('Connect');
  await text('secure address');
  check(true, 'an insecure wallet address is refused with an explanation');

  // the approval round trip
  const input = await page.$('input[placeholder="localhost:8080"]');
  await input!.click({ clickCount: 3 });
  await input!.type(`localhost:${PORT}`);
  await click('Connect');
  await page.waitForFunction(() => { try { return !!JSON.parse(localStorage.getItem('ajo.settings') ?? '{}').nwcUrl; } catch { return false; } }, { timeout: 30000 });
  const nwc: string = await page.evaluate(() => JSON.parse(localStorage.getItem('ajo.settings')!).nwcUrl);
  check(nwc.startsWith(`nostr+walletconnect://${walletPubkey}`), 'the app kept the connection the wallet returned (for that wallet)');
  check(/relay=ws(%3A%2F%2F|:\/\/)localhost(%3A|:)7777/.test(nwc) && /secret=[0-9a-f]{64}/.test(nwc), 'it carries the relay and the app\'s own secret');
  check(asked?.searchParams.get('name') === 'Bitcoin Ajo', 'the wallet was told which app is asking');
  check((asked?.searchParams.get('request_methods') ?? '').split(' ').includes('pay_invoice'), 'the wallet was asked for what the app needs (including paying)');
  check(/^[0-9a-f]{64}$/.test(asked?.searchParams.get('pubkey') ?? ''), 'the wallet was given the app\'s public key to authorise');
  await text('About this connection');
  check(true, 'the wallet page moves on to the connected view');
} finally {
  await browser.close();
  hub.close();
}
process.exit(0);
