import type { GroupRef, Language } from '@ajo/core';

/** What a person entered when asking to join, kept so joining finishes by itself once they're approved. */
export interface PendingJoin { lightningAddress: string; bitcoinAddress?: string; language: Language }

const key = (ref: GroupRef) => `ajo.pending.${ref.author}.${ref.id}`;

export function savePending(ref: GroupRef, pending: PendingJoin) {
  try { localStorage.setItem(key(ref), JSON.stringify(pending)); } catch { /* the join form is shown again if this is lost */ }
}

export function loadPending(ref: GroupRef): PendingJoin | undefined {
  try { return JSON.parse(localStorage.getItem(key(ref)) ?? 'null') ?? undefined; } catch { return undefined; }
}

export function clearPending(ref: GroupRef) {
  try { localStorage.removeItem(key(ref)); } catch { /* nothing to clear */ }
}
