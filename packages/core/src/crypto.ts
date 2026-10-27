import { generateSecretKey, nip44 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

/** 32 random bytes shared by a group's members and its coordinator. */
export type GroupKey = Uint8Array;

/** NIP-44 encryption to or from one peer, backed by a local key or a Nostr extension. */
export interface Cipher {
  encrypt(peer: string, plaintext: string): Promise<string>;
  decrypt(peer: string, ciphertext: string): Promise<string>;
}

export const createGroupKey = (): GroupKey => generateSecretKey();

export function secretKeyCipher(secretKey: Uint8Array): Cipher {
  return {
    encrypt: async (peer, plaintext) => nip44.encrypt(plaintext, nip44.getConversationKey(secretKey, peer)),
    decrypt: async (peer, ciphertext) => nip44.decrypt(ciphertext, nip44.getConversationKey(secretKey, peer)),
  };
}

/** Encrypts a JSON value for everyone holding the group key. NIP-44 accepts a 32-byte key directly. */
export const seal = (key: GroupKey, value: unknown): string => nip44.encrypt(JSON.stringify(value), key);

export const open = <T>(key: GroupKey, payload: string): T => JSON.parse(nip44.decrypt(payload, key)) as T;

export const wrapKey = (key: GroupKey, cipher: Cipher, member: string) => cipher.encrypt(member, bytesToHex(key));

export async function unwrapKey(wrapped: string, cipher: Cipher, author: string): Promise<GroupKey> {
  return hexToBytes(await cipher.decrypt(author, wrapped));
}
