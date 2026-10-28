import * as btc from '@scure/btc-signer';

export type BtcNetwork = 'signet' | 'testnet' | 'mainnet';

export interface NetworkConfig {
  name: BtcNetwork;
  /** Address encoding rules from the signing library. Signet and testnet share them. */
  params: typeof btc.NETWORK;
  /** BIP-44 coin type: 0 for the real network, 1 for every test network. */
  coinType: 0 | 1;
  /** An Esplora block-explorer API, which the wallet reads the chain through. */
  esplora: string;
  /** A human-facing explorer, for a link to a transaction. */
  explorer: string;
  testCoins: boolean;
  faucet?: string;
}

export const NETWORKS: Record<BtcNetwork, NetworkConfig> = {
  signet: { name: 'signet', params: btc.TEST_NETWORK, coinType: 1, esplora: 'https://mutinynet.com/api', explorer: 'https://mutinynet.com', testCoins: true, faucet: 'https://faucet.mutinynet.com' },
  testnet: { name: 'testnet', params: btc.TEST_NETWORK, coinType: 1, esplora: 'https://blockstream.info/testnet/api', explorer: 'https://blockstream.info/testnet', testCoins: true },
  mainnet: { name: 'mainnet', params: btc.NETWORK, coinType: 0, esplora: 'https://blockstream.info/api', explorer: 'https://blockstream.info', testCoins: false },
};

/**
 * The network the wallet runs on. It defaults to the Mutinynet test network. The real network must be
 * switched on explicitly, because this wallet has only been tested with test coins.
 */
export function chosenNetwork(env: { network?: string; allowMainnet?: string } = {}): NetworkConfig {
  const wanted = (env.network ?? 'signet') as BtcNetwork;
  if (!(wanted in NETWORKS)) throw new Error(`unknown Bitcoin network "${env.network}"`);
  if (wanted === 'mainnet' && env.allowMainnet !== '1') {
    throw new Error('The real Bitcoin network is switched off. This wallet has only been tested with test coins.');
  }
  return NETWORKS[wanted];
}
