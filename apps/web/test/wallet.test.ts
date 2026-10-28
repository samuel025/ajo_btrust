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

  it('says exactly when a payment did not happen, and never guesses when it is unsure', async () => {
    const { NotPaidError, payWithExtension } = await import('../src/lib/connect');
    const g = globalThis as unknown as { window?: unknown };
    const proof = 'ab'.repeat(32);
    g.window = {};
    await expect(payWithExtension('lnbc1x')).rejects.toBeInstanceOf(NotPaidError); // no extension: nothing paid
    g.window = { webln: { enable: async () => undefined, sendPayment: async () => ({ preimage: proof }) } };
    expect(await payWithExtension('lnbc1x')).toEqual({ preimage: proof });
    g.window = { webln: { enable: async () => undefined, sendPayment: async () => ({ preimage: proof.toUpperCase() }) } };
    expect(await payWithExtension('lnbc1x')).toEqual({ preimage: proof });
    // declined by the person: certain that nothing was paid
    g.window = { webln: { enable: async () => undefined, sendPayment: async () => { throw new Error('User rejected'); } } };
    await expect(payWithExtension('lnbc1x')).rejects.toBeInstanceOf(NotPaidError);
    g.window = { webln: { enable: async () => { throw new Error('User rejected'); }, sendPayment: async () => ({ preimage: proof }) } };
    await expect(payWithExtension('lnbc1x')).rejects.toBeInstanceOf(NotPaidError);
    // the wallet said it paid but gave no usable proof: it PAID, so this must not look like a failure
    for (const odd of [{ preimage: 'nope' }, { preimage: '' }, {}, undefined]) {
      g.window = { webln: { enable: async () => undefined, sendPayment: async () => odd } };
      expect(await payWithExtension('lnbc1x')).toEqual({ preimage: undefined });
    }
    // an error after the payment was sent (a timeout, a closed window) leaves the outcome unknown: not a NotPaidError
    g.window = { webln: { enable: async () => undefined, sendPayment: async () => { throw new Error('timeout'); } } };
    const unknown = await payWithExtension('lnbc1x').catch((e) => e);
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown).not.toBeInstanceOf(NotPaidError);
    delete g.window;
  });
});

describe('checking a Lightning address when joining', () => {
  const answer = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const good = { tag: 'payRequest', callback: 'https://x.test/pay/amaka', minSendable: 1000, maxSendable: 1_000_000_000 };

  it('accepts an address that answers like a Lightning provider', async () => {
    const { checkLightningAddress } = await import('../src/lib/lnaddress');
    expect(await checkLightningAddress('amaka@x.test', 1000, answer(200, good))).toEqual({ kind: 'ok' });
  });

  it('says plainly when the address is wrong, and when it cannot take the amount', async () => {
    const { checkLightningAddress } = await import('../src/lib/lnaddress');
    expect(await checkLightningAddress('nobody@x.test', 1000, answer(404, {}))).toMatchObject({ kind: 'bad', message: expect.stringContaining('no such address') });
    expect(await checkLightningAddress('a@x.test', 1000, answer(500, {}))).toMatchObject({ kind: 'bad', message: expect.stringContaining('500') });
    expect(await checkLightningAddress('a@x.test', 1000, answer(200, { status: 'ERROR', reason: 'not found' }))).toMatchObject({ kind: 'bad', message: expect.stringContaining('not found') });
    expect(await checkLightningAddress('a@x.test', 1000, answer(200, { hello: 'world' }))).toMatchObject({ kind: 'bad' });
    expect(await checkLightningAddress('a@x.test', 1000, async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }))).toMatchObject({ kind: 'bad' });
    expect(await checkLightningAddress('a@x.test', 50, answer(200, { ...good, minSendable: 100_000 }))).toMatchObject({ kind: 'bad', message: expect.stringContaining('accepts 100 to') });
    expect(await checkLightningAddress('not-an-address', 1000, answer(200, good))).toMatchObject({ kind: 'bad' });
  });

  it('lets the person continue when the lookup got no answer, since that can be the browser and not the address', async () => {
    const { checkLightningAddress } = await import('../src/lib/lnaddress');
    const refused = async () => { throw new TypeError('Failed to fetch'); };
    expect(await checkLightningAddress('ada@localhos:5432', 1000, refused)).toMatchObject({ kind: 'unreachable', message: expect.stringContaining('typo') });
  });
});

describe('remembering a payment', () => {
  it('keeps what was paid for a round, per payer, so a failure afterwards cannot lead to paying twice', async () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const { recallPaid, rememberPaid } = await import('../src/lib/paid');
    expect(recallPaid('g', 0, 'me')).toBeUndefined();
    rememberPaid('g', 0, 'me', { invoice: 'lnbc1x', preimage: 'ab'.repeat(32) });
    expect(recallPaid('g', 0, 'me')).toEqual({ invoice: 'lnbc1x', preimage: 'ab'.repeat(32) });
    expect(recallPaid('g', 1, 'me')).toBeUndefined(); // the next round is a new payment
    expect(recallPaid('g', 0, 'someone-else')).toBeUndefined();
    // a payment whose outcome is unknown keeps the card locked until the person says otherwise
    const { clearAttempt, hasAttempt, markAttempt } = await import('../src/lib/paid');
    expect(hasAttempt('g', 0, 'me')).toBe(false);
    markAttempt('g', 0, 'me');
    expect(hasAttempt('g', 0, 'me')).toBe(true);
    expect(hasAttempt('g', 1, 'me')).toBe(false);
    clearAttempt('g', 0, 'me');
    expect(hasAttempt('g', 0, 'me')).toBe(false);
    // a payment made with no proof is still a payment
    rememberPaid('g', 3, 'me', { invoice: 'lnbc1y' });
    expect(recallPaid('g', 3, 'me')).toEqual({ invoice: 'lnbc1y' });
    store.set('ajo.paid.g.2.me', 'not json');
    expect(recallPaid('g', 2, 'me')).toBeUndefined();
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });
});

describe('filling in the New group form from a description', () => {
  it('converts naira to sats at the current rate and reports what it filled in', async () => {
    const { applyDraft } = await import('../src/lib/ai');
    const applied = applyDraft({ name: 'Office ajo', amountNaira: 20_000, frequency: 'monthly', startDate: '2026-12-01', members: 8 }, 100_000_000); // ₦100M per BTC → ₦1 = 1 sat
    expect(applied.values).toEqual({ name: 'Office ajo', amount: '20000', frequency: 'monthly', start: '2026-12-01' });
    expect(applied.changed.join(' ')).toContain('₦20,000 per round (20,000 sats');
    expect(applied.notes.join(' ')).toContain('8 people');
  });

  it('never changes the amount when there is no rate, and says so', async () => {
    const { applyDraft } = await import('../src/lib/ai');
    const applied = applyDraft({ amountNaira: 5000, frequency: 'weekly' }, undefined);
    expect(applied.values).toEqual({ frequency: 'weekly' });
    expect(applied.notes.join(' ')).toContain("exchange rate isn't available");
  });

  it('takes sats as given, and says "every two weeks" for biweekly', async () => {
    const { applyDraft } = await import('../src/lib/ai');
    const applied = applyDraft({ amountSats: 3000, frequency: 'biweekly' }, 100_000_000);
    expect(applied.values).toEqual({ amount: '3000', frequency: 'biweekly' });
    expect(applied.changed.join(' ')).toContain('every two weeks');
  });
});

describe('which wallet errors mean nothing was paid', () => {
  it('treats refusals and a wallet that was never reached as unpaid, and a timeout as unknown', async () => {
    const { isDefinitelyNotPaid } = await import('../src/lib/pay');
    for (const code of ['QUOTA_EXCEEDED', 'INSUFFICIENT_BALANCE', 'RESTRICTED', 'PAYMENT_FAILED']) expect(isDefinitelyNotPaid({ code, message: 'x' })).toBe(true);
    expect(isDefinitelyNotPaid(new Error('failed to connect to relay'))).toBe(true);
    expect(isDefinitelyNotPaid(new Error('reply timeout: event abc'))).toBe(false);
    expect(isDefinitelyNotPaid({ code: 'INTERNAL', message: 'oops' })).toBe(false);
    expect(isDefinitelyNotPaid(undefined)).toBe(false);
  });
});
