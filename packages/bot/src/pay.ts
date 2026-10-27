import { NWCClient } from '@getalby/sdk';

/** Pays a BOLT11 invoice through a member's NWC connection and returns the preimage. */
export async function payInvoice(nwcUrl: string, invoice: string): Promise<{ preimage: string }> {
  const client = new NWCClient({ nostrWalletConnectUrl: nwcUrl });
  try {
    const { preimage } = await client.payInvoice({ invoice });
    return { preimage };
  } finally {
    client.close();
  }
}
