import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import type { NetworkConfig } from './network';

export type Chain = 0 | 1; // 0: addresses people pay you at, 1: change addresses

/** A BIP-84 account (native SegWit, addresses starting bc1q / tb1q) derived from a seed. */
export class Account {
  private root: HDKey;
  constructor(seed: Uint8Array, readonly net: NetworkConfig) {
    this.root = HDKey.fromMasterSeed(seed);
  }

  private node(chain: Chain, index: number): HDKey {
    return this.root.derive(`m/84'/${this.net.coinType}'/0'/${chain}/${index}`);
  }

  publicKey(chain: Chain, index: number): Uint8Array {
    return this.node(chain, index).publicKey!;
  }

  privateKey(chain: Chain, index: number): Uint8Array {
    const key = this.node(chain, index).privateKey;
    if (!key) throw new Error('no private key for that path');
    return key;
  }

  payment(chain: Chain, index: number) {
    return btc.p2wpkh(this.publicKey(chain, index), this.net.params);
  }

  address(chain: Chain, index: number): string {
    return this.payment(chain, index).address!;
  }
}

/** Throws unless `address` is valid on this network. Returns it unchanged. */
export function checkAddress(address: string, net: NetworkConfig): string {
  try {
    btc.Address(net.params).decode(address.trim());
    return address.trim();
  } catch {
    throw new Error(`That is not a valid ${net.testCoins ? 'test-network' : ''} Bitcoin address.`.replace('  ', ' '));
  }
}
