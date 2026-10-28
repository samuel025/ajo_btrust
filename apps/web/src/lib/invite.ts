import type { Frequency, GroupRail } from '@ajo/core';

/**
 * An invite carries only what a person needs to decide whether to ask to join: the organizer, the
 * group id, and a preview of its name, amount and frequency. It does not carry the group's key, so a
 * forwarded link can't expose the group's contents. The organizer still approves every request.
 */
export interface Invite {
  author: string;
  id: string;
  name: string;
  amountSats: number;
  frequency: Frequency;
  /** How the group is paid; Lightning when absent. */
  rail?: GroupRail;
}

const FREQUENCIES: Frequency[] = ['weekly', 'biweekly', 'monthly', 'testing'];

/** The hash route for an invite, e.g. "/invite/<organizer>/<id>?n=Office&a=50000&f=weekly". */
export function inviteRoute(invite: Invite): string {
  const query = new URLSearchParams({ n: invite.name, a: String(invite.amountSats), f: invite.frequency });
  if (invite.rail === 'onchain') query.set('r', 'onchain');
  return `/invite/${invite.author}/${encodeURIComponent(invite.id)}?${query}`;
}

export const inviteLink = (invite: Invite, origin = window.location.origin) => `${origin}/#${inviteRoute(invite)}`;

/** Reads an invite route; undefined if it isn't one, or is damaged. */
export function parseInvite(route: string): Invite | undefined {
  const match = route.match(/^\/invite\/([0-9a-f]{64})\/([^/?]+)\?(.*)$/);
  if (!match) return undefined;
  const query = new URLSearchParams(match[3]);
  const name = query.get('n')?.trim() ?? '';
  const amountSats = Number(query.get('a'));
  const frequency = query.get('f') as Frequency;
  if (!name || name.length > 80 || !Number.isInteger(amountSats) || amountSats < 1 || !FREQUENCIES.includes(frequency)) return undefined;
  return { author: match[1]!, id: decodeURIComponent(match[2]!), name, amountSats, frequency, rail: query.get('r') === 'onchain' ? 'onchain' : undefined };
}

export const isInviteRoute = (route: string) => route.startsWith('/invite/');
