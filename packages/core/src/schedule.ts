import type { Frequency, GroupDef, RoundState } from './types';

const DAY = 86_400;

function addPeriods(start: number, frequency: Frequency, n: number): number {
  if (frequency === 'testing') return start + n * 600;
  if (frequency === 'weekly') return start + n * 7 * DAY;
  if (frequency === 'biweekly') return start + n * 14 * DAY;
  const d = new Date(start * 1000);
  d.setUTCMonth(d.getUTCMonth() + n);
  return Math.floor(d.getTime() / 1000);
}

export function roundCount(group: GroupDef): number {
  return group.payoutOrder.length;
}

export function isFinished(group: GroupDef, round: number): boolean {
  return round >= roundCount(group);
}

export function roundDeadline(group: GroupDef, round: number): number {
  return addPeriods(group.startDate, group.frequency, round);
}

/**
 * When members can start paying a round. Round 1 opens when the organizer starts the group; every
 * later round opens when the previous one falls due, so a cycle keeps the rhythm of its period even
 * if everyone pays early. A group with no start time (older groups) opens at once.
 */
export function roundOpensAt(group: GroupDef, round: number): number {
  return round === 0 ? (group.startedAt ?? 0) : roundDeadline(group, round - 1);
}

/** True while a round is announced but members can't pay it yet. */
export function isUpcoming(state: RoundState, now: number): boolean {
  return now < (state.opensAt ?? 0);
}

export function recipientForRound(group: GroupDef, round: number): string {
  const recipient = group.payoutOrder[round];
  if (recipient === undefined) throw new Error(`round ${round} is past the end of the cycle`);
  return recipient;
}

export function openRound(group: GroupDef, round: number): RoundState {
  return {
    groupId: group.id,
    round,
    recipient: recipientForRound(group, round),
    deadline: roundDeadline(group, round),
    opensAt: roundOpensAt(group, round),
    paid: [],
    invoices: {},
    payoutOrder: group.payoutOrder,
    status: 'open',
  };
}

/** Members who still owe a payment this round: not the recipient, not paid, not already marked as defaulted. */
export function unpaid(group: GroupDef, state: RoundState): string[] {
  return group.payoutOrder.filter((m) => m !== state.recipient && !state.paid.includes(m) && !state.defaulted?.includes(m));
}

export function isRoundComplete(group: GroupDef, state: RoundState): boolean {
  return unpaid(group, state).length === 0;
}

/**
 * Moves the current round's recipient to the end of the order, for a recipient
 * who can't receive. Earlier rounds are untouched.
 */
export function deferRecipient(group: GroupDef, round: number): GroupDef {
  const order = [...group.payoutOrder];
  const [skipped] = order.splice(round, 1);
  if (skipped === undefined) throw new Error(`round ${round} is past the end of the cycle`);
  order.push(skipped);
  return { ...group, payoutOrder: order };
}

/** The group with the payout order of the latest round, which reflects any deferred recipients. */
export function effectiveGroup(group: GroupDef, rounds: Map<number, RoundState>): GroupDef {
  const latest = [...rounds.values()].sort((a, b) => b.round - a.round)[0];
  return latest?.payoutOrder ? { ...group, payoutOrder: latest.payoutOrder } : group;
}
