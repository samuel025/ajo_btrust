import {
  isFinished, openRound, type GroupDef, type GroupRef, type Receipt, type RoundState,
} from '@ajo/core';
import { nextRound, tick, type Action, type FetchInvoice } from './engine';
import { answerQuestions, sendReminders, type Outbox } from './assistant';
import { templateWriter, type Writer } from './messages';

/** Pays an invoice through a member's wallet connection. */
export type PayInvoice = (nwcUrl: string, invoice: string) => Promise<{ preimage: string }>;

/** Where the coordinator reads and writes the group's signed, encrypted events. */
export interface Ledger extends Outbox {
  /** The group as its organizer published it; undefined if absent or not readable by the bot. */
  group(ref: GroupRef): Promise<GroupDef | undefined>;
  /** Lightning address by member pubkey, from join events. */
  addresses(group: GroupDef): Promise<Record<string, string>>;
  receipts(group: GroupDef): Promise<Receipt[]>;
  /** Wallet connections members granted for auto-pay, by member pubkey. */
  grants(group: GroupDef): Promise<Record<string, string>>;
  /** Publishes a receipt for a payment the coordinator made, signed by the coordinator. */
  publishReceipt(receipt: Receipt): Promise<void>;
  round(group: GroupDef, round: number): Promise<RoundState | undefined>;
  publishRound(state: RoundState): Promise<void>;
}

/**
 * The first round that isn't complete, with the group as it stands then. A deferred recipient
 * changes the payout order, which each round's state records, so later rounds follow it.
 */
async function currentRound(ledger: Ledger, group: GroupDef): Promise<{ state: RoundState; group: GroupDef } | undefined> {
  let effective = group;
  for (let n = 0; !isFinished(group, n); n++) {
    const state = await ledger.round(group, n);
    if (!state) return { state: openRound(effective, n), group: effective };
    if (state.payoutOrder) effective = { ...effective, payoutOrder: state.payoutOrder };
    if (state.status !== 'complete') return { state, group: effective };
  }
  return undefined;
}

export interface RunDeps {
  /** Enables auto-pay for members who granted it. */
  pay?: PayInvoice;
  /**
   * Preimages of invoices already paid by this process. If publishing a receipt fails after a
   * payment, the next run reuses the preimage instead of paying again.
   */
  paid?: Map<string, string>;
  /** Writes reminders and answers; defaults to fixed templates. */
  writer?: Writer;
}

const defaultPaid = new Map<string, string>();

export async function runOnce(
  ledger: Ledger,
  ref: GroupRef,
  fetchInvoice: FetchInvoice,
  now = Math.floor(Date.now() / 1000),
  deps: RunDeps = {},
): Promise<Action[]> {
  const published = await ledger.group(ref);
  if (!published) throw new Error(`group ${ref.id} not found (or not readable by this coordinator)`);
  const current = await currentRound(ledger, published);
  if (!current) return [];

  const input = {
    group: current.group, state: current.state, now, fetchInvoice,
    addresses: await ledger.addresses(published),
    receipts: await ledger.receipts(published),
  };
  const writer = deps.writer ?? templateWriter;
  const grants = deps.pay ? await ledger.grants(published) : {};
  let result = await tick(input);

  // Reminders go out before the state that records them, so a failed send is retried next run.
  await sendReminders(ledger, current.group, result.actions, writer);

  if (deps.pay && result.state.status === 'open' && result.group === current.group) {
    // Invoices must be on the relay before any money moves. If a publish failed after a payment,
    // the next run would otherwise fetch fresh invoices and pay again.
    await ledger.publishRound(result.state);
    const paid = deps.paid ?? defaultPaid;
    const autoPay = async (member: string, invoice: string) => {
      const nwcUrl = grants[member];
      if (!nwcUrl) return undefined;
      const known = paid.get(invoice);
      if (known) return known;
      const { preimage } = await deps.pay!(nwcUrl, invoice);
      paid.set(invoice, preimage);
      return preimage;
    };
    const second = await tick({ ...input, state: result.state, autoPay });
    result = { ...second, actions: [...result.actions, ...second.actions] };
  }

  // The receipt goes out before the round state that depends on it.
  for (const receipt of result.autoReceipts) await ledger.publishReceipt(receipt);
  await ledger.publishRound(result.state);
  if (result.state.status === 'complete') {
    const next = nextRound(result.group, result.state);
    if (next) await ledger.publishRound(next);
  }

  // Questions come last and can never hold up money or the round: a failure is reported, not thrown.
  try {
    const open = result.state.status === 'open' ? result.state : current.state;
    const answered = await answerQuestions(ledger, result.group, open, writer, new Set(Object.keys(grants)));
    if (answered) result.actions.push({ type: 'answered', count: answered });
  } catch (e) {
    result.actions.push({ type: 'assistant-error', reason: (e as Error).message });
  }
  return result.actions;
}
