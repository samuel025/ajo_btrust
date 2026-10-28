import { describe, expect, it } from 'vitest';
import bolt11 from 'bolt11';
import { invoiceStatus } from '../src/lib/invoice';

const key = 'ab'.repeat(32);
const make = (createdAt: number, expiry: number) =>
  bolt11.sign(bolt11.encode({
    satoshis: 1000, timestamp: createdAt,
    tags: [
      { tagName: 'payment_hash', data: '01'.repeat(32) },
      { tagName: 'expire_time', data: expiry },
      { tagName: 'description', data: 'x' },
      { tagName: 'payment_secret', data: '02'.repeat(32) },
    ],
  }), key).paymentRequest!;

describe('invoiceStatus', () => {
  const at = 1_800_000_000;
  it('is ready until the invoice expires, then expired', () => {
    const invoice = make(at, 3600);
    expect(invoiceStatus(invoice, at)).toBe('ready');
    expect(invoiceStatus(invoice, at + 3599)).toBe('ready');
    expect(invoiceStatus(invoice, at + 3600)).toBe('expired');
  });
  it('treats something it cannot read as payable rather than hiding it', () => {
    expect(invoiceStatus('not an invoice', at)).toBe('ready');
  });
});
