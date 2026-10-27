import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const key = generateSecretKey();
console.log(`BOT_NSEC=${nip19.nsecEncode(key)}`);
console.log(`Coordinator npub (paste into the app): ${nip19.npubEncode(getPublicKey(key))}`);
