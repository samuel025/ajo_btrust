import { NWCClient } from '@getalby/sdk';

const CONNECT_ATTEMPTS = 3;

/**
 * Pays a BOLT11 invoice through the member's own wallet (NWC) and returns the preimage.
 * Only failures to reach the wallet's relay are retried: nothing has been sent at that point,
 * so a retry can't pay twice. Any other error is surfaced as is.
 */
export async function payInvoice(nwcUrl: string, invoice: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const client = new NWCClient({ nostrWalletConnectUrl: nwcUrl });
    try {
      return (await client.payInvoice({ invoice })).preimage;
    } catch (e) {
      const connectFailure = /failed to connect/i.test(String((e as Error)?.message));
      if (!connectFailure || attempt >= CONNECT_ATTEMPTS) throw e;
    } finally {
      client.close();
    }
  }
}

const NOT_PAID_CODES = new Set(['QUOTA_EXCEEDED', 'INSUFFICIENT_BALANCE', 'RESTRICTED', 'UNAUTHORIZED', 'NOT_IMPLEMENTED', 'PAYMENT_FAILED', 'RATE_LIMITED', 'NOT_FOUND']);

/** True when the wallet certainly did not pay: it refused, or never received the request. A timeout leaves the outcome unknown. */
export function isDefinitelyNotPaid(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return (!!e?.code && NOT_PAID_CODES.has(e.code)) || /failed to connect/i.test(String(e?.message ?? ''));
}
