import { describe, expect, it } from 'vitest';
import bolt11 from 'bolt11';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { openRound, type GroupDef, type Receipt } from '@ajo/core';
import { nextRound, tick, type FetchInvoice } from '../src';

const nodeKey = bytesToHex(randomBytes(32));
const preimages = new Map<string, string>(); // invoice -> preimage

const fetchInvoice: FetchInvoice = async (_addr, amountSats) => {
  const preimage = bytesToHex(randomBytes(32));
  const encoded = bolt11.encode({
    satoshis: amountSats, timestamp: 1_800_000_000,
    tags: [
      { tagName: 'payment_hash', data: bytesToHex(sha256(hexToBytes(preimage))) },
      { tagName: 'expire_time', data: 315_360_000 }, { tagName: 'description', data: 'ajo' },
      { tagName: 'payment_secret', data: bytesToHex(randomBytes(32)) },
    ],
  });
  const invoice = bolt11.sign(encoded, nodeKey).paymentRequest!;
  preimages.set(invoice, preimage);
  return { invoice };
};

const [a, b, c] = ['aa', 'bb', 'cc'].map((s) => s.repeat(32));
const group: GroupDef = {
  id: 'g', name: 'g', amountSats: 1000, frequency: 'weekly',
  payoutOrder: [a, b, c], startDate: 1_800_000_000, coordinator: 'dd'.repeat(32),
};
const addresses = { [a]: 'a@x.com', [b]: 'b@x.com', [c]: 'c@x.com' };
const receiptFor = (payer: string, invoice: string, round = 0): Receipt =>
  ({ groupId: 'g', round, payer, recipient: a, invoice, preimage: preimages.get(invoice)! });

describe('tick', () => {
  it('issues one invoice per payer and does not re-issue them', async () => {
    const first = await tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice, now: group.startDate - 7 * 86_400 });
    expect(Object.keys(first.state.invoices).sort()).toEqual([b, c]);
    const second = await tick({ group, state: first.state, addresses, receipts: [], fetchInvoice, now: group.startDate - 7 * 86_400 });
    expect(second.state.invoices).toEqual(first.state.invoices);
  });

  it('closes the round once every payer has a valid receipt, then opens the next', async () => {
    const issued = await tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice, now: group.startDate - 5 * 86_400 });
    const { invoices } = issued.state;
    const one = await tick({ group, state: issued.state, addresses, receipts: [receiptFor(b, invoices[b]!)], fetchInvoice, now: group.startDate - 1 });
    expect(one.state.paid).toEqual([b]);
    expect(one.actions).toContainEqual({ type: 'remind', members: [c], deadline: group.startDate, round: 0, stage: 'due' });

    const done = await tick({ group, state: one.state, addresses, receipts: [receiptFor(b, invoices[b]!), receiptFor(c, invoices[c]!)], fetchInvoice, now: group.startDate });
    expect(done.state.status).toBe('complete');
    expect(nextRound(group, done.state)).toMatchObject({ round: 1, recipient: b });
  });

  it('ignores receipts for an invoice the bot did not issue, or with a bad preimage', async () => {
    const issued = await tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice, now: group.startDate - 5 * 86_400 });
    const foreign = (await fetchInvoice('x@x.com', 1000)).invoice;
    const forged = { ...receiptFor(b, issued.state.invoices[b]!), preimage: '00'.repeat(32) };
    const result = await tick({ group, state: issued.state, addresses, receipts: [receiptFor(b, foreign), forged], fetchInvoice, now: group.startDate - 5 * 86_400 });
    expect(result.state.paid).toEqual([]);
  });

  it('defers a recipient nobody can get an invoice from, after the grace period', async () => {
    const broken: FetchInvoice = async () => { throw new Error('node offline'); };
    const late = group.startDate + 49 * 3600;
    const result = await tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice: broken, now: late });
    expect(result.actions).toContainEqual({ type: 'recipient-deferred', recipient: a, round: 0 });
    expect(result.group.payoutOrder).toEqual([b, c, a]);
    expect(result.state).toMatchObject({ round: 0, recipient: b, status: 'open' });
  });
});

describe('auto-pay', () => {
  const payNow = group.startDate - 86_400;
  const issue = () => tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice, now: payNow });

  it('pays opted-in members from the invoice it issued and records a receipt', async () => {
    const issued = await issue();
    const paidInvoices: string[] = [];
    const autoPay = async (member: string, invoice: string) => {
      if (member !== b) return undefined; // c has not opted in
      paidInvoices.push(invoice);
      return preimages.get(invoice);
    };
    const result = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, autoPay, now: payNow });
    expect(paidInvoices).toEqual([issued.state.invoices[b]]);
    expect(result.state.paid).toEqual([b]);
    expect(result.autoReceipts).toMatchObject([{ payer: b, recipient: a, round: 0 }]);
    expect(result.actions).toContainEqual({ type: 'autopaid', payer: b });
  });

  it('never pays for an invoice with the wrong amount', async () => {
    const issued = await issue();
    const wrong = (await fetchInvoice('x@x.com', 999)).invoice;
    let paid = false;
    const result = await tick({
      group, state: { ...issued.state, invoices: { ...issued.state.invoices, [b]: wrong } },
      addresses, receipts: [], fetchInvoice, now: payNow,
      autoPay: async (member) => { if (member === b) paid = true; return undefined; },
    });
    expect(paid).toBe(false);
    expect(result.actions).toContainEqual({ type: 'autopay-failed', payer: b, reason: 'invoice amount does not match the contribution' });
  });

  it('does not count a payment whose preimage fails verification', async () => {
    const issued = await issue();
    const result = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, now: payNow, autoPay: async (m) => (m === b ? '00'.repeat(32) : undefined) });
    expect(result.state.paid).toEqual([]);
    expect(result.autoReceipts).toEqual([]);
    expect(result.actions.some((x) => x.type === 'autopay-failed' && x.payer === b)).toBe(true);
  });

  it('reports a failed payment without stopping the others', async () => {
    const issued = await issue();
    const result = await tick({
      group, state: issued.state, addresses, receipts: [], fetchInvoice, now: payNow,
      autoPay: async (member, invoice) => { if (member === b) throw new Error('budget exceeded'); return preimages.get(invoice); },
    });
    expect(result.actions).toContainEqual({ type: 'autopay-failed', payer: b, reason: 'budget exceeded' });
    expect(result.state.paid).toEqual([c]);
  });

  it('does not pay again once the member already has a valid receipt', async () => {
    const issued = await issue();
    const receipt = { groupId: 'g', round: 0, payer: b, recipient: a, invoice: issued.state.invoices[b]!, preimage: preimages.get(issued.state.invoices[b]!)! };
    let calls = 0;
    await tick({ group, state: issued.state, addresses, receipts: [receipt], fetchInvoice, now: payNow, autoPay: async (m, i) => { if (m === b) calls++; return preimages.get(i); } });
    expect(calls).toBe(0);
  });
});

describe('reminders', () => {
  const dayBefore = group.startDate - 3600;
  const issue = () => tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice, now: group.startDate - 7 * 86_400 });

  it('reminds each member once per stage, not on every tick', async () => {
    const issued = await issue();
    const first = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, now: dayBefore });
    expect(first.actions).toContainEqual({ type: 'remind', members: [b, c], deadline: group.startDate, round: 0, stage: 'due' });
    expect(first.state.reminders).toEqual({ [b]: 'due', [c]: 'due' });

    const again = await tick({ group, state: first.state, addresses, receipts: [], fetchInvoice, now: dayBefore + 600 });
    expect(again.actions.some((x) => x.type === 'remind')).toBe(false);

    const overdue = await tick({ group, state: again.state, addresses, receipts: [], fetchInvoice, now: group.startDate + 60 });
    expect(overdue.actions).toContainEqual({ type: 'remind', members: [b, c], deadline: group.startDate, round: 0, stage: 'overdue' });
  });

  it('does not remind members who already paid, or who have no invoice to pay', async () => {
    const issued = await issue();
    const receipt = { groupId: 'g', round: 0, payer: b, recipient: a, invoice: issued.state.invoices[b]!, preimage: preimages.get(issued.state.invoices[b]!)! };
    const noInvoiceForC = { ...issued.state, invoices: { [b]: issued.state.invoices[b]! } };
    const broken: FetchInvoice = async () => { throw new Error('offline'); };
    const result = await tick({ group, state: noInvoiceForC, addresses, receipts: [receipt], fetchInvoice: broken, now: dayBefore });
    expect(result.actions.some((x) => x.type === 'remind')).toBe(false);
  });

  it('does nothing earlier than a day before the deadline', async () => {
    const issued = await issue();
    const result = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, now: group.startDate - 3 * 86_400 });
    expect(result.actions.some((x) => x.type === 'remind')).toBe(false);
  });
});

describe('defaults and payment times', () => {
  const issue = () => tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice, now: group.startDate - 7 * 86_400 });
  const receiptFor = (payer: string, state: Awaited<ReturnType<typeof issue>>['state']) =>
    ({ groupId: 'g', round: 0, payer, recipient: a, invoice: state.invoices[payer]!, preimage: preimages.get(state.invoices[payer]!)! });

  it('records when it first saw each payment', async () => {
    const issued = await issue();
    const seenAt = group.startDate - 1000;
    const result = await tick({ group, state: issued.state, addresses, receipts: [receiptFor(b, issued.state)], fetchInvoice, now: seenAt });
    expect(result.state.paidAt).toEqual({ [b]: seenAt });
    const later = await tick({ group, state: result.state, addresses, receipts: [receiptFor(b, issued.state)], fetchInvoice, now: seenAt + 500 });
    expect(later.state.paidAt).toEqual({ [b]: seenAt });
  });

  it('closes the round and marks a non-payer as defaulted a week after the deadline', async () => {
    const issued = await issue();
    const paidB = await tick({ group, state: issued.state, addresses, receipts: [receiptFor(b, issued.state)], fetchInvoice, now: group.startDate - 100 });
    const early = await tick({ group, state: paidB.state, addresses, receipts: [receiptFor(b, issued.state)], fetchInvoice, now: group.startDate + 6 * 86_400 });
    expect(early.state.status).toBe('open');
    expect(early.state.defaulted).toBeUndefined();

    const late = await tick({ group, state: paidB.state, addresses, receipts: [receiptFor(b, issued.state)], fetchInvoice, now: group.startDate + 8 * 86_400 });
    expect(late.actions).toContainEqual({ type: 'defaulted', members: [c], round: 0 });
    expect(late.state).toMatchObject({ status: 'complete', defaulted: [c] });
  });

  it('blames nobody when no payment got through, since the recipient may be unreachable', async () => {
    const issued = await issue();
    const result = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, now: group.startDate + 30 * 86_400 });
    expect(result.state.status).toBe('open');
    expect(result.state.defaulted).toBeUndefined();
  });

  it('never marks a member who had no invoice to pay', async () => {
    const issued = await issue();
    const paidB = await tick({ group, state: issued.state, addresses, receipts: [receiptFor(b, issued.state)], fetchInvoice, now: group.startDate - 100 });
    const withoutC = { ...paidB.state, invoices: { [b]: paidB.state.invoices[b]! } };
    const broken: FetchInvoice = async () => { throw new Error('offline'); };
    const result = await tick({ group, state: withoutC, addresses, receipts: [receiptFor(b, issued.state)], fetchInvoice: broken, now: group.startDate + 8 * 86_400 });
    expect(result.state.defaulted).toBeUndefined();
    expect(result.state.status).toBe('open');
  });
});

describe('payments from any wallet (LNURL verify)', () => {
  const when = group.startDate - 86_400;
  const withVerify: FetchInvoice = async (address, sats) => ({ ...(await fetchInvoice(address, sats)), verifyUrl: 'https://wallet.example/verify/x' });
  const issue = () => tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice: withVerify, now: when });

  it('remembers the verify link of each invoice', async () => {
    const issued = await issue();
    expect(issued.state.verify).toEqual({ [b]: 'https://wallet.example/verify/x', [c]: 'https://wallet.example/verify/x' });
  });

  it('counts a payment the provider reports, after checking its proof, and records a receipt', async () => {
    const issued = await issue();
    const checked: string[] = [];
    const checkPayment = async (url: string) => { checked.push(url); return { settled: true, preimage: preimages.get(issued.state.invoices[b]!) }; };
    const result = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, checkPayment: (u) => checkPayment(u).then((r) => ({ ...r })), now: when });
    // the fake answers every call with b's proof, so only b's invoice matches it
    expect(result.state.paid).toEqual([b]);
    expect(result.actions).toContainEqual({ type: 'payment-detected', payer: b });
    expect(result.autoReceipts).toMatchObject([{ payer: b, round: 0 }]);
    expect(checked.length).toBeGreaterThan(0);
  });

  it('does not believe a provider that reports a payment without valid proof', async () => {
    const issued = await issue();
    for (const answer of [{ settled: true, preimage: '00'.repeat(32) }, { settled: true }]) {
      const result = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, checkPayment: async () => answer, now: when });
      expect(result.state.paid).toEqual([]);
      expect(result.actions.some((x) => x.type === 'verify-failed')).toBe(true);
    }
  });

  it('does nothing when the invoice is not paid yet, and keeps going if a check fails', async () => {
    const issued = await issue();
    const unpaidResult = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, checkPayment: async () => ({ settled: false }), now: when });
    expect(unpaidResult.state.paid).toEqual([]);
    expect(unpaidResult.actions.some((x) => x.type === 'verify-failed')).toBe(false);
    const failing = await tick({ group, state: issued.state, addresses, receipts: [], fetchInvoice, checkPayment: async () => { throw new Error('provider down'); }, now: when });
    expect(failing.actions).toContainEqual({ type: 'verify-failed', payer: b, reason: 'provider down' });
  });

  it('checks for a payment before auto-paying, so an invoice already paid by hand is not paid again', async () => {
    const issued = await issue();
    let autoPaid = false;
    const result = await tick({
      group, state: issued.state, addresses, receipts: [], fetchInvoice, now: when,
      checkPayment: async (_url) => ({ settled: true, preimage: preimages.get(issued.state.invoices[b]!) }),
      autoPay: async (member, invoice) => { if (member === b) autoPaid = true; return preimages.get(invoice); },
    });
    expect(result.state.paid).toContain(b);
    expect(autoPaid).toBe(false);
  });
});

describe('rounds that have not opened yet', () => {
  it('issues nothing, checks nothing and reminds nobody until the round opens', async () => {
    const opensAt = group.startDate - 3 * 86_400;
    const upcoming = { ...openRound(group, 0), opensAt };
    let fetched = 0;
    const counting: FetchInvoice = async (address, sats) => { fetched++; return fetchInvoice(address, sats); };
    const early = await tick({ group, state: upcoming, addresses, receipts: [], fetchInvoice: counting, checkPayment: async () => { throw new Error('should not be asked'); }, now: opensAt - 1 });
    expect(early).toEqual({ group, state: upcoming, actions: [], autoReceipts: [] });
    expect(fetched).toBe(0);

    const open = await tick({ group, state: upcoming, addresses, receipts: [], fetchInvoice: counting, now: opensAt });
    expect(Object.keys(open.state.invoices).sort()).toEqual([b, c]);
    expect(fetched).toBe(2);
  });

  it('does not remind about a round that is not open, even one that falls due within a day', async () => {
    const opensAt = group.startDate; // opens at the deadline: absurd, but it must still wait
    const upcoming = { ...openRound(group, 0), opensAt };
    const result = await tick({ group, state: upcoming, addresses, receipts: [], fetchInvoice, now: group.startDate - 3600 });
    expect(result.actions).toEqual([]);
  });
});

describe('invoices that expire before the round does', () => {
  const T0 = 1_800_000_000;
  const HOUR = 3600;
  let clock = T0;
  const made: string[] = [];

  /** An invoice created at the current fake time, valid for `expiry` seconds. */
  const invoiceAt = (createdAt: number, expiry: number) => {
    const preimage = bytesToHex(randomBytes(32));
    const encoded = bolt11.encode({
      satoshis: 1000, timestamp: createdAt,
      tags: [
        { tagName: 'payment_hash', data: bytesToHex(sha256(hexToBytes(preimage))) },
        { tagName: 'expire_time', data: expiry },
        { tagName: 'description', data: 'ajo' },
        { tagName: 'payment_secret', data: bytesToHex(randomBytes(32)) },
      ],
    });
    const invoice = bolt11.sign(encoded, nodeKey).paymentRequest!;
    preimages.set(invoice, preimage);
    made.push(invoice);
    return invoice;
  };
  const provider = (expiry = HOUR): FetchInvoice => async () => ({ invoice: invoiceAt(clock, expiry), verifyUrl: `https://w.example/verify/${made.length}` });
  const step = (state: ReturnType<typeof openRound>, at: number, extra: Partial<Parameters<typeof tick>[0]> = {}) => {
    clock = at;
    return tick({ group, state, addresses, receipts: [], fetchInvoice: provider(), now: at, ...extra });
  };

  it('leaves an invoice alone until shortly before it expires, then replaces it', async () => {
    clock = T0;
    const first = await step(openRound(group, 0), T0);
    const old = first.state.invoices[b]!;
    const quiet = await step(first.state, T0 + 3000); // 50 minutes in: 10 minutes left, margin is 6
    expect(quiet.state.invoices[b]).toBe(old);
    expect(quiet.actions.some((x) => x.type === 'invoice-refreshed')).toBe(false);

    const refreshed = await step(quiet.state, T0 + 3300); // 5 minutes left
    expect(refreshed.state.invoices[b]).not.toBe(old);
    expect(refreshed.state.superseded?.[b]).toEqual([{ invoice: old, verify: first.state.verify![b] }]);
    expect(refreshed.actions).toContainEqual({ type: 'invoice-refreshed', payer: b });
  });

  it('uses a margin of a tenth of the lifetime, at most an hour, so a long invoice is replaced an hour early', async () => {
    clock = T0;
    const day = provider(86_400);
    const first = await tick({ group, state: openRound(group, 0), addresses, receipts: [], fetchInvoice: day, now: T0 });
    const old = first.state.invoices[b]!;
    clock = T0 + 22 * HOUR;
    const early = await tick({ group, state: first.state, addresses, receipts: [], fetchInvoice: day, now: T0 + 22 * HOUR });
    expect(early.state.invoices[b]).toBe(old);
    clock = T0 + 23 * HOUR + 60;
    const late = await tick({ group, state: first.state, addresses, receipts: [], fetchInvoice: day, now: T0 + 23 * HOUR + 60 });
    expect(late.state.invoices[b]).not.toBe(old);
  });

  it('still counts a payment made on the invoice that was replaced', async () => {
    clock = T0;
    const first = await step(openRound(group, 0), T0);
    const old = first.state.invoices[b]!;
    const refreshed = await step(first.state, T0 + 3300);
    const receipt = { groupId: 'g', round: 0, payer: b, recipient: a, invoice: old, preimage: preimages.get(old)! };
    const result = await step(refreshed.state, T0 + 3400, { receipts: [receipt] });
    expect(result.state.paid).toContain(b);
    // and a payer who has paid is not handed yet another invoice
    const later = await step(result.state, T0 + 3300 * 2);
    expect(later.state.superseded?.[b]).toHaveLength(1);
  });

  it('notices a payment on a replaced invoice through its own verify link', async () => {
    clock = T0;
    const first = await step(openRound(group, 0), T0);
    const old = first.state.invoices[b]!;
    const oldUrl = first.state.verify![b]!;
    const refreshed = await step(first.state, T0 + 3300);
    expect(refreshed.state.verify![b]).not.toBe(oldUrl); // the new invoice has its own link
    const asked: string[] = [];
    const checkPayment = async (url: string) => { asked.push(url); return url === oldUrl ? { settled: true, preimage: preimages.get(old) } : { settled: false }; };
    const result = await step(refreshed.state, T0 + 3400, { checkPayment });
    expect(asked).toContain(oldUrl);
    expect(asked).toContain(refreshed.state.verify![b]!);
    expect(result.state.paid).toContain(b);
    expect(result.actions).toContainEqual({ type: 'payment-detected', payer: b });
  });

  it('keeps the old invoice and tries again if getting a new one fails', async () => {
    clock = T0;
    const first = await step(openRound(group, 0), T0);
    const old = first.state.invoices[b]!;
    const down: FetchInvoice = async () => { throw new Error('provider down'); };
    const failed = await step(first.state, T0 + 3400, { fetchInvoice: down });
    expect(failed.state.invoices[b]).toBe(old);
    expect(failed.actions).toContainEqual({ type: 'invoice-failed', payer: b, reason: 'provider down' });
    const recovered = await step(failed.state, T0 + 3460);
    expect(recovered.state.invoices[b]).not.toBe(old);
  });

  it('remembers only the latest few replaced invoices', async () => {
    clock = T0;
    let state = (await step(openRound(group, 0), T0)).state;
    for (let i = 1; i <= 14; i++) state = (await step(state, T0 + i * 3300)).state;
    expect(state.superseded?.[b]).toHaveLength(10);
  });

  it('never replaces an invoice it cannot read, or for a payer who already paid', async () => {
    const junk = { ...openRound(group, 0), invoices: { [b]: 'lnbc-not-an-invoice', [c]: 'lnbc-not-an-invoice' } };
    let fetched = 0;
    const counting: FetchInvoice = async () => { fetched++; return { invoice: invoiceAt(clock, HOUR) }; };
    const result = await step(junk, T0 + 10 * HOUR, { fetchInvoice: counting });
    expect(fetched).toBe(0);
    expect(result.state.invoices[b]).toBe('lnbc-not-an-invoice');
  });
});
