import { isExpired, parseInvoice } from '@ajo/core';

export type InvoiceStatus = 'ready' | 'expired';

/** Whether a Lightning invoice can still be paid. One that can't be read is treated as payable. */
export function invoiceStatus(invoice: string, nowSeconds: number): InvoiceStatus {
  try {
    return isExpired(parseInvoice(invoice), nowSeconds) ? 'expired' : 'ready';
  } catch {
    return 'ready';
  }
}
