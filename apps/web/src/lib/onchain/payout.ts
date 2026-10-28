import type { VaultRecord } from './vault';

/** How many receiving addresses a wallet hands out to groups before reusing them: a wallet looks this far ahead for coins. */
export const PAYOUT_ADDRESSES = 10;

/**
 * Picks the address for being paid in a group. Each group gets its own, so someone looking at the blockchain
 * can't tell that two groups' payouts belong to one person. A group keeps the address it was given; when all
 * of them are taken, the oldest is shared again.
 */
export function choosePayoutAddress(groupId: string, addresses: string[], taken: Record<string, string>): { address: string; taken: Record<string, string> } {
  const existing = Object.keys(taken).find((a) => taken[a] === groupId && addresses.includes(a));
  if (existing) return { address: existing, taken };
  const free = addresses.find((a) => !taken[a]);
  const address = free ?? addresses[0]!;
  const next = { ...taken };
  if (free) next[free] = groupId;
  return { address, taken: next };
}

const STORAGE_KEY = 'ajo.bitcoin.payouts';
const load = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {}; } catch { return {}; } };

/** The saved wallet's address for this group, remembering the choice. Undefined when there is no wallet. */
export function payoutAddressFor(groupId: string, vault: VaultRecord | undefined): string | undefined {
  const addresses = vault?.addresses?.length ? vault.addresses : vault?.address ? [vault.address] : [];
  if (!addresses.length) return undefined;
  const { address, taken } = choosePayoutAddress(groupId, addresses, load());
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(taken)); } catch { /* the same address is offered again next time */ }
  return address;
}
