import { createServer, type Server } from 'node:http';
import { NWCClient } from '@getalby/sdk';

/**
 * Development stand-in for a Lightning address on a test network: serves LNURL-pay for any
 * name and makes the invoices through one NWC connection (the recipient's wallet).
 */
export function devLnurlServer(nwcUrl: string, port: number, options: { expirySeconds?: number } = {}): Promise<Server> {
  const wallet = new NWCClient({ nostrWalletConnectUrl: nwcUrl });
  const origin = `http://localhost:${port}`;
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const lookup = url.pathname.match(/^\/\.well-known\/lnurlp\/([^/]+)$/);
    if (lookup) {
      return send(res, 200, {
        tag: 'payRequest',
        callback: `${origin}/pay/${lookup[1]}`,
        minSendable: 1_000,
        maxSendable: 1_000_000_000,
        metadata: JSON.stringify([['text/plain', `Payment to ${lookup[1]}`]]),
      });
    }
    if (url.pathname.startsWith('/pay/')) {
      const amount = Number(url.searchParams.get('amount'));
      if (!Number.isInteger(amount) || amount < 1_000) {
        return send(res, 400, { status: 'ERROR', reason: 'invalid amount' });
      }
      try {
        const { invoice, payment_hash: hash } = await wallet.makeInvoice({ amount, description: 'ajo contribution', ...(options.expirySeconds ? { expiry: options.expirySeconds } : {}) });
        return send(res, 200, { pr: invoice, routes: [], verify: `${origin}/verify/${hash}` });
      } catch (e) {
        return send(res, 502, { status: 'ERROR', reason: (e as Error).message });
      }
    }
    const verify = url.pathname.match(/^\/verify\/([0-9a-f]{64})$/);
    if (verify) {
      try {
        const found = await wallet.lookupInvoice({ payment_hash: verify[1] });
        const settled = found.state === 'settled';
        return send(res, 200, { status: 'OK', settled, preimage: settled ? found.preimage : null, pr: found.invoice });
      } catch (e) {
        return send(res, 200, { status: 'ERROR', reason: (e as Error).message });
      }
    }
    send(res, 404, { status: 'ERROR', reason: 'not found' });
  });
  server.on('close', () => wallet.close());
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
