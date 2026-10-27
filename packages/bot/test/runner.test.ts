import { describe, expect, it } from 'vitest';
import { openRound, type GroupDef, type GroupRef, type RoundState } from '@ajo/core';
import { runOnce, type Ledger } from '../src';

const [a, b] = ['aa', 'bb'].map((s) => s.repeat(32));
const group: GroupDef = {
  id: 'g', name: 'g', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [a, b], startDate: 1_800_000_000, coordinator: 'dd'.repeat(32),
};
const ref: GroupRef = { author: 'ee'.repeat(32), id: 'g' };

function memoryLedger(grants: Record<string, string> = {}): Ledger & { rounds: Map<number, RoundState>; groupReads: GroupRef[]; events: string[] } {
  const rounds = new Map<number, RoundState>();
  const groupReads: GroupRef[] = [];
  const events: string[] = [];
  return {
    rounds, groupReads, events,
    group: async (r) => { groupReads.push(r); return group; },
    addresses: async () => ({ [a]: 'a@x.com', [b]: 'b@x.com' }),
    receipts: async () => [],
    grants: async () => grants,
    publishReceipt: async (r) => void events.push(`receipt:${r.payer}`),
    round: async (_g, n) => rounds.get(n),
    publishRound: async (s) => { events.push(`round:${s.round}:${s.status}`); rounds.set(s.round, s); },
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

  describe('auto-pay', () => {
    const preimage = '11'.repeat(32);
    // a real invoice is needed for amount and preimage checks
    const invoiceFor = async () => {
      const { default: bolt11 } = await import('bolt11');
      const { sha256 } = await import('@noble/hashes/sha256');
      const { bytesToHex, hexToBytes, randomBytes } = await import('@noble/hashes/utils');
      const encoded = bolt11.encode({
        satoshis: 1000, timestamp: 1_800_000_000,
        tags: [
          { tagName: 'payment_hash', data: bytesToHex(sha256(hexToBytes(preimage))) },
          { tagName: 'description', data: 'ajo' },
          { tagName: 'payment_secret', data: bytesToHex(randomBytes(32)) },
        ],
      });
      return bolt11.sign(encoded, bytesToHex(randomBytes(32))).paymentRequest!;
    };

    it('pays once with the grant, publishes the receipt before the round, and never pays twice', async () => {
      const invoice = await invoiceFor();
      const ledger = memoryLedger({ [b]: 'nostr+walletconnect://grant' });
      const payments: string[] = [];
      const pay = async (nwcUrl: string, inv: string) => { payments.push(`${nwcUrl}|${inv === invoice}`); return { preimage }; };
      const paid = new Map<string, string>();
      const run = () => runOnce(ledger, ref, async () => ({ invoice }), group.startDate - 86_400, { pay, paid });

      await run();
      expect(payments).toEqual(['nostr+walletconnect://grant|true']);
      expect(ledger.events.slice(0, 3)).toEqual([`receipt:${b}`, 'round:0:complete', 'round:1:open']);

      // a second pass over the same invoice (e.g. after a failed publish) reuses the preimage
      ledger.rounds.delete(0); ledger.events.length = 0;
      await run();
      expect(payments).toHaveLength(1);
    });

    it('does nothing for members without a grant, or when auto-pay is off', async () => {
      const invoice = await invoiceFor();
      let calls = 0;
      const pay = async () => { calls++; return { preimage }; };
      await runOnce(memoryLedger({}), ref, async () => ({ invoice }), group.startDate - 86_400, { pay, paid: new Map() });
      await runOnce(memoryLedger({ [b]: 'nostr+walletconnect://grant' }), ref, async () => ({ invoice }), group.startDate - 86_400, { paid: new Map() });
      expect(calls).toBe(0);
    });
  });
});

