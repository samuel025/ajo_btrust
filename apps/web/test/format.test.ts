import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { parseMembers, toHexPubkey, validateAddress } from '../src/lib/format';

const hex = 'ab'.repeat(32);
const npub = nip19.npubEncode(hex);

describe('members', () => {
  it('accepts npubs and hex, separated by lines, spaces or commas', () => {
    const other = 'cd'.repeat(32);
    expect(parseMembers(`${npub}\n${other}`)).toEqual([hex, other]);
    expect(parseMembers(`${npub}, ${other}`)).toEqual([hex, other]);
    expect(toHexPubkey(npub)).toBe(hex);
  });

  it('rejects duplicates and bad keys', () => {
    expect(() => parseMembers(`${npub} ${hex}`)).toThrow(/twice/);
    expect(() => parseMembers('not-a-key')).toThrow();
    expect(() => toHexPubkey(nip19.nsecEncode(new Uint8Array(32).fill(1)))).toThrow();
  });
});

describe('validateAddress', () => {
  it('wants name@domain', () => {
    expect(validateAddress('amaka@wallet.com')).toBeUndefined();
    expect(validateAddress('amaka@localhost:3456')).toBeUndefined();
    expect(validateAddress('amaka')).toBeDefined();
    expect(validateAddress('a b@c.com')).toBeDefined();
  });
});
