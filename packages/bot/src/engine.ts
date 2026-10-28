import {
  isFinished, isRoundComplete, isUpcoming, needsRefresh, openRound, parseInvoice, unpaid, verifyReceipt, deferRecipient,
  type GroupDef, type Receipt, type ReminderStage, type RoundState,
} from '@ajo/core';

export type FetchInvoice = (lightningAddress: string, amountSats: number) => Promise<{ invoice: string; verifyUrl?: string }>;

/** Asks the recipient's wallet provider whether an invoice was paid (LNURL-pay verify). */
export type CheckPayment = (verifyUrl: string) => Promise<{ settled: boolean; preimage?: string }>;

/** Pays one member's invoice from their auto-pay grant and returns the preimage; undefined if they have none. */
export type AutoPay = (member: string, invoice: string) => Promise<string | undefined>;

export type Action =
  | { type: 'invoice-failed'; payer: string; reason: string }
  | { type: 'invoice-refreshed'; payer: string }
  | { type: 'autopaid'; payer: string }
  | { type: 'payment-detected'; payer: string }
  | { type: 'verify-failed'; payer: string; reason: string }
  | { type: 'defaulted'; members: string[]; round: number }
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
  /** Lets the coordinator see for itself that an invoice was paid, so members can pay from any wallet. */
  checkPayment?: CheckPayment;
  /** Pays on behalf of members who opted in. Omit to disable auto-pay. */
  autoPay?: AutoPay;
  now: number;
  /** Seconds past the deadline before a stuck recipient is deferred. */
  graceSeconds?: number;
  /** Seconds past the deadline after which members who still haven't paid are marked as defaulted. */
  defaultAfterSeconds?: number;
}

export interface TickResult {
  group: GroupDef;
  state: RoundState;
  actions: Action[];
  /** Receipts for payments the coordinator made; to be published before the round state. */
  autoReceipts: Receipt[];
}

export const DEFAULT_GRACE_SECONDS = 48 * 3600;
/** How many replaced invoices are remembered per payer, so a late payment on an old one still counts. */
const MAX_SUPERSEDED = 10;
export const DEFAULT_AFTER_SECONDS = 7 * 86_400;

/**
 * One coordinator step for the current round: issue invoices, count valid receipts,
 * then close the round, defer the recipient or leave it open. Pure apart from `fetchInvoice`.
 */
export async function tick(input: TickInput): Promise<TickResult> {
  const { group, receipts, now } = input;

  // A round that hasn't opened yet is only announced: no invoices, payments or reminders until then.
  // This is what keeps a cycle to the rhythm of its period instead of running as fast as people pay.
  if (isUpcoming(input.state, now)) return { group, state: input.state, actions: [], autoReceipts: [] };
  const grace = input.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const actions: Action[] = [];
  const autoReceipts: Receipt[] = [];
  let state: RoundState = {
    ...input.state,
    invoices: { ...input.state.invoices },
    paid: [...input.state.paid],
    paidAt: { ...input.state.paidAt },
  };

  /** Every invoice a payer could have paid this round: the current one and any replaced ones. */
  const invoicesOf = (payer: string) => [state.invoices[payer], ...(state.superseded?.[payer] ?? []).map((o) => o.invoice)].filter((i): i is string => !!i);

  const accept = (receipt: Receipt): boolean => {
    const { payer, invoice } = receipt;
    if (receipt.round !== state.round || state.paid.includes(payer)) return false;
    if (!group.payoutOrder.includes(payer) || payer === state.recipient) return false;
    if (!invoicesOf(payer).includes(invoice)) return false;
    const result = verifyReceipt(receipt, {
      amountSats: group.amountSats,
      recipientPaymentHash: parseInvoice(invoice).paymentHash,
    });
    if (result.ok) {
      state.paid.push(payer);
      state.paidAt = { ...state.paidAt, [payer]: now };
    }
    return result.ok;
  };

  for (const receipt of receipts) accept(receipt);

  // Members can pay from any wallet: if the recipient's provider offers a verify link, the
  // coordinator checks it and takes the preimage from there. It still verifies the preimage against
  // the invoice, so a provider's say-so alone proves nothing. This runs before auto-pay so an
  // invoice that was already paid by hand is never paid a second time.
  if (input.checkPayment) {
    for (const payer of unpaid(group, state)) {
      const links = [
        { invoice: state.invoices[payer], url: state.verify?.[payer] },
        ...(state.superseded?.[payer] ?? []).map((o) => ({ invoice: o.invoice, url: o.verify })),
      ];
      for (const { invoice, url } of links) {
        if (!url || !invoice || state.paid.includes(payer)) continue;
        try {
          const status = await input.checkPayment(url);
          if (!status.settled) continue;
          if (!status.preimage) throw new Error('the provider says it was paid but gave no proof');
          const receipt: Receipt = { groupId: group.id, round: state.round, payer, recipient: state.recipient, invoice, preimage: status.preimage };
          if (!accept(receipt)) throw new Error('the provider reported a payment whose proof does not check out');
          autoReceipts.push(receipt);
          actions.push({ type: 'payment-detected', payer });
        } catch (e) {
          actions.push({ type: 'verify-failed', payer, reason: (e as Error).message });
        }
      }
    }
  }

  // Give each payer who has no invoice one, and replace an invoice that is about to expire. A round lasts
  // a whole period but an invoice only a day or an hour, so without this a member who pays late would be
  // handed a dead invoice. The old one is kept: a payment made on it before it expired still counts.
  const recipientAddress = input.addresses[state.recipient];
  for (const payer of unpaid(group, state)) {
    const current = state.invoices[payer];
    if (current && !needsRefresh(current, now)) continue;
    try {
      if (!recipientAddress) throw new Error('recipient has no Lightning address');
      const fetched = await input.fetchInvoice(recipientAddress, group.amountSats);
      if (current) {
        if (fetched.invoice === current) continue;
        const old = { invoice: current, verify: state.verify?.[payer] };
        state.superseded = { ...state.superseded, [payer]: [...(state.superseded?.[payer] ?? []), old].slice(-MAX_SUPERSEDED) };
        actions.push({ type: 'invoice-refreshed', payer });
      }
      state.invoices[payer] = fetched.invoice;
      if (fetched.verifyUrl) state.verify = { ...state.verify, [payer]: fetched.verifyUrl };
      else if (state.verify?.[payer]) { const { [payer]: _gone, ...rest } = state.verify; state.verify = rest; }
    } catch (e) {
      actions.push({ type: 'invoice-failed', payer, reason: (e as Error).message });
    }
  }

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

  // Someone who had an invoice and still hasn't paid a week after the deadline is recorded as having
  // defaulted, and the round closes without them so the circle can go on. The recipient is short by
  // their contribution; the record is the deterrent. Members with no invoice aren't at fault, and
  // nobody is blamed unless another member's payment got through, which shows the recipient was
  // reachable (otherwise an offline recipient would make every payer look like a defaulter).
  if (state.paid.length > 0 && now > state.deadline + (input.defaultAfterSeconds ?? DEFAULT_AFTER_SECONDS)) {
    const defaulting = unpaid(group, state).filter((m) => state.invoices[m]);
    if (defaulting.length) {
      state.defaulted = [...(state.defaulted ?? []), ...defaulting];
      actions.push({ type: 'defaulted', members: defaulting, round: state.round });
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
