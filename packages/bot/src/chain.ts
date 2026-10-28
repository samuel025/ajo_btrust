import type { ChainTx } from '@ajo/core';
import type { ChainView } from './engine';

/** Reads the blockchain through an Esplora server (the API behind mempool.space and Mutinynet's explorer). */
export function esploraChain(baseUrl: string, fetcher: typeof fetch = fetch): ChainView {
  const base = baseUrl.replace(/\/+$/, '');
  const get = async (path: string) => {
    const response = await fetcher(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`the blockchain server answered ${response.status} for ${path}`);
    return response;
  };
  return {
    // The newest transactions of the address (unconfirmed first); enough for the payments of one round.
    async txs(address) {
      return (await (await get(`/address/${encodeURIComponent(address)}/txs`)).json()) as ChainTx[];
    },
    async tip() {
      const height = Number(await (await get('/blocks/tip/height')).text());
      if (!Number.isInteger(height) || height < 0) throw new Error('the blockchain server gave a strange block height');
      return height;
    },
  };
}
