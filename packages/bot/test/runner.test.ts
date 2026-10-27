import { describe, expect, it } from 'vitest';
import { openRound, type GroupDef, type GroupRef, type RoundState } from '@ajo/core';
import { runOnce, type Ledger } from '../src';

const [a, b] = ['aa', 'bb'].map((s) => s.repeat(32));
const group: GroupDef = {
  id: 'g', name: 'g', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [a, b], startDate: 1_800_000_000, coordinator: 'dd'.repeat(32),
};
const ref: GroupRef = { author: 'ee'.repeat(32), id: 'g' };

function memoryLedger(): Ledger & { rounds: Map<number, RoundState>; groupReads: GroupRef[] } {
  const rounds = new Map<number, RoundState>();
  const groupReads: GroupRef[] = [];
  return {
    rounds, groupReads,
    group: async (r) => { groupReads.push(r); return group; },
    addresses: async () => ({ [a]: 'a@x.com', [b]: 'b@x.com' }),
    receipts: async () => [],
    round: async (_g, n) => rounds.get(n),
    publishRound: async (s) => void rounds.set(s.round, s),
  };
}

describe('runOnce', () => {
  it('opens round 0 and publishes the invoice for the one payer', async () => {
    const ledger = memoryLedger();
    const calls: string[] = [];
    await runOnce(ledger, ref, async (address) => { calls.push(address); return { invoice: 'lnbc-fake' }; }, group.startDate - 86_400 * 3);
    expect(calls).toEqual(['a@x.com']);
    expect(ledger.rounds.get(0)).toMatchObject({ recipient: a, status: 'open', invoices: { [b]: 'lnbc-fake' } });
    expect(ledger.groupReads).toEqual([ref]);
  });

  it('records the new payout order in the round state when a recipient is deferred', async () => {
    const ledger = memoryLedger();
    const actions = await runOnce(ledger, ref, async () => { throw new Error('offline'); }, group.startDate + 3 * 86_400);
    expect(actions.map((x) => x.type)).toContain('recipient-deferred');
    expect(ledger.rounds.get(0)).toEqual(openRound({ ...group, payoutOrder: [b, a] }, 0));
  });

  it('keeps following the deferred order in later rounds', async () => {
    const ledger = memoryLedger();
    ledger.rounds.set(0, { ...openRound({ ...group, payoutOrder: [b, a] }, 0), status: 'complete' });
    await runOnce(ledger, ref, async () => ({ invoice: 'lnbc-fake' }), group.startDate + 3 * 86_400);
    expect(ledger.rounds.get(1)).toMatchObject({ recipient: a, payoutOrder: [b, a] });
  });

  it('refuses a group it cannot read', async () => {
    const ledger = { ...memoryLedger(), group: async () => undefined };
    await expect(runOnce(ledger, ref, async () => ({ invoice: 'x' }))).rejects.toThrow(/not found/);
  });
});
