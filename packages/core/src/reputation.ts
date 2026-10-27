import type { GroupDef, RoundState } from './types';

export interface Standing {
  /** Finished rounds in which this member owed a contribution. */
  owed: number;
  onTime: number;
  late: number;
  defaulted: number;
  /** Finished rounds in which this member was the recipient. */
  received: number;
  /** Received a payout and then defaulted in a later round: the failure an ajo is most exposed to. */
  collectedAndLeft: boolean;
}

/** A payment counts as on time up to this long after the deadline, so a coordinator outage can't make someone late. */
export const ON_TIME_SLACK_SECONDS = 3600;

/** Each member's record from the rounds that have finished. Open rounds don't count yet. */
export function standings(group: GroupDef, rounds: RoundState[], slack = ON_TIME_SLACK_SECONDS): Record<string, Standing> {
  const out: Record<string, Standing> = {};
  for (const member of group.payoutOrder) out[member] = { owed: 0, onTime: 0, late: 0, defaulted: 0, received: 0, collectedAndLeft: false };

  const finished = rounds.filter((r) => r.status === 'complete').sort((a, b) => a.round - b.round);
  const receivedAt = new Map<string, number>();
  for (const state of finished) {
    const recipient = out[state.recipient];
    if (recipient) {
      recipient.received++;
      if (!receivedAt.has(state.recipient)) receivedAt.set(state.recipient, state.round);
    }
    for (const member of group.payoutOrder) {
      if (member === state.recipient) continue;
      const standing = out[member]!;
      standing.owed++;
      if (state.defaulted?.includes(member)) {
        standing.defaulted++;
        const got = receivedAt.get(member);
        if (got !== undefined && got < state.round) standing.collectedAndLeft = true;
      } else if ((state.paidAt?.[member] ?? 0) > state.deadline + slack) {
        standing.late++;
      } else {
        standing.onTime++;
      }
    }
  }
  return out;
}
