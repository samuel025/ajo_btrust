import {
  isFinished, openRound, type GroupDef, type GroupRef, type Receipt, type RoundState,
} from '@ajo/core';
import { nextRound, tick, type Action, type FetchInvoice } from './engine';

/** Where the coordinator reads and writes the group's signed, encrypted events. */
export interface Ledger {
  /** The group as its organizer published it; undefined if absent or not readable by the bot. */
  group(ref: GroupRef): Promise<GroupDef | undefined>;
  /** Lightning address by member pubkey, from join events. */
  addresses(group: GroupDef): Promise<Record<string, string>>;
  receipts(group: GroupDef): Promise<Receipt[]>;
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

export async function runOnce(
  ledger: Ledger,
  ref: GroupRef,
  fetchInvoice: FetchInvoice,
  now = Math.floor(Date.now() / 1000),
): Promise<Action[]> {
  const published = await ledger.group(ref);
  if (!published) throw new Error(`group ${ref.id} not found (or not readable by this coordinator)`);
  const current = await currentRound(ledger, published);
  if (!current) return [];

  const result = await tick({
    group: current.group, state: current.state, now, fetchInvoice,
    addresses: await ledger.addresses(published),
    receipts: await ledger.receipts(published),
  });

  await ledger.publishRound(result.state);
  if (result.state.status === 'complete') {
    const next = nextRound(result.group, result.state);
    if (next) await ledger.publishRound(next);
  }
  return result.actions;
}
