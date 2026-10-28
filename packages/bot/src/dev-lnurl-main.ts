import { devLnurlServer } from './dev-lnurl-server';

const nwc = process.env.NWC_RECIPIENT;
const port = Number(process.env.LNURL_PORT ?? 3456);
if (!nwc) {
  console.error('Set NWC_RECIPIENT to the NWC connection of the wallet that should receive payments.');
  process.exit(1);
}
const expirySeconds = process.env.LNURL_INVOICE_EXPIRY ? Number(process.env.LNURL_INVOICE_EXPIRY) : undefined;
await devLnurlServer(nwc, port, { expirySeconds });
console.log(`Lightning addresses of the form <anything>@localhost:${port} now pay into that wallet.`);
