import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type EventTemplate, type NostrEvent } from 'nostr-tools';
import { secretKeyCipher, type Cipher } from '@ajo/core';

export interface Signer {
  kind: 'extension' | 'local';
  pubkey: string;
  sign(template: EventTemplate): Promise<NostrEvent>;
  /** NIP-44 encryption, used to share each group's key. */
  cipher: Cipher;
}

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

const nip07 = () => (globalThis as { nostr?: Nip07 }).nostr;
const KEY = 'ajo.localKey';

export const hasExtension = () => !!nip07();

export async function extensionSigner(): Promise<Signer> {
  const ext = nip07();
  if (!ext) throw new Error('No Nostr extension found. Install one such as Alby or nos2x, or use a local key.');
  const nip44 = () => {
    if (!ext.nip44) throw new Error('Your Nostr extension does not support NIP-44 encryption, which groups need. Update it, or use a test key.');
    return ext.nip44;
  };
  return {
    kind: 'extension',
    pubkey: await ext.getPublicKey(),
    sign: (t) => ext.signEvent(t),
    cipher: { encrypt: (peer, text) => nip44().encrypt(peer, text), decrypt: (peer, text) => nip44().decrypt(peer, text) },
  };
}

/** A throwaway key kept in this browser, for trying the app without an extension. */
export function localSigner(nsec?: string): Signer {
  let key: Uint8Array;
  if (nsec) {
    const decoded = nip19.decode(nsec as `nsec1${string}`);
    if (decoded.type !== 'nsec') throw new Error('That is not an nsec key.');
    key = decoded.data;
  } else {
    key = generateSecretKey();
  }
  try { localStorage.setItem(KEY, nip19.nsecEncode(key)); } catch { /* session only */ }
  return { kind: 'local', pubkey: getPublicKey(key), sign: async (t) => finalizeEvent(t, key), cipher: secretKeyCipher(key) };
}

export function restoreSigner(): Signer | undefined {
  try {
    const nsec = localStorage.getItem(KEY);
    return nsec ? localSigner(nsec) : undefined;
  } catch {
    return undefined;
  }
}

export function forgetLocalKey() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to forget */ }
}
