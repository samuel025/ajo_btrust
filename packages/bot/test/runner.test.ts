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
    languages: async () => ({}),
    questions: async () => [],
    publishNotice: async () => undefined,
    publishAnswer: async () => undefined,
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

  it('does nothing for a group that is still forming, or has fewer than two members', async () => {
    for (const unready of [{ ...group, forming: true }, { ...group, payoutOrder: [a] }]) {
      const ledger = memoryLedger();
      ledger.group = async () => unready;
      const fetched: string[] = [];
      expect(await runOnce(ledger, ref, async (address) => { fetched.push(address); return { invoice: 'x' }; })).toEqual([]);
      expect(fetched).toEqual([]);
      expect(ledger.rounds.size).toBe(0);
    }
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
      const pay = async (nwcUrl: string, inv: string) => { payments.push(`${nwcUrl}|${inv === invoice}`); ledger.events.push('pay'); return { preimage }; };
      const paid = new Map<string, string>();
      const run = () => runOnce(ledger, ref, async () => ({ invoice }), group.startDate - 86_400, { pay, paid });

      await run();
      expect(payments).toEqual(['nostr+walletconnect://grant|true']);
      // the invoice is published before any money moves, then the receipt, then the round
      expect(ledger.events.slice(0, 5)).toEqual(['round:0:open', 'pay', `receipt:${b}`, 'round:0:complete', 'round:1:open']);

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

  describe('assistant', () => {
    it('sends reminders before publishing the state that records them', async () => {
      const ledger = memoryLedger();
      const order: string[] = [];
      ledger.publishNotice = async (_g, n) => void order.push(`notice:${n.member === b ? 'b' : 'x'}`);
      const publish = ledger.publishRound;
      ledger.publishRound = async (s) => { order.push(`round:${s.round}`); return publish(s); };
      await runOnce(ledger, ref, async () => ({ invoice: 'lnbc-fake' }), group.startDate - 3600);
      expect(order).toEqual(['notice:b', 'round:0']);
      expect(ledger.rounds.get(0)?.reminders).toEqual({ [b]: 'due' });
    });

    it('never lets a failing assistant block the round', async () => {
      const ledger = memoryLedger();
      ledger.questions = async () => { throw new Error('relay hiccup'); };
      const actions = await runOnce(ledger, ref, async () => ({ invoice: 'lnbc-fake' }), group.startDate - 86_400 * 3);
      expect(actions).toContainEqual({ type: 'assistant-error', reason: 'relay hiccup' });
      expect(ledger.rounds.get(0)?.status).toBe('open');
    });

    it('answers questions after the round is published', async () => {
      const ledger = memoryLedger();
      const events: string[] = [];
      ledger.questions = async () => [{ id: 'q1', member: b, text: 'who has paid?', at: 1 }];
      ledger.publishAnswer = async () => void events.push('answer');
      const publish = ledger.publishRound;
      ledger.publishRound = async (s) => { events.push('round'); return publish(s); };
      const actions = await runOnce(ledger, ref, async () => ({ invoice: 'lnbc-fake' }), group.startDate - 86_400 * 3);
      expect(events).toEqual(['round', 'answer']);
      expect(actions).toContainEqual({ type: 'answered', count: 1 });
    });
  });

  describe('the rhythm of the period', () => {
    const DAY = 86_400;
    const preimage = '22'.repeat(32);
    const started = { ...group, startedAt: group.startDate - 4 * DAY };

    async function setup() {
      const { default: bolt11 } = await import('bolt11');
      const { sha256 } = await import('@noble/hashes/sha256');
      const { bytesToHex, hexToBytes, randomBytes } = await import('@noble/hashes/utils');
      const nodeKey = bytesToHex(randomBytes(32));
      const fetches: string[] = [];
      const fetchInvoice = async (address: string) => {
        fetches.push(address);
        const encoded = bolt11.encode({
          satoshis: 1000, timestamp: 1_800_000_000,
          tags: [
            { tagName: 'payment_hash', data: bytesToHex(sha256(hexToBytes(preimage))) },
            { tagName: 'description', data: 'ajo' },
            { tagName: 'payment_secret', data: bytesToHex(randomBytes(32)) },
          ],
        });
        return { invoice: bolt11.sign(encoded, nodeKey).paymentRequest!, verifyUrl: 'https://wallet.example/verify' };
      };
      const ledger = memoryLedger();
      ledger.group = async () => started;
      let writes = 0;
      const publish = ledger.publishRound;
      ledger.publishRound = async (s) => { writes++; return publish(s); };
      let paid = false;
      const deps = { checkPayment: async () => (paid ? { settled: true, preimage } : { settled: false }) };
      const run = (now: number) => runOnce(ledger, ref, fetchInvoice, now, deps);
      return { ledger, fetches, run, pay: () => { paid = true; }, writes: () => writes };
    }

    it('lets a round that was paid early wait for the next period before opening the next one', async () => {
      const t = await setup();
      await t.run(started.startedAt + 60); // round 1 opens with the group
      expect(t.fetches).toEqual(['a@x.com']); // one invoice, fetched from round 1's recipient

      t.pay(); // everyone pays on day one, days before the due date
      await t.run(started.startedAt + 120);
      expect(t.ledger.rounds.get(0)?.status).toBe('complete');
      expect(t.ledger.rounds.get(1)).toMatchObject({ status: 'open', invoices: {}, opensAt: started.startDate });
      expect(t.fetches).toHaveLength(1); // no invoice for round 2 yet

      // days of waiting: nothing is issued, and nothing is republished while it waits
      const writesBefore = t.writes();
      for (const now of [started.startedAt + 3600, started.startDate - 3 * DAY, started.startDate - 60]) await t.run(now);
      expect(t.fetches).toHaveLength(1);
      expect(t.writes()).toBe(writesBefore);

      // the due date arrives: round 2 opens and its invoices are issued
      await t.run(started.startDate + 60);
      expect(t.fetches).toEqual(['a@x.com', 'b@x.com']);
      expect(Object.keys(t.ledger.rounds.get(1)!.invoices)).toHaveLength(1);
    });

    it('opens the next round straight away when the previous one was paid late', async () => {
      const t = await setup();
      await t.run(started.startDate + 3600); // already past round 1's due date, invoices issued
      t.pay();
      await t.run(started.startDate + 7200);
      expect(t.ledger.rounds.get(0)?.status).toBe('complete');
      await t.run(started.startDate + 7260);
      expect(t.fetches).toHaveLength(2); // round 2's invoice, with no further wait: its opening time has passed
    });

    it('still answers questions while a round is waiting to open', async () => {
      const t = await setup();
      t.pay();
      await t.run(started.startedAt + 60);
      await t.run(started.startedAt + 120); // round 1 complete, round 2 now upcoming
      const answered: string[] = [];
      t.ledger.questions = async () => [{ id: 'q1', member: b, text: 'when do I pay?', at: 1 }];
      t.ledger.publishAnswer = async (_g, q) => void answered.push(q.id);
      const actions = await t.run(started.startedAt + 3600);
      expect(answered).toEqual(['q1']);
      expect(actions).toContainEqual({ type: 'answered', count: 1 });
    });
  });
});

