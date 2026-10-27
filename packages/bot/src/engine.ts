import {
  isFinished, isRoundComplete, openRound, parseInvoice, unpaid, verifyReceipt, deferRecipient,
  type GroupDef, type Receipt, type RoundState,
} from '@ajo/core';

export type FetchInvoice = (lightningAddress: string, amountSats: number) => Promise<{ invoice: string }>;

export type Action =
  | { type: 'invoice-failed'; payer: string; reason: string }
  | { type: 'remind'; members: string[]; deadline: number }
  | { type: 'round-complete'; round: number }
  | { type: 'cycle-complete' }
  | { type: 'recipient-deferred'; recipient: string; round: number };

export interface TickInput {
  group: GroupDef;
  state: RoundState;
  /** Lightning address by member pubkey, from their join events. */
  addresses: Record<string, string>;
  /** Every receipt seen for this group; the engine picks out the ones for this round. */
  receipts: Receipt[];
  fetchInvoice: FetchInvoice;
  now: number;
  /** Seconds past the deadline before a stuck recipient is deferred. */
  graceSeconds?: number;
}

export interface TickResult {
  group: GroupDef;
  state: RoundState;
  actions: Action[];
}

export const DEFAULT_GRACE_SECONDS = 48 * 3600;

/**
 * One coordinator step for the current round: issue invoices, count valid receipts,
 * then close the round, defer the recipient or leave it open. Pure apart from `fetchInvoice`.
 */
export async function tick(input: TickInput): Promise<TickResult> {
  const { group, receipts, now } = input;
  const grace = input.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const actions: Action[] = [];
  let state: RoundState = { ...input.state, invoices: { ...input.state.invoices }, paid: [...input.state.paid] };

  const recipientAddress = input.addresses[state.recipient];
  for (const payer of unpaid(group, state)) {
    if (state.invoices[payer]) continue;
    try {
      if (!recipientAddress) throw new Error('recipient has no Lightning address');
      state.invoices[payer] = (await input.fetchInvoice(recipientAddress, group.amountSats)).invoice;
    } catch (e) {
      actions.push({ type: 'invoice-failed', payer, reason: (e as Error).message });
    }
  }

  for (const receipt of receipts) {
    const { payer } = receipt;
    const invoice = state.invoices[payer];
    if (receipt.round !== state.round || !invoice || state.paid.includes(payer)) continue;
    if (!group.payoutOrder.includes(payer) || payer === state.recipient) continue;
    if (receipt.invoice !== invoice) continue;
    const result = verifyReceipt(receipt, {
      amountSats: group.amountSats,
      recipientPaymentHash: parseInvoice(invoice).paymentHash,
    });
    if (result.ok) state.paid.push(payer);
  }

  if (isRoundComplete(group, state)) {
    state = { ...state, status: 'complete' };
    actions.push({ type: 'round-complete', round: state.round });
    const next = state.round + 1;
    if (isFinished(group, next)) actions.push({ type: 'cycle-complete' });
    return { group, state, actions };
  }

  if (now > state.deadline + grace && Object.keys(state.invoices).length === 0) {
    // Nobody could get an invoice from the recipient, so the recipient is the problem.
    actions.push({ type: 'recipient-deferred', recipient: state.recipient, round: state.round });
    const deferred = deferRecipient(group, state.round);
    return { group: deferred, state: openRound(deferred, state.round), actions };
  }

  if (now >= state.deadline - 24 * 3600) {
    actions.push({ type: 'remind', members: unpaid(group, state), deadline: state.deadline });
  }
  return { group, state, actions };
}

/** The state of the round after a completed one, or undefined when the cycle is over. */
export function nextRound(group: GroupDef, state: RoundState): RoundState | undefined {
  const next = state.round + 1;
  return isFinished(group, next) ? undefined : openRound(group, next);
}
