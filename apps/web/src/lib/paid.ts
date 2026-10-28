/**
 * A payment this browser has made for a round, remembered the moment the wallet says it went through, so that a
 * failure afterwards (sending the proof to the group, a reload, a slow relay) can never lead to paying twice.
 */
export interface PaidRecord { invoice: string; preimage: string }

const key = (groupId: string, round: number, payer: string) => `ajo.paid.${groupId}.${round}.${payer}`;

export function rememberPaid(groupId: string, round: number, payer: string, record: PaidRecord) {
  try { localStorage.setItem(key(groupId, round, payer), JSON.stringify(record)); } catch { /* the page still shows it as paid for now */ }
}

export function recallPaid(groupId: string, round: number, payer: string): PaidRecord | undefined {
  try {
    const record = JSON.parse(localStorage.getItem(key(groupId, round, payer)) ?? 'null') as PaidRecord | null;
    return record && typeof record.invoice === 'string' && typeof record.preimage === 'string' ? record : undefined;
  } catch { return undefined; }
}
