import { nip19 } from 'nostr-tools';
import { checkVerify, fetchInvoice, type GroupRef, type Language } from '@ajo/core';
import { discoverGroups, nostrLedger } from './nostr-ledger';
import { configuredGeminiModels, geminiWriter } from './ai';
import { templateWriter } from './messages';
import { payInvoice } from './pay';
import { safeFetch } from './safe-fetch';
import { runOnce } from './runner';
import { esploraChain } from './chain';

const nsec = process.env.BOT_NSEC;
const relays = process.env.RELAYS?.split(',');
const groups = process.env.GROUPS?.split(',').filter(Boolean);
const organizers = process.env.ORGANIZERS?.split(',').filter(Boolean);
if (!nsec || !relays || (!groups && !organizers)) {
  console.error(
    'Set BOT_NSEC, RELAYS (comma-separated) and either\n' +
    '  GROUPS     comma-separated <organizer npub or hex>:<group id>, or\n' +
    '  ORGANIZERS comma-separated organizer npubs/hex whose groups this bot should run.',
  );
  process.exit(1);
}
const decoded = nip19.decode(nsec as `nsec1${string}`);
if (decoded.type !== 'nsec') throw new Error('BOT_NSEC must be an nsec');
const secretKey = decoded.data;

const toHex = (key: string) => (key.startsWith('npub') ? (nip19.decode(key as `npub1${string}`).data as string) : key);
const ledger = nostrLedger(relays, secretKey);
/** Every outbound request to an address a member controls goes through this guard. */
const guardedFetch = safeFetch();
const INTERVAL_MS = 30_000;
/** Reads the blockchain to confirm on-chain payments. Mutinynet signet unless ESPLORA_URL says otherwise. */
const chain = esploraChain(process.env.ESPLORA_URL ?? 'https://mutinynet.com/api');
const minConfirmations = Number(process.env.ONCHAIN_MIN_CONFIRMATIONS ?? 1);
const aiReminderLanguages = (process.env.AI_REMINDER_LANGUAGES ?? 'en').split(',').map((l) => l.trim()).filter(Boolean) as Language[];
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const writer = geminiKey
  ? geminiWriter({ apiKey: geminiKey, aiReminderLanguages, onError: (e) => console.error('assistant: Gemini call failed, used a template instead:', (e as Error).message) })
  : templateWriter;
/** Invoices this process has already paid, so a failed publish never leads to a second payment. */
const paid = new Map<string, string>();

async function loop() {
  const refs: GroupRef[] = [
    ...(groups ?? []).map((entry) => {
      const [author, ...rest] = entry.split(':');
      return { author: toHex(author!), id: rest.join(':') };
    }),
    ...(organizers ? await discoverGroups(relays!, secretKey, organizers.map(toHex)) : []),
  ];
  for (const ref of refs) {
    try {
      const actions = await runOnce(ledger, ref, (address, sats) => fetchInvoice(address, sats, guardedFetch), undefined, { pay: payInvoice, paid, writer, chain, minConfirmations, checkPayment: (url) => checkVerify(url, guardedFetch) });
      for (const action of actions) console.log(ref.id, JSON.stringify(action));
    } catch (e) {
      console.error(ref.id, (e as Error).message);
    }
  }
}

console.log(`Coordinator running against ${relays.join(', ')}`);
console.log(writer === templateWriter ? 'Assistant: built-in templates (set GEMINI_API_KEY to use Gemini)' : `Assistant: Gemini (${configuredGeminiModels().join(' → ')}); AI-written reminders in: ${aiReminderLanguages.join(', ')}`);
await loop();
setInterval(loop, INTERVAL_MS);
