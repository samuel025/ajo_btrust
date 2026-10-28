import type { Account, Chain } from './keys';
import type { Esplora, EsploraTx } from './esplora';

export interface WalletUtxo { txid: string; vout: number; value: number; confirmed: boolean; chain: Chain; index: number; address: string }
export interface WalletTx { txid: string; /** Positive when money came in, negative when it went out (including the fee). */ netSats: number; confirmed: boolean; blockHeight?: number; time?: number }
export interface Snapshot {
  utxos: WalletUtxo[];
  txs: WalletTx[];
  confirmedSats: number;
  pendingSats: number;
  /** The first receive address that has never been used. */
  nextReceive: number;
  nextChange: number;
  tip: number;
}

/** How many unused addresses in a row mean "there is nothing further along". Wallets agree on this rule. */
export const GAP_LIMIT = 10;

const used = (s: { chain_stats: { tx_count: number }; mempool_stats: { tx_count: number } }) => s.chain_stats.tx_count + s.mempool_stats.tx_count > 0;

/** Finds the addresses of one chain that have ever been used, scanning until `gap` unused ones in a row. */
async function discover(account: Account, api: Esplora, chain: Chain, gap: number): Promise<{ indexes: number[]; next: number }> {
  const indexes: number[] = [];
  let start = 0;
  let highest = -1;
  for (;;) {
    const batch = Array.from({ length: gap }, (_, k) => start + k);
    const stats = await Promise.all(batch.map((i) => api.address(account.address(chain, i))));
    const hits = batch.filter((_, k) => used(stats[k]!));
    if (!hits.length) break;
    indexes.push(...hits);
    highest = hits[hits.length - 1]!;
    start = highest + 1;
  }
  return { indexes, next: highest + 1 };
}

function netOf(tx: EsploraTx, ours: Set<string>): number {
  const received = tx.vout.filter((o) => o.scriptpubkey_address && ours.has(o.scriptpubkey_address)).reduce((n, o) => n + o.value, 0);
  const sent = tx.vin.filter((i) => i.prevout?.scriptpubkey_address && ours.has(i.prevout.scriptpubkey_address)).reduce((n, i) => n + i.prevout!.value, 0);
  return received - sent;
}

export async function scanWallet(account: Account, api: Esplora, gap = GAP_LIMIT): Promise<Snapshot> {
  const [external, change, tip] = await Promise.all([discover(account, api, 0, gap), discover(account, api, 1, gap), api.tipHeight()]);
  const owned = [
    ...external.indexes.map((index) => ({ chain: 0 as Chain, index })),
    ...change.indexes.map((index) => ({ chain: 1 as Chain, index })),
  ].map((o) => ({ ...o, address: account.address(o.chain, o.index) }));
  const ours = new Set(owned.map((o) => o.address));

  const found = await Promise.all(owned.map(async (o) => ({ o, utxos: await api.utxos(o.address), txs: await api.txs(o.address) })));

  const utxos: WalletUtxo[] = found.flatMap(({ o, utxos }) =>
    utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: u.status.confirmed, chain: o.chain, index: o.index, address: o.address })));

  const byId = new Map<string, EsploraTx>();
  for (const { txs } of found) for (const tx of txs) byId.set(tx.txid, tx);
  const txs: WalletTx[] = [...byId.values()]
    .map((tx) => ({ txid: tx.txid, netSats: netOf(tx, ours), confirmed: tx.status.confirmed, blockHeight: tx.status.block_height, time: tx.status.block_time }))
    .sort((a, b) => (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER));

  return {
    utxos,
    txs,
    confirmedSats: utxos.filter((u) => u.confirmed).reduce((n, u) => n + u.value, 0),
    pendingSats: utxos.filter((u) => !u.confirmed).reduce((n, u) => n + u.value, 0),
    nextReceive: external.next,
    nextChange: change.next,
    tip,
  };
}
