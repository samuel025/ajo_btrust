import { describe, expect, it } from 'vitest';
import { inviteLink, inviteRoute, parseInvite } from '../src/lib/invite';

const author = 'ab'.repeat(32);
const invite = { author, id: 'office-ajo-x1y2z', name: 'Office ajo & friends', amountSats: 50_000, frequency: 'weekly' as const };

describe('invite links', () => {
  it('round-trips, including names with spaces and symbols', () => {
    expect(parseInvite(inviteRoute(invite))).toEqual(invite);
    expect(inviteLink(invite, 'https://ajo.example')).toBe(`https://ajo.example/#${inviteRoute(invite)}`);
  });

  it('does not carry anything secret: only the preview fields', () => {
    const route = inviteRoute(invite);
    expect(new URLSearchParams(route.split('?')[1]).size).toBe(3);
    expect(route).not.toMatch(/key|nsec|secret/i);
  });

  it.each([
    ['not an invite', '/g/abc/def'],
    ['a bad organizer key', `/invite/xyz/id?n=A&a=1&f=weekly`],
    ['a missing name', `/invite/${author}/id?a=1&f=weekly`],
    ['a zero amount', `/invite/${author}/id?n=A&a=0&f=weekly`],
    ['a fractional amount', `/invite/${author}/id?n=A&a=1.5&f=weekly`],
    ['an unknown frequency', `/invite/${author}/id?n=A&a=1&f=hourly`],
    ['an oversized name', `/invite/${author}/id?n=${'x'.repeat(200)}&a=1&f=weekly`],
  ])('rejects %s', (_name, route) => expect(parseInvite(route)).toBeUndefined());
});
