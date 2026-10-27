import { nip19 } from 'nostr-tools';
import type { Frequency, Standing } from '@ajo/core';

/** Accepts an npub or a 64-character hex pubkey. */
export function toHexPubkey(input: string): string {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  const decoded = nip19.decode(value as `npub1${string}`);
  if (decoded.type !== 'npub') throw new Error(`"${value}" is not an npub`);
  return decoded.data;
}

/** Splits a pasted list of npubs/hex keys on whitespace and commas. */
export function parseMembers(text: string): string[] {
  const members = text.split(/[\s,]+/).filter(Boolean).map(toHexPubkey);
  if (new Set(members).size !== members.length) throw new Error('A member is listed twice.');
  return members;
}

export const shortKey = (hex: string) => {
  const npub = nip19.npubEncode(hex);
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
};

export const formatSats = (sats: number) => `${sats.toLocaleString('en')} sats`;

export const formatDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });

export const frequencyLabel: Record<Frequency, string> = {
  weekly: 'Every week',
  biweekly: 'Every two weeks',
  monthly: 'Every month',
};

export function validateAddress(address: string): string | undefined {
  return /^[^@\s]+@[^@\s]+$/.test(address.trim()) ? undefined : 'Enter an address like name@wallet.com';
}

/** A member's record in this group, in plain words. */
export function recordText(s: Standing): string {
  if (s.owed === 0 && s.received === 0) return 'No finished rounds yet';
  const parts: string[] = [];
  if (s.owed > 0) {
    const paid = s.onTime + s.late;
    parts.push(`Paid ${paid} of ${s.owed}${s.late ? ` (${s.late} late)` : ''}`);
  }
  if (s.defaulted > 0) parts.push(`missed ${s.defaulted}`);
  if (s.received > 0) parts.push(`received ${s.received}`);
  return parts.join(' · ');
}
