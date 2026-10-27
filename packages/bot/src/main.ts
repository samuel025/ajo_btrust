import { nip19 } from 'nostr-tools';
import { fetchInvoice, type GroupRef } from '@ajo/core';
import { discoverGroups, nostrLedger } from './nostr-ledger';
import { runOnce } from './runner';

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
const INTERVAL_MS = 30_000;

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
      const actions = await runOnce(ledger, ref, (address, sats) => fetchInvoice(address, sats));
      for (const action of actions) console.log(ref.id, JSON.stringify(action));
    } catch (e) {
      console.error(ref.id, (e as Error).message);
    }
  }
}

console.log(`Coordinator running against ${relays.join(', ')}`);
await loop();
setInterval(loop, INTERVAL_MS);
