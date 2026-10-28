import { describe, expect, it } from 'vitest';
import bolt11 from 'bolt11';
import { describeWalletError, invoiceIsExpired, isNwcUrl, msatToSats, normalizeBudget, normalizeTransactions, parseSendInput } from '../src/lib/wallet';

const key = 'ab'.repeat(32);
const invoice = (opts: { sats?: number; createdAt?: number; expiry?: number } = {}) =>
  bolt11.sign(bolt11.encode({
    ...(opts.sats !== undefined ? { satoshis: opts.sats } : {}),
    timestamp: opts.createdAt ?? 1_800_000_000,
    tags: [
      { tagName: 'payment_hash', data: '01'.repeat(32) },
      { tagName: 'expire_time', data: opts.expiry ?? 3600 },
      { tagName: 'description', data: 'x' },
      { tagName: 'payment_secret', data: '02'.repeat(32) },
    ],
  }), key).paymentRequest!;

describe('parseSendInput', () => {
  it('reads an invoice, its amount and when it expires', () => {
    const t = parseSendInput(invoice({ sats: 2500 }));
    expect(t).toMatchObject({ kind: 'invoice', amountSats: 2500, expiresAt: 1_800_003_600 });
  });

  it('accepts the forms wallets and QR codes produce', () => {
    const inv = invoice({ sats: 10 });
    expect(parseSendInput(`  ${inv}  `).kind).toBe('invoice');
    expect(parseSendInput(`lightning:${inv}`).kind).toBe('invoice');
    expect(parseSendInput(`LIGHTNING:${inv.toUpperCase()}`)).toMatchObject({ kind: 'invoice', invoice: inv });
  });

  it('knows an invoice with no amount, which the person must fill in', () => {
    expect(parseSendInput(invoice())).toMatchObject({ kind: 'invoice', amountSats: undefined });
  });

  it('recognizes Lightning addresses, including the local test one', () => {
    expect(parseSendInput('amaka@wallet.com')).toEqual({ kind: 'address', address: 'amaka@wallet.com' });
    expect(parseSendInput('lightning:amaka@getalby.com')).toEqual({ kind: 'address', address: 'amaka@getalby.com' });
    expect(parseSendInput('a@localhost:3456')).toEqual({ kind: 'address', address: 'a@localhost:3456' });
  });

  it.each(['', '   ', 'hello', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'lnbc-garbage', 'a b@c.com', 'https://evil.example/pay'])('rejects %j', (text) => {
    expect(parseSendInput(text).kind).toBe('invalid');
  });

  it('says why when it is rejected', () => {
    expect(parseSendInput('hello')).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('Lightning address') });
  });
});

describe('invoiceIsExpired', () => {
  it('flips exactly at expiry', () => {
    const t = parseSendInput(invoice({ sats: 1 }));
    expect(invoiceIsExpired(t, 1_800_003_599)).toBe(false);
    expect(invoiceIsExpired(t, 1_800_003_600)).toBe(true);
    expect(invoiceIsExpired({ kind: 'address', address: 'a@b.co' }, 9e12)).toBe(false);
  });
});

describe('describeWalletError', () => {
  it.each([
    ['QUOTA_EXCEEDED', /budget/],
    ['INSUFFICIENT_BALANCE', /enough/],
    ['RESTRICTED', /permissions/],
    ['UNAUTHORIZED', /no longer accepts/],
    ['NOT_IMPLEMENTED', /doesn't support/],
    ['RATE_LIMITED', /too many/],
  ])('explains %s', (code, words) => {
    expect(describeWalletError({ code, message: 'raw' })).toMatch(words);
  });

  it('says nothing was taken when a payment fails, and warns about history after a timeout', () => {
    expect(describeWalletError({ code: 'PAYMENT_FAILED', message: 'no route' })).toMatch(/no route.*Nothing was taken/);
    expect(describeWalletError(new Error('reply timeout'))).toMatch(/check History/);
  });

  it('explains connection failures and expired invoices, and passes unknown errors through', () => {
    expect(describeWalletError(new Error('Failed to connect to wss://x'))).toMatch(/reach your wallet/);
    expect(describeWalletError(new Error('this invoice has expired'))).toMatch(/expired/);
    expect(describeWalletError(new Error('something odd'))).toBe('something odd');
  });
});

describe('normalizing what the wallet returns', () => {
  it('converts msats to sats, rounding down', () => {
    expect(msatToSats(1_500_999)).toBe(1500);
    expect(msatToSats(undefined)).toBe(0);
  });

  it('lists transactions newest first, with sats, type and state', () => {
    const txs = normalizeTransactions([
      { type: 'outgoing', amount: 2_000_000, fees_paid: 3000, description: ' lunch ', settled_at: 100, state: 'settled', payment_hash: 'h1' },
      { type: 'incoming', amount: 5_000_000, created_at: 200, state: 'pending' },
      { type: 'incoming', amount: 1_000_000, settled_at: 300 },
    ]);
    expect(txs.map((t) => t.at)).toEqual([300, 200, 100]);
    expect(txs[2]).toMatchObject({ type: 'outgoing', amountSats: 2000, feeSats: 3, description: 'lunch', state: 'settled' });
    expect(txs[1].state).toBe('pending');
    expect(txs[0].state).toBe('settled'); // no state given, but it has a settle time
  });

  it('reads a budget, and treats "no budget" as none', () => {
    expect(normalizeBudget({ used_budget: 1_000_000, total_budget: 1_500_000, renews_at: 5, renewal_period: 'weekly' }))
      .toEqual({ usedSats: 1000, totalSats: 1500, renewsAt: 5, period: 'weekly' });
    expect(normalizeBudget({ used_budget: 0, total_budget: 0 })).toBeUndefined();
    expect(normalizeBudget(undefined)).toBeUndefined();
  });

  it('recognizes a wallet connection string', () => {
    expect(isNwcUrl(`nostr+walletconnect://${'ab'.repeat(32)}?relay=wss%3A%2F%2Fr&secret=${'cd'.repeat(32)}`)).toBe(true);
    expect(isNwcUrl('nostr+walletconnect://short?relay=x')).toBe(false);
    expect(isNwcUrl('https://example.com')).toBe(false);
  });
});

describe('reminders from the coordinator', () => {
  it('go away once the member has paid, the round is complete, or they are the one being paid', async () => {
    const { activeNotices } = await import('../src/lib/notices');
    const notice = (round: number) => ({ member: 'me', round, stage: 'due' as const, text: 'pay up', at: 1 });
    const state = (round: number, over: object = {}) => ({ groupId: 'g', round, recipient: 'other', deadline: 1, paid: [] as string[], invoices: {}, status: 'open' as const, ...over });
    const rounds = new Map([[0, state(0)], [1, state(1, { paid: ['me'] })], [2, state(2, { status: 'complete' })], [3, state(3, { recipient: 'me' })], [4, state(4, { defaulted: ['me'] })]]);
    const shown = activeNotices([0, 1, 2, 3, 4, 5].map(notice), rounds, 'me').map((n) => n.round);
    expect(shown).toEqual([0]); // round 5 has no state, so it is not shown either
  });
});

describe('connecting a wallet', () => {
  it('turns what a person types into the wallet approval address', async () => {
    const { hubAuthorizationUrl } = await import('../src/lib/connect');
    expect(hubAuthorizationUrl('my.albyhub.com')).toBe('https://my.albyhub.com/apps/new');
    expect(hubAuthorizationUrl(' https://my.albyhub.com/ ')).toBe('https://my.albyhub.com/apps/new');
    expect(hubAuthorizationUrl('https://hub.example.com/some/path?x=1')).toBe('https://hub.example.com/apps/new');
    expect(hubAuthorizationUrl('localhost:8080')).toBe('http://localhost:8080/apps/new');
    expect(hubAuthorizationUrl('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081/apps/new');
    expect(() => hubAuthorizationUrl('')).toThrow(/address of your wallet/);
    expect(() => hubAuthorizationUrl('http://evil.example.com')).toThrow(/secure/);
    expect(() => hubAuthorizationUrl('not a url at all')).toThrow(/web address/);
    expect(() => hubAuthorizationUrl('https://x.com/#/apps')).toThrow(/plain address/);
  });

  it('explains the ways connecting can go wrong', async () => {
    const { describeConnectError } = await import('../src/lib/connect');
    expect(describeConnectError(new Error('failed to execute window.open'))).toMatch(/pop-ups/);
    expect(describeConnectError(new Error('Popup closed'))).toMatch(/closed before you approved/);
    expect(describeConnectError(new Error('no walletPubkey in response'))).toMatch(/recent version/);
  });

  it('pays through a browser extension, and says plainly when there is none or it is declined', async () => {
    const { payWithExtension } = await import('../src/lib/connect');
    const g = globalThis as unknown as { window?: unknown };
    g.window = {};
    await expect(payWithExtension('lnbc1x')).rejects.toThrow(/No Lightning wallet extension/);
    const proof = 'ab'.repeat(32);
    g.window = { webln: { enable: async () => undefined, sendPayment: async () => ({ preimage: proof }) } };
    expect(await payWithExtension('lnbc1x')).toBe(proof);
    g.window = { webln: { enable: async () => undefined, sendPayment: async () => { throw new Error('User rejected'); } } };
    await expect(payWithExtension('lnbc1x')).rejects.toThrow(/declined/);
    g.window = { webln: { enable: async () => undefined, sendPayment: async () => ({ preimage: 'nope' }) } };
    await expect(payWithExtension('lnbc1x')).rejects.toThrow(/did not return a payment proof/);
    delete g.window;
  });
});
