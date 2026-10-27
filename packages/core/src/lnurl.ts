export interface PayInvoice {
  invoice: string;
  /** LNURL-pay `verify` URL, if the recipient's wallet offers one. */
  verifyUrl?: string;
}

type Fetch = typeof fetch;

export function lightningAddressUrl(address: string): string {
  const [name, domain, ...rest] = address.split('@');
  if (!name || !domain || rest.length) throw new Error(`invalid Lightning address: ${address}`);
  // Plain http is only for local development servers.
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain);
  return `${local ? 'http' : 'https'}://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
}

/** Fetches a fresh invoice for `amountSats` from the recipient's Lightning address (LNURL-pay). */
export async function fetchInvoice(
  address: string,
  amountSats: number,
  fetchImpl: Fetch = fetch,
): Promise<PayInvoice> {
  const meta = await (await fetchImpl(lightningAddressUrl(address))).json();
  if (meta.status === 'ERROR' || !meta.callback) throw new Error(meta.reason ?? 'LNURL-pay lookup failed');
  const msats = amountSats * 1000;
  if (msats < meta.minSendable || msats > meta.maxSendable) {
    throw new Error('amount is outside what the recipient accepts');
  }
  const url = new URL(meta.callback);
  url.searchParams.set('amount', String(msats));
  const res = await (await fetchImpl(url)).json();
  if (res.status === 'ERROR' || !res.pr) throw new Error(res.reason ?? 'recipient returned no invoice');
  return { invoice: res.pr, verifyUrl: res.verify };
}
