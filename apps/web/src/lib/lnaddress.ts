import { lightningAddressUrl } from '@ajo/core';

/** What looking up a Lightning address showed. */
export type AddressCheck =
  | { kind: 'ok' }
  /** The address is definitely wrong or can't take this payment; `message` says why in plain words. */
  | { kind: 'bad'; message: string }
  /** The lookup got no answer. This can be a typo in the address, a server that is down, or a browser restriction, so the person may continue. */
  | { kind: 'unreachable'; message: string };

type Lookup = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Tries a Lightning address the way a payer's wallet will, so a typo is caught when joining and not after the round is stuck. */
export async function checkLightningAddress(address: string, amountSats?: number, lookup: Lookup = fetch, timeoutMs = 8000): Promise<AddressCheck> {
  let url: string;
  try { url = lightningAddressUrl(address.trim()); } catch { return { kind: 'bad', message: 'Enter an address like name@wallet.com' }; }
  const domain = address.trim().split('@')[1]!;

  let response;
  try {
    response = await lookup(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { kind: 'unreachable', message: `Couldn't reach ${domain} to check this address. Look for a typo in the part after the @. If it is right, you can continue anyway.` };
  }
  if (!response.ok) {
    return { kind: 'bad', message: response.status === 404 ? `${domain} has no such address. Check the spelling of the part before the @.` : `${domain} answered with an error (${response.status}) when asked about this address.` };
  }
  let meta: { status?: string; reason?: string; tag?: string; callback?: string; minSendable?: number; maxSendable?: number };
  try { meta = (await response.json()) as typeof meta; } catch { return { kind: 'bad', message: `${domain} doesn't answer like a Lightning address provider.` }; }
  if (meta.status === 'ERROR') return { kind: 'bad', message: meta.reason ? `${domain} says: ${meta.reason}` : `${domain} says this address isn't valid.` };
  if (meta.tag !== 'payRequest' || typeof meta.callback !== 'string') return { kind: 'bad', message: `That isn't a Lightning address that can receive payments.` };
  if (amountSats !== undefined && typeof meta.minSendable === 'number' && typeof meta.maxSendable === 'number') {
    const msats = amountSats * 1000;
    if (msats < meta.minSendable || msats > meta.maxSendable) {
      return { kind: 'bad', message: `This address can't receive ${amountSats.toLocaleString('en')} sats: it accepts ${Math.ceil(meta.minSendable / 1000).toLocaleString('en')} to ${Math.floor(meta.maxSendable / 1000).toLocaleString('en')} sats.` };
    }
  }
  return { kind: 'ok' };
}
