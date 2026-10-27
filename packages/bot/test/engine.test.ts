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
