import { NWCClient } from '@getalby/sdk';

/* ---------- connecting a wallet with one click (the wallet asks the person to approve) ---------- */

/** What the app asks the wallet to allow. Paying is the one that matters; the person can narrow it in their wallet. */
export const REQUEST_METHODS = ['get_info', 'get_balance', 'make_invoice', 'lookup_invoice', 'pay_invoice', 'list_transactions', 'get_budget'] as const;

/**
 * The address of the page where a wallet (for example Alby Hub) asks the person to approve a new app, from
 * whatever they typed: "my.albyhub.com", "https://my.albyhub.com/" or "localhost:8080". Throws a message for the person.
 */
export function hubAuthorizationUrl(input: string): string {
  const typed = input.trim();
  if (!typed) throw new Error('Enter the address of your wallet, for example my.albyhub.com');
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(typed);
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(typed) ? typed : `${local ? 'http' : 'https'}://${typed}`); } catch { throw new Error("That doesn't look like a web address."); }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) throw new Error('Use the secure address of your wallet (it starts with https://).');
  if (url.hash.includes('/')) throw new Error("That address can't be used. Use the plain address of your wallet.");
  return `${url.origin}/apps/new`;
}

/** Opens the wallet's approval page and returns the wallet connection once the person approves it. */
export async function connectWithHub(hubAddress: string, appName = 'Bitcoin Ajo'): Promise<string> {
  const base = hubAuthorizationUrl(hubAddress);
  try {
    const client = await NWCClient.fromAuthorizationUrl(base, { name: appName, requestMethods: [...REQUEST_METHODS] });
    try { return client.getNostrWalletConnectUrl(true); } finally { client.close(); }
  } catch (e) {
    throw new Error(describeConnectError(e));
  }
}

export function describeConnectError(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (/failed to execute window\.open/i.test(message)) return 'Your browser blocked the wallet window. Allow pop-ups for this site and try again.';
  if (/popup closed/i.test(message)) return 'The wallet window was closed before you approved. Try again and press Approve in your wallet.';
  if (/relayUrl|walletPubkey/i.test(message)) return "The wallet didn't send back a usable connection. Make sure it is a recent version of the wallet.";
  return message;
}

/* ---------- a Lightning wallet in the browser (WebLN: a browser extension such as Alby's) ---------- */

export interface WebLN {
  enable(): Promise<void>;
  sendPayment(invoice: string): Promise<{ preimage: string }>;
}

export const weblnProvider = (): WebLN | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { webln?: WebLN }).webln);

/** Pays through the browser extension; the extension asks the person to approve. Returns the payment proof. */
export async function payWithExtension(invoice: string): Promise<string> {
  const provider = weblnProvider();
  if (!provider) throw new Error('No Lightning wallet extension was found in this browser.');
  try {
    await provider.enable();
    const { preimage } = await provider.sendPayment(invoice);
    if (!/^[0-9a-f]{64}$/i.test(preimage ?? '')) throw new Error('The wallet paid but did not return a payment proof.');
    return preimage.toLowerCase();
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (/reject|denied|cancel|declin|user closed/i.test(message)) throw new Error('You declined the payment in your wallet.');
    throw e instanceof Error ? e : new Error(message);
  }
}
