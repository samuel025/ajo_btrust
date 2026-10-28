import { NWCClient } from '@getalby/sdk';

/* ---------- connecting a wallet with one click (the wallet asks the person to approve) ---------- */

/**
 * Where the one-click "Connect with Alby" button sends people: the address of Alby's hosted wallet. Change it with
 * VITE_HOSTED_WALLET_URL. In development it points at the local hub, so the button can be tried without Alby's servers.
 */
export const HOSTED_WALLET: string = import.meta.env.VITE_HOSTED_WALLET_URL ?? (import.meta.env.DEV ? 'localhost:8080' : 'https://my.albyhub.com');

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

/** The payment definitely did not happen (no wallet, or the person declined). Anything else leaves the outcome unknown. */
export class NotPaidError extends Error {}

/**
 * Pays through the browser extension; the extension asks the person to approve. Resolves once the wallet says it paid,
 * with the payment proof if it gave one. It throws NotPaidError only when it is certain nothing was paid; any other error
 * means the outcome is unknown, so the caller must not offer to pay again without the person checking their wallet.
 */
export async function payWithExtension(invoice: string): Promise<{ preimage?: string }> {
  const provider = weblnProvider();
  if (!provider) throw new NotPaidError('No Lightning wallet extension was found in this browser.');
  try {
    await provider.enable();
  } catch (e) {
    throw new NotPaidError(/reject|denied|cancel|declin|user closed/i.test(String((e as Error)?.message ?? e)) ? 'You declined to connect your wallet.' : "Your wallet extension couldn't be opened.");
  }
  let result: { preimage?: string } | undefined;
  try {
    result = await provider.sendPayment(invoice);
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (/reject|denied|cancel|declin|user closed/i.test(message)) throw new NotPaidError('You declined the payment in your wallet.');
    throw new Error(`Your wallet didn't say whether the payment went through (${message}).`);
  }
  // The wallet said it paid. A missing or odd proof does not undo that.
  const preimage = typeof result?.preimage === 'string' && /^[0-9a-f]{64}$/i.test(result.preimage) ? result.preimage.toLowerCase() : undefined;
  return { preimage };
}
