import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { decode } from 'light-bolt11-decoder';

export interface InvoiceInfo {
  paymentHash: string;
  amountMsats: number | undefined;
}

export function parseInvoice(invoice: string): InvoiceInfo {
  const sections = decode(invoice).sections;
  const hash = sections.find((s) => s.name === 'payment_hash');
  if (!hash || !('value' in hash) || typeof hash.value !== 'string') {
    throw new Error('invoice has no payment hash');
  }
  const amount = sections.find((s) => s.name === 'amount');
  const amountMsats = amount && 'value' in amount ? Number(amount.value) : undefined;
  return { paymentHash: hash.value, amountMsats };
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
