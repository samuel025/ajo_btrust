import { NWCClient } from '@getalby/sdk';
import { fetchInvoice, isExpired, parseInvoice } from '@ajo/core';

/* ---------- pure helpers (tested without a wallet) ---------- */

export const msatToSats = (msat: number | undefined) => Math.floor((msat ?? 0) / 1000);

export type SendTarget =
  | { kind: 'invoice'; invoice: string; amountSats?: number; expiresAt?: number; paymentHash: string }
  | { kind: 'address'; address: string }
  | { kind: 'invalid'; reason: string };

const INVOICE = /^ln(bc|tbs|tb|bcrt)[0-9]*[munp]?1[0-9a-z]+$/i;
const ADDRESS = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$|^[^@\s/]+@localhost(:\d+)?$/i;

/** Understands what a person pastes into "Send": an invoice, a Lightning address, or neither. */
export function parseSendInput(text: string): SendTarget {
  const value = text.trim().replace(/^lightning:/i, '').replace(/^lnurl[pw]?:/i, '');
  if (!value) return { kind: 'invalid', reason: 'Paste an invoice or a Lightning address.' };
  if (INVOICE.test(value)) {
    try {
      const info = parseInvoice(value);
      return {
        kind: 'invoice',
        invoice: value.toLowerCase(),
        amountSats: info.amountMsats === undefined ? undefined : msatToSats(info.amountMsats),
        expiresAt: info.expiresAt,
        paymentHash: info.paymentHash,
      };
    } catch {
      return { kind: 'invalid', reason: "That looks like an invoice, but it can't be read. Copy it again." };
    }
  }
  if (ADDRESS.test(value)) return { kind: 'address', address: value };
  return { kind: 'invalid', reason: "That isn't an invoice (starts with lnbc or lntbs) or a Lightning address (name@wallet.com)." };
}

export function invoiceIsExpired(target: SendTarget, nowSeconds: number): boolean {
  return target.kind === 'invoice' && target.expiresAt !== undefined && nowSeconds >= target.expiresAt;
}

/** Wallet errors, in words a person can act on. */
export function describeWalletError(error: unknown): string {
  const e = error as { code?: string; message?: string; name?: string };
  const message = String(e?.message ?? error);
  switch (e?.code) {
    case 'QUOTA_EXCEEDED': return "This connection's spending budget is used up. Raise it in your wallet, or wait for it to renew.";
    case 'INSUFFICIENT_BALANCE': return "There isn't enough in your wallet for that, including the network fee.";
    case 'RESTRICTED': return "This connection isn't allowed to do that. Give it more permissions in your wallet.";
    case 'UNAUTHORIZED': return 'The wallet no longer accepts this connection. Create a new one.';
    case 'NOT_IMPLEMENTED': return "Your wallet doesn't support that.";
    case 'RATE_LIMITED': return 'The wallet says too many requests. Wait a moment and try again.';
    case 'PAYMENT_FAILED': return `The payment failed: ${message}. Nothing was taken from your wallet.`;
    case 'NOT_FOUND': return "The wallet can't find that.";
  }
  if (/failed to connect/i.test(message)) return "Couldn't reach your wallet's relay. Check your connection and try again.";
  if (/timed? ?out|timeout/i.test(message) || /Nip47.*Timeout/i.test(e?.name ?? '')) {
    return "Your wallet didn't answer in time. It may be offline or locked. If you were paying, check History before trying again.";
  }
  if (/expired/i.test(message)) return 'That invoice has expired. Ask for a new one.';
  return message;
}

export interface Tx {
  type: 'incoming' | 'outgoing';
  amountSats: number;
  feeSats: number;
  description: string;
  /** Unix seconds. */
  at: number;
  state: 'settled' | 'pending' | 'failed' | 'accepted';
  paymentHash?: string;
}

/** Normalizes the wallet's transaction list: newest first, amounts in sats. */
export function normalizeTransactions(raw: unknown[]): Tx[] {
  return raw
    .map((t: any): Tx => ({
      type: t.type === 'incoming' ? 'incoming' : 'outgoing',
      amountSats: msatToSats(t.amount),
      feeSats: msatToSats(t.fees_paid),
      description: String(t.description ?? '').trim(),
      at: Number(t.settled_at ?? t.created_at ?? 0),
      state: (['settled', 'pending', 'failed', 'accepted'].includes(t.state) ? t.state : t.settled_at ? 'settled' : 'pending') as Tx['state'],
      paymentHash: t.payment_hash,
    }))
    .sort((a, b) => b.at - a.at);
}

export interface Budget { usedSats: number; totalSats: number; renewsAt?: number; period?: string }

export function normalizeBudget(raw: any): Budget | undefined {
  if (!raw || typeof raw.total_budget !== 'number' || raw.total_budget <= 0) return undefined;
  return { usedSats: msatToSats(raw.used_budget), totalSats: msatToSats(raw.total_budget), renewsAt: raw.renews_at, period: raw.renewal_period };
}

export const isNwcUrl = (text: string) => /^nostr\+walletconnect:\/\/[0-9a-f]{64}\?/i.test(text.trim());

/* ---------- talking to the wallet over NWC ---------- */

const CONNECT_ATTEMPTS = 3;

/**
 * Runs one request against the wallet. A failure to reach the relay is retried for requests that are
 * safe to repeat; a payment is never retried automatically, because it may have gone out.
 */
async function request<T>(nwcUrl: string, run: (client: NWCClient) => Promise<T>, { retry = true } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = new NWCClient({ nostrWalletConnectUrl: nwcUrl });
    try {
      return await run(client);
    } catch (e) {
      const connectFailure = /failed to connect/i.test(String((e as Error)?.message));
      if (!retry || !connectFailure || attempt >= CONNECT_ATTEMPTS) throw e;
    } finally {
      client.close();
    }
  }
}

export interface WalletInfo { alias: string; network: string; methods: string[]; budget?: Budget }

export async function walletInfo(nwcUrl: string): Promise<WalletInfo> {
  return request(nwcUrl, async (c) => {
    const info = await c.getInfo();
    const budget = info.methods.includes('get_budget') ? normalizeBudget(await c.getBudget().catch(() => undefined)) : undefined;
    return { alias: info.alias ?? '', network: info.network ?? '', methods: info.methods, budget };
  });
}

export async function walletBalanceSats(nwcUrl: string): Promise<number> {
  return request(nwcUrl, async (c) => msatToSats((await c.getBalance()).balance));
}

export async function walletTransactions(nwcUrl: string, limit = 20): Promise<Tx[]> {
  return request(nwcUrl, async (c) => normalizeTransactions((await c.listTransactions({ limit })).transactions));
}

export interface ReceiveInvoice { invoice: string; paymentHash: string; expiresAt?: number }

export async function createInvoice(nwcUrl: string, sats: number, description: string): Promise<ReceiveInvoice> {
  return request(nwcUrl, async (c) => {
    const tx = await c.makeInvoice({ amount: sats * 1000, description });
    const info = parseInvoice(tx.invoice);
    return { invoice: tx.invoice, paymentHash: tx.payment_hash ?? info.paymentHash, expiresAt: info.expiresAt };
  });
}

/** True once the invoice has been paid. */
export async function invoiceSettled(nwcUrl: string, paymentHash: string): Promise<boolean> {
  return request(nwcUrl, async (c) => (await c.lookupInvoice({ payment_hash: paymentHash })).state === 'settled');
}

export interface Payment { preimage: string; feeSats: number }

/** Pays an invoice. Never retried automatically. A zero-amount invoice needs `amountSats`. */
export async function sendPayment(nwcUrl: string, invoice: string, amountSats?: number): Promise<Payment> {
  return request(nwcUrl, async (c) => {
    const result = await c.payInvoice({ invoice, ...(amountSats !== undefined ? { amount: amountSats * 1000 } : {}) });
    return { preimage: result.preimage, feeSats: msatToSats(result.fees_paid) };
  }, { retry: false });
}

/** Turns a Lightning address and an amount into an invoice, using the provider's LNURL-pay service. */
export async function invoiceFromAddress(address: string, sats: number): Promise<string> {
  const { invoice } = await fetchInvoice(address, sats, (url, init) => fetch(url, init));
  if (isExpired(parseInvoice(invoice), Math.floor(Date.now() / 1000))) throw new Error('The provider returned an invoice that has already expired.');
  return invoice;
}
