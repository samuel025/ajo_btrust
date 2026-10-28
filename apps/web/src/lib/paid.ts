/**
 * A payment this browser has made for a round, remembered the moment the wallet says it went through, so that a
 * failure afterwards (sending the proof to the group, a reload, a slow relay) can never lead to paying twice.
 */
/** `preimage` is missing when the wallet said it paid but gave no proof. */
export interface PaidRecord { invoice: string; preimage?: string }

const key = (groupId: string, round: number, payer: string) => `ajo.paid.${groupId}.${round}.${payer}`;

export function rememberPaid(groupId: string, round: number, payer: string, record: PaidRecord) {
  try { localStorage.setItem(key(groupId, round, payer), JSON.stringify(record)); } catch { /* the page still shows it as paid for now */ }
}

export function recallPaid(groupId: string, round: number, payer: string): PaidRecord | undefined {
  try {
    const record = JSON.parse(localStorage.getItem(key(groupId, round, payer)) ?? 'null') as PaidRecord | null;
    return record && typeof record.invoice === 'string' && (record.preimage === undefined || typeof record.preimage === 'string') ? record : undefined;
  } catch { return undefined; }
}

/*
 * A payment that was started but whose outcome we don't know (the wallet window was closed, it timed out, the page was
 * reloaded). Until the person says otherwise, the page must not offer to pay again: that could pay twice.
 */
const attemptKey = (groupId: string, round: number, payer: string) => `ajo.attempt.${groupId}.${round}.${payer}`;

export function markAttempt(groupId: string, round: number, payer: string) {
  try { localStorage.setItem(attemptKey(groupId, round, payer), String(Date.now())); } catch { /* the page stays locked for this visit */ }
}
export function hasAttempt(groupId: string, round: number, payer: string): boolean {
  try { return localStorage.getItem(attemptKey(groupId, round, payer)) !== null; } catch { return false; }
}
export function clearAttempt(groupId: string, round: number, payer: string) {
  try { localStorage.removeItem(attemptKey(groupId, round, payer)); } catch { /* nothing to clear */ }
}
