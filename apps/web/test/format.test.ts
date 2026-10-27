import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { formatDateTime, nextNineAm, parseMembers, recordText, toHexPubkey, validateAddress } from '../src/lib/format';

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

describe('recordText', () => {
  const base = { owed: 0, onTime: 0, late: 0, defaulted: 0, received: 0, collectedAndLeft: false };
  it('describes a record in plain words', () => {
    expect(recordText(base)).toBe('No finished rounds yet');
    expect(recordText({ ...base, owed: 3, onTime: 2, late: 1, received: 1 })).toBe('Paid 3 of 3 (1 late) · received 1');
    expect(recordText({ ...base, owed: 2, onTime: 1, defaulted: 1 })).toBe('Paid 1 of 2 · missed 1');
  });
});

describe('dates', () => {
  it('formats a moment with its time and timezone', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 3, 9, 0) / 1000)).toMatch(/Nov 3.*\d:\d\d\s?(AM|PM).*/);
  });

  it('finds the next 9:00 AM that is far enough away', () => {
    const hour = (unix: number) => new Date(unix * 1000).getHours();
    const minute = (unix: number) => new Date(unix * 1000).getMinutes();
    // 7:30 PM local: the next 9 AM is tomorrow
    const evening = new Date(2026, 9, 28, 19, 30).getTime();
    const next = nextNineAm(evening);
    expect(hour(next)).toBe(9); expect(minute(next)).toBe(0);
    expect(next * 1000).toBeGreaterThan(evening);
    expect(next * 1000 - evening).toBeLessThan(15 * 3_600_000);
    // 8:30 AM local, but 9 AM is under an hour... exactly 30 minutes away: too soon, so tomorrow
    const early = new Date(2026, 9, 28, 8, 30).getTime();
    expect(nextNineAm(early) * 1000 - early).toBeGreaterThan(23 * 3_600_000);
    // 6 AM local: 9 AM today is 3 hours away, so today
    const dawn = new Date(2026, 9, 28, 6, 0).getTime();
    expect(nextNineAm(dawn) * 1000 - dawn).toBe(3 * 3_600_000);
  });
});
