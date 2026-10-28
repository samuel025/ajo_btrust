/** Reading the blockchain, and sending a transaction to it, through an Esplora block-explorer API. */
export interface EsploraTx {
  txid: string;
  vin: { txid: string; vout: number; prevout?: { scriptpubkey_address?: string; value: number } }[];
  vout: { scriptpubkey_address?: string; value: number }[];
  fee?: number;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
}
export interface EsploraUtxo { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }
export interface AddressStats { chain_stats: { tx_count: number }; mempool_stats: { tx_count: number } }

export type FetchLike = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class Esplora {
  constructor(readonly base: string, private fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`);
    const body = await res.text();
    if (!res.ok) throw new Error(`The block explorer said: ${body.slice(0, 120) || res.status}`);
    return JSON.parse(body) as T;
  }

  address(address: string) { return this.get<AddressStats>(`/address/${address}`); }
  utxos(address: string) { return this.get<EsploraUtxo[]>(`/address/${address}/utxo`); }
  txs(address: string) { return this.get<EsploraTx[]>(`/address/${address}/txs`); }
  feeEstimates() { return this.get<Record<string, number>>('/fee-estimates'); }
  async tipHeight() { return Number(await (await this.fetchImpl(`${this.base}/blocks/tip/height`)).text()); }

  /** Sends a signed transaction to the network. Returns its id, or throws the network's reason in plain words. */
  async broadcast(hex: string): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/tx`, { method: 'POST', body: hex, headers: { 'Content-Type': 'text/plain' } });
    const body = (await res.text()).trim();
    if (!res.ok) throw new Error(describeBroadcastError(body));
    return body;
  }
}

/** The network's rejection reasons, in words a person can act on. */
export function describeBroadcastError(text: string): string {
  if (/min relay fee|insufficient fee|fee not met|too low/i.test(text)) return 'The network rejected it: the fee was too low. Try a faster fee.';
  if (/missingorspent|already spent|txn-mempool-conflict|bad-txns-inputs/i.test(text)) return 'The network rejected it: some of these coins were already spent. Refresh and try again.';
  if (/already in block chain|already known|txn-already/i.test(text)) return 'The network already has this transaction.';
  if (/dust/i.test(text)) return 'The network rejected it: the amount is too small.';
  return `The network rejected the transaction: ${text.slice(0, 160)}`;
}

/** A fee in sat/vB for confirming within roughly `target` blocks. Never below 1. */
export function pickFeeRate(estimates: Record<string, number>, target: number): number {
  const targets = Object.keys(estimates).map(Number).sort((a, b) => a - b);
  const chosen = targets.find((t) => t >= target) ?? targets[targets.length - 1];
  const rate = chosen === undefined ? 1 : estimates[String(chosen)]!;
  return Math.max(1, Math.ceil(rate * 10) / 10);
}
