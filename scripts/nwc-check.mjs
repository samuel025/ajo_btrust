// Prints which node and balance each NWC connection in .env controls. Never prints the URLs.
import { NWCClient } from '@getalby/sdk';

for (const name of ['NWC_URL', 'NWC_PAYER', 'NWC_RECIPIENT']) {
  const url = process.env[name];
  if (!url) continue;
  const client = new NWCClient({ nostrWalletConnectUrl: url });
  try {
    const info = await client.getInfo();
    const balance = await client.getBalance().catch(() => undefined);
    console.log(name, '→ node', info.pubkey?.slice(0, 8), info.network, 'balance(msat):', balance?.balance, 'methods:', info.methods.join(','));
  } catch (e) {
    console.log(name, '→ failed:', e.message);
  } finally {
    client.close();
  }
}
