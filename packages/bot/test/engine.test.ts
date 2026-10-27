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
      { tagName: 'description', data: 'ajo' },
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
    expect(one.actions).toContainEqual({ type: 'remind', members: [c], deadline: group.startDate });

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
