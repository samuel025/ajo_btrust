import { describe, expect, it } from 'vitest';
import { openRound, paymentTag, tagScript, type ChainTx, type GroupDef } from '@ajo/core';
import { tick, type ChainView, type FetchInvoice } from '../src';

const [a, b, c] = ['aa', 'bb', 'cc'].map((s) => s.repeat(32));
const group: GroupDef = {
  id: 'g', name: 'g', amountSats: 20_000, frequency: 'weekly', rail: 'onchain',
  payoutOrder: [a, b, c], startDate: 1_800_000_000, coordinator: 'dd'.repeat(32),
};
const bitcoinAddresses = { [a]: 'tb1qrecipient', [b]: 'tb1qbob', [c]: 'tb1qcarol' };
const noLightning: FetchInvoice = async () => { throw new Error('an on-chain group must never ask for an invoice'); };

const payment = (payer: string, over: { value?: number; height?: number | null; round?: number } = {}): ChainTx => ({
  txid: `tx-${payer.slice(0, 2)}`,
  status: over.height === null ? { confirmed: false } : { confirmed: true, block_height: over.height ?? 100 },
  vout: [
    { scriptpubkey: '0014aa', scriptpubkey_address: 'tb1qrecipient', value: over.value ?? 20_000 },
    { scriptpubkey: tagScript(paymentTag('g', over.round ?? 0, payer)), value: 0 },
  ],
});
const chainOf = (txs: ChainTx[], tip = 100): ChainView => ({ txs: async () => txs, tip: async () => tip });
const base = { group, addresses: {}, receipts: [], fetchInvoice: noLightning, bitcoinAddresses, now: group.startDate - 86_400 * 3 };

describe('an on-chain group', () => {
  it('never asks for invoices, and credits members whose tagged payment is confirmed', async () => {
    const result = await tick({ ...base, state: openRound(group, 0), chain: chainOf([payment(b)]) });
    expect(result.state.paid).toEqual([b]);
    expect(result.state.txids).toEqual({ [b]: 'tx-bb' });
    expect(result.state.invoices).toEqual({});
    expect(result.actions).toContainEqual({ type: 'payment-detected', payer: b });
    expect(result.state.status).toBe('open');
  });

  it('closes the round when everyone has paid', async () => {
    const result = await tick({ ...base, state: openRound(group, 0), chain: chainOf([payment(b), payment(c)]) });
    expect(result.state.status).toBe('complete');
    expect(result.actions).toContainEqual({ type: 'round-complete', round: 0 });
  });

  it('waits for confirmations', async () => {
    const pending = await tick({ ...base, state: openRound(group, 0), chain: chainOf([payment(b, { height: null })]) });
    expect(pending.state.paid).toEqual([]);
    const needsTwo = await tick({ ...base, state: openRound(group, 0), chain: chainOf([payment(b, { height: 100 })], 100), minConfirmations: 2 });
    expect(needsTwo.state.paid).toEqual([]);
    const enough = await tick({ ...base, state: openRound(group, 0), chain: chainOf([payment(b, { height: 99 })], 100), minConfirmations: 2 });
    expect(enough.state.paid).toEqual([b]);
  });

  it('ignores a short payment and a payment for another round', async () => {
    const result = await tick({ ...base, state: openRound(group, 0), chain: chainOf([payment(b, { value: 19_999 }), payment(c, { round: 1 })]) });
    expect(result.state.paid).toEqual([]);
  });

  it('does not credit the same member twice, and a member cannot be credited with a transaction tagged for another', async () => {
    const first = await tick({ ...base, state: openRound(group, 0), chain: chainOf([payment(b)]) });
    const again = await tick({ ...base, state: first.state, chain: chainOf([payment(b)]) });
    expect(again.state.paid).toEqual([b]);
    expect(again.actions.filter((x) => x.type === 'payment-detected')).toEqual([]);
  });

  it('reports a chain outage without failing the round', async () => {
    const broken: ChainView = { txs: async () => { throw new Error('esplora is down'); }, tip: async () => 1 };
    const result = await tick({ ...base, state: openRound(group, 0), chain: broken });
    expect(result.actions).toContainEqual({ type: 'chain-failed', reason: 'esplora is down' });
    expect(result.state.paid).toEqual([]);
  });

  it('reminds members who owe, with no invoice needed', async () => {
    const result = await tick({ ...base, now: group.startDate - 3600, state: openRound(group, 0), chain: chainOf([]) });
    expect(result.actions).toContainEqual({ type: 'remind', members: [b, c], deadline: group.startDate, round: 0, stage: 'due' });
  });

  it('does not remind anyone while the recipient has no Bitcoin address', async () => {
    const result = await tick({ ...base, bitcoinAddresses: {}, now: group.startDate - 3600, state: openRound(group, 0), chain: chainOf([]) });
    expect(result.actions.filter((x) => x.type === 'remind')).toEqual([]);
  });

  it('defers a recipient who never gave an address', async () => {
    const result = await tick({ ...base, bitcoinAddresses: {}, now: group.startDate + 3 * 86_400, state: openRound(group, 0), chain: chainOf([]) });
    expect(result.actions).toContainEqual({ type: 'recipient-deferred', recipient: a, round: 0 });
  });
});

describe('esploraChain', () => {
  it('reads transactions and the tip, and says so when the server fails', async () => {
    const { esploraChain } = await import('../src');
    const seen: string[] = [];
    const ok = esploraChain('https://example.test/api/', (async (url: string) => {
      seen.push(url);
      return url.endsWith('/blocks/tip/height') ? new Response('1234') : new Response(JSON.stringify([payment(b)]));
    }) as unknown as typeof fetch);
    expect(await ok.tip()).toBe(1234);
    expect((await ok.txs('tb1qrecipient'))[0]!.txid).toBe('tx-bb');
    expect(seen).toEqual(['https://example.test/api/blocks/tip/height', 'https://example.test/api/address/tb1qrecipient/txs']);
    const down = esploraChain('https://example.test/api', (async () => new Response('no', { status: 503 })) as unknown as typeof fetch);
    await expect(down.tip()).rejects.toThrow('503');
  });
});
