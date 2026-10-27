import {
  isFinished, isRoundComplete, openRound, parseInvoice, unpaid, verifyReceipt, deferRecipient,
  type GroupDef, type Receipt, type ReminderStage, type RoundState,
} from '@ajo/core';

export type FetchInvoice = (lightningAddress: string, amountSats: number) => Promise<{ invoice: string }>;

/** Pays one member's invoice from their auto-pay grant and returns the preimage; undefined if they have none. */
export type AutoPay = (member: string, invoice: string) => Promise<string | undefined>;

export type Action =
  | { type: 'invoice-failed'; payer: string; reason: string }
  | { type: 'autopaid'; payer: string }
  | { type: 'answered'; count: number }
  | { type: 'assistant-error'; reason: string }
  | { type: 'autopay-failed'; payer: string; reason: string }
  | { type: 'remind'; members: string[]; deadline: number; round: number; stage: ReminderStage }
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
  /** Pays on behalf of members who opted in. Omit to disable auto-pay. */
  autoPay?: AutoPay;
  now: number;
  /** Seconds past the deadline before a stuck recipient is deferred. */
  graceSeconds?: number;
}

export interface TickResult {
  group: GroupDef;
  state: RoundState;
  actions: Action[];
  /** Receipts for payments the coordinator made; to be published before the round state. */
  autoReceipts: Receipt[];
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
  const autoReceipts: Receipt[] = [];
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

  const accept = (receipt: Receipt): boolean => {
    const { payer } = receipt;
    const invoice = state.invoices[payer];
    if (receipt.round !== state.round || !invoice || state.paid.includes(payer)) return false;
    if (!group.payoutOrder.includes(payer) || payer === state.recipient) return false;
    if (receipt.invoice !== invoice) return false;
    const result = verifyReceipt(receipt, {
      amountSats: group.amountSats,
      recipientPaymentHash: parseInvoice(invoice).paymentHash,
    });
    if (result.ok) state.paid.push(payer);
    return result.ok;
  };

  for (const receipt of receipts) accept(receipt);

  // Members who opted in are paid by the coordinator, but only for an invoice it issued itself
  // and only for exactly the contribution, so a grant can never be spent on anything else.
  if (input.autoPay) {
    for (const payer of unpaid(group, state)) {
      const invoice = state.invoices[payer];
      if (!invoice) continue;
      try {
        if (parseInvoice(invoice).amountMsats !== group.amountSats * 1000) throw new Error('invoice amount does not match the contribution');
        const preimage = await input.autoPay(payer, invoice);
        if (preimage === undefined) continue;
        const receipt: Receipt = { groupId: group.id, round: state.round, payer, recipient: state.recipient, invoice, preimage };
        if (!accept(receipt)) throw new Error('the payment did not produce a valid receipt');
        autoReceipts.push(receipt);
        actions.push({ type: 'autopaid', payer });
      } catch (e) {
        actions.push({ type: 'autopay-failed', payer, reason: (e as Error).message });
      }
    }
  }

  if (isRoundComplete(group, state)) {
    state = { ...state, status: 'complete' };
    actions.push({ type: 'round-complete', round: state.round });
    const next = state.round + 1;
    if (isFinished(group, next)) actions.push({ type: 'cycle-complete' });
    return { group, state, actions, autoReceipts };
  }

  if (now > state.deadline + grace && Object.keys(state.invoices).length === 0) {
    // Nobody could get an invoice from the recipient, so the recipient is the problem.
    actions.push({ type: 'recipient-deferred', recipient: state.recipient, round: state.round });
    const deferred = deferRecipient(group, state.round);
    return { group: deferred, state: openRound(deferred, state.round), actions, autoReceipts };
  }

  // One reminder a day before the deadline and one once it has passed, each sent at most once,
  // and only to members who can pay now (an invoice exists). The stage is recorded in the state.
  const stage: ReminderStage | undefined = now > state.deadline ? 'overdue' : now >= state.deadline - 24 * 3600 ? 'due' : undefined;
  if (stage) {
    const rank: Record<ReminderStage, number> = { due: 1, overdue: 2 };
    const members = unpaid(group, state).filter(
      (m) => state.invoices[m] && rank[stage] > (state.reminders?.[m] ? rank[state.reminders[m]!] : 0),
    );
    if (members.length) {
      state.reminders = { ...state.reminders, ...Object.fromEntries(members.map((m) => [m, stage])) };
      actions.push({ type: 'remind', members, deadline: state.deadline, round: state.round, stage });
    }
  }
  return { group, state, actions, autoReceipts };
}

/** The state of the round after a completed one, or undefined when the cycle is over. */
export function nextRound(group: GroupDef, state: RoundState): RoundState | undefined {
  const next = state.round + 1;
  return isFinished(group, next) ? undefined : openRound(group, next);
}
