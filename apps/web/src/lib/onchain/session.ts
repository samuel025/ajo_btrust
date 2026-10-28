import { useSyncExternalStore } from 'react';
import type { Account } from './keys';

/**
 * The unlocked wallet, held in memory only. Unlocking it once on the Wallet page lets a group page pay
 * from it without asking again; reloading the page or locking it forgets the keys.
 */
let unlocked: Account | undefined;
const listeners = new Set<() => void>();

export function setUnlocked(account: Account | undefined) {
  unlocked = account;
  listeners.forEach((l) => l());
}

export const useUnlocked = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => unlocked);
