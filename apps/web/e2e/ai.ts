// The AI screens in real Chrome with the real Gemini model: "Describe your group" fills the New group form, and the wallet
// guide answers in the Lightning tab. Starts its own AI service on :3480 (the port the app uses in development).
import puppeteer from 'puppeteer-core';
import { geminiComplete } from '../../../packages/bot/src/ai';
import { aiServer } from '../../../packages/bot/src/ai-server';

const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!key) throw new Error('set GEMINI_API_KEY');
const app = process.env.APP ?? 'http://localhost:5173';
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const server = aiServer({ complete: geminiComplete({ apiKey: key }) }).listen(3480, '127.0.0.1');
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.setViewport({ width: 900, height: 1300 });
  const text = (t: string, timeout = 60000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
  const click = (label: string) => page.evaluate((l) => {
    const el = [...document.querySelectorAll('button, summary')].find((b) => b.textContent?.trim().startsWith(l)) as HTMLElement | undefined;
    if (!el) throw new Error(`no button "${l}"`);
    el.click();
  }, label);

  await page.goto(`${app}/#/`);
  await click('Create a test key');
  await text('Your groups');

  // 1. describe a group
  await page.goto(`${app}/#/new`);
  await text('Describe your group');
  check(true, 'the "Describe your group" box is shown when the AI is on');
  await text('≈ ₦', 30000); // the naira exchange rate has loaded, so naira can be turned into sats
  await page.type('textarea', 'Five friends from church, 10k naira each, every two weeks, starting 15 January, call it Church ajo');
  await click('Fill in the form');
  await text('Filled in:');
  const form = await page.evaluate(() => ({
    name: (document.querySelector('input[placeholder="Office ajo"]') as HTMLInputElement).value,
    amount: (document.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value,
    frequency: (document.querySelector('select') as HTMLSelectElement).value,
    date: (document.querySelector('input[type="date"]') as HTMLInputElement).value,
  }));
  console.log('form now:', JSON.stringify(form));
  check(/church/i.test(form.name), 'the name was filled in');
  check(Number(form.amount) > 1000 && Number(form.amount) < 30000, `₦10,000 became ${form.amount} sats at today's rate (not the 50,000 default)`);
  check(form.frequency === 'biweekly', 'every two weeks became the biweekly option');
  check(/^\d{4}-01-15$/.test(form.date), 'the start date was filled in');
  check(await page.evaluate(() => /5 people|mentioned 5/.test(document.body.innerText)), 'it noted the people mentioned and that they are invited by link');
  check(await page.evaluate(() => !document.body.innerText.includes('Publishing')), 'nothing was created: the person still has to press Create group');

  // 2. the wallet guide
  await page.goto(`${app}/#/wallet`);
  await page.reload();
  await click('Lightning');
  await click("I don't have a Lightning wallet yet");
  await text('Ask the guide');
  await click('What is a Lightning address?');
  await page.waitForFunction(() => document.querySelectorAll('.guide .a').length > 0, { timeout: 60000 });
  const answer = await page.$eval('.guide .a', (e) => e.textContent ?? '');
  console.log('guide says:', answer.slice(0, 200));
  check(/address|email/i.test(answer), 'the guide answered a suggested question');
} finally {
  await browser.close();
  server.close();
}
process.exit(0);
