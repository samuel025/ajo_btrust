import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { decode } from 'light-bolt11-decoder';

export interface InvoiceInfo {
  paymentHash: string;
  amountMsats: number | undefined;
  /** How long the invoice can be paid, in seconds (the standard default is an hour). */
  expirySeconds: number;
  /** When it stops being payable, as unix seconds; undefined if the invoice has no timestamp. */
  expiresAt: number | undefined;
}

export function parseInvoice(invoice: string): InvoiceInfo {
  const sections = decode(invoice).sections;
  const hash = sections.find((s) => s.name === 'payment_hash');
  if (!hash || !('value' in hash) || typeof hash.value !== 'string') {
    throw new Error('invoice has no payment hash');
  }
  const amount = sections.find((s) => s.name === 'amount');
  const amountMsats = amount && 'value' in amount ? Number(amount.value) : undefined;
  const stamp = sections.find((s) => s.name === 'timestamp');
  const created = stamp && 'value' in stamp ? Number(stamp.value) : undefined;
  const expiry = sections.find((s) => s.name === 'expiry');
  const expirySeconds = expiry && 'value' in expiry && Number(expiry.value) > 0 ? Number(expiry.value) : 3600;
  return { paymentHash: hash.value, amountMsats, expirySeconds, expiresAt: created === undefined ? undefined : created + expirySeconds };
}

/** True once an invoice can no longer be paid: wallets refuse it. */
export function isExpired(info: InvoiceInfo, now: number): boolean {
  return info.expiresAt !== undefined && now >= info.expiresAt;
}

/**
 * A round lasts a whole period but an invoice only an hour or a day, so the coordinator replaces an
 * invoice shortly before it expires: this long before, namely a tenth of its lifetime, at most an hour.
 */
export const refreshMargin = (expirySeconds: number) => Math.min(3600, Math.floor(expirySeconds * 0.1));

/** Whether the coordinator should replace this invoice now. An unreadable invoice is left alone. */
export function needsRefresh(invoice: string, now: number): boolean {
  let info: InvoiceInfo;
  try { info = parseInvoice(invoice); } catch { return false; }
  return info.expiresAt !== undefined && now >= info.expiresAt - refreshMargin(info.expirySeconds);
}

export function preimageMatches(preimage: string, paymentHash: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(preimage)) return false;
  return bytesToHex(sha256(hexToBytes(preimage))) === paymentHash.toLowerCase();
}

export interface VerifyOptions {
  /** The amount the payer owed, in sats. */
  amountSats: number;
  /**
   * Payment hash from an invoice the verifier fetched itself from the recipient's
   * Lightning address. Without it, a payer could substitute an invoice they control.
   */
  recipientPaymentHash: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyReceipt(
  receipt: { invoice: string; preimage: string },
  opts: VerifyOptions,
): VerifyResult {
  let info: InvoiceInfo;
  try {
    info = parseInvoice(receipt.invoice);
  } catch {
    return { ok: false, reason: 'invoice could not be decoded' };
  }
  if (info.paymentHash.toLowerCase() !== opts.recipientPaymentHash.toLowerCase()) {
    return { ok: false, reason: 'invoice was not issued by the recipient' };
  }
  if (info.amountMsats !== opts.amountSats * 1000) {
    return { ok: false, reason: 'invoice amount does not match the contribution' };
  }
  if (!preimageMatches(receipt.preimage, info.paymentHash)) {
    return { ok: false, reason: 'preimage does not match the payment hash' };
  }
  return { ok: true };
}
