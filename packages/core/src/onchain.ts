import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** How a group's contributions are paid. Lightning is the default. */
export type Rail = 'lightning' | 'onchain';

/** The part of an Esplora transaction needed to recognise a contribution. */
export interface ChainTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number };
  vout: { scriptpubkey: string; scriptpubkey_address?: string; value: number }[];
}

const TAG_BYTES = 8;

/**
 * A short fingerprint of "this member pays this round of this group". The payer puts it in an OP_RETURN
 * output of their payment, which is how the coordinator knows who paid when many members send to the
 * same address. It can't be copied onto someone else's transaction, because it is inside that transaction.
 */
export function paymentTag(groupId: string, round: number, payer: string): string {
  return bytesToHex(sha256(utf8ToBytes(`ajo:${groupId}:${round}:${payer}`)).slice(0, TAG_BYTES));
}

/** The script of the OP_RETURN output that carries a payment tag (hex). */
export const tagScript = (tag: string) => `6a${TAG_BYTES.toString(16).padStart(2, '0')}${tag}`;

export interface FindArgs {
  txs: ChainTx[];
  recipientAddress: string;
  amountSats: number;
  groupId: string;
  round: number;
  payers: string[];
  /** Height of the latest block; used to count confirmations. */
  tip: number;
  minConfirmations: number;
}

/**
 * The payers whose contribution is on the chain: a transaction with enough confirmations that pays the
 * recipient's address at least the contribution and carries that payer's tag for this round. Returns the txid by payer.
 */
export function findOnchainPayments(args: FindArgs): Record<string, string> {
  const found: Record<string, string> = {};
  for (const payer of args.payers) {
    const script = tagScript(paymentTag(args.groupId, args.round, payer));
    for (const tx of args.txs) {
      const confirmations = tx.status.confirmed && tx.status.block_height ? args.tip - tx.status.block_height + 1 : 0;
      if (confirmations < args.minConfirmations) continue;
      const pays = tx.vout.some((o) => o.scriptpubkey_address === args.recipientAddress && o.value >= args.amountSats);
      if (pays && tx.vout.some((o) => o.scriptpubkey === script)) { found[payer] = tx.txid; break; }
    }
  }
  return found;
}
