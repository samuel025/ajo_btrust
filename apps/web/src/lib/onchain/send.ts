import * as btc from '@scure/btc-signer';
import { checkAddress, type Account } from './keys';
import type { NetworkConfig } from './network';
import type { WalletUtxo } from './scan';

/** Below this an output is "dust": the network won't relay it. For a native SegWit output. */
export const DUST_SATS = 294;

export class SendError extends Error {
  constructor(readonly code: 'amount' | 'dust' | 'insufficient' | 'fee', message: string) { super(message); }
}

/** The size of a transaction with `inputs` and `outputs` native SegWit entries, in virtual bytes. */
export const vsizeOf = (inputs: number, outputs: number, extra = 0) => Math.ceil(10.5 + 68 * inputs + 31 * outputs + extra);
/** An OP_RETURN output carrying an 8-byte payment tag: 8 (amount) + 1 (script length) + 10 (script). */
export const TAG_OUTPUT_VBYTES = 19;
const feeFor = (inputs: number, outputs: number, rate: number, extra = 0) => Math.ceil(vsizeOf(inputs, outputs, extra) * rate);

export interface Plan {
  inputs: WalletUtxo[];
  toSats: number;
  /** Zero when there is no change output. */
  changeSats: number;
  feeSats: number;
  feeRate: number;
  vsize: number;
}

/**
 * Chooses which coins to spend and works out the fee and change. Only confirmed coins are spent. With
 * `sendAll` the whole balance goes out, less the fee. Change too small to be worth keeping is added to the fee.
 */
export function planSend(args: { utxos: WalletUtxo[]; amountSats?: number; feeRate: number; sendAll?: boolean; tagged?: boolean }): Plan {
  const { feeRate, sendAll } = args;
  const extra = args.tagged ? TAG_OUTPUT_VBYTES : 0;
  if (!(feeRate >= 1) || feeRate > 1000) throw new SendError('fee', 'That fee rate is not sensible.');
  const spendable = args.utxos.filter((u) => u.confirmed).sort((a, b) => b.value - a.value);
  const total = spendable.reduce((n, u) => n + u.value, 0);

  if (sendAll) {
    const fee = feeFor(spendable.length, 1, feeRate, extra);
    const to = total - fee;
    if (!spendable.length || to < DUST_SATS) throw new SendError('insufficient', 'There is not enough confirmed Bitcoin to send after the fee.');
    return { inputs: spendable, toSats: to, changeSats: 0, feeSats: fee, feeRate, vsize: vsizeOf(spendable.length, 1, extra) };
  }

  const amount = args.amountSats ?? 0;
  if (!Number.isInteger(amount) || amount <= 0) throw new SendError('amount', 'Enter the amount as a whole number of sats.');
  if (amount < DUST_SATS) throw new SendError('dust', `The amount is too small for the network to carry (at least ${DUST_SATS} sats).`);

  const picked: WalletUtxo[] = [];
  let sum = 0;
  for (const u of spendable) {
    picked.push(u);
    sum += u.value;
    const withChange = feeFor(picked.length, 2, feeRate, extra);
    if (sum >= amount + withChange) {
      const change = sum - amount - withChange;
      if (change >= DUST_SATS) return { inputs: picked, toSats: amount, changeSats: change, feeSats: withChange, feeRate, vsize: vsizeOf(picked.length, 2, extra) };
    }
    const noChange = feeFor(picked.length, 1, feeRate, extra);
    if (sum >= amount + noChange) {
      // what is left over is too small to keep as change, so it goes to the miner
      return { inputs: picked, toSats: amount, changeSats: 0, feeSats: sum - amount, feeRate, vsize: vsizeOf(picked.length, 1, extra) };
    }
  }
  const everything = args.utxos.reduce((n, u) => n + u.value, 0);
  throw new SendError('insufficient', spendable.length < args.utxos.length && everything >= amount
    ? 'Some of your coins are still waiting for a confirmation. Try again in a minute.'
    : 'There is not enough confirmed Bitcoin to send that, including the fee.');
}

/** A last check against a mistake that would hand a large part of the money to a miner. */
export function assertSaneFee(plan: Plan) {
  if (plan.feeSats > 10_000 && plan.feeSats * 2 > plan.toSats) throw new SendError('fee', 'The fee would be more than half of what you are sending. Choose a slower fee.');
}

export interface Built { hex: string; txid: string; vsize: number; feeSats: number }

/** Builds and signs the transaction described by `plan`, optionally carrying a payment tag. Nothing is sent. */
export function buildTransaction(plan: Plan, to: string, changeAddress: string, account: Account, net: NetworkConfig, tag?: string): Built {
  checkAddress(to, net);
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  for (const u of plan.inputs) {
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: account.payment(u.chain, u.index).script, amount: BigInt(u.value) } });
  }
  tx.addOutputAddress(to, BigInt(plan.toSats), net.params);
  // The tag goes in an OP_RETURN output, which is how the group's coordinator knows who made this payment.
  if (tag) tx.addOutput({ script: btc.Script.encode(['RETURN', Uint8Array.from(tag.match(/../g)!.map((h) => parseInt(h, 16)))]), amount: 0n });
  if (plan.changeSats > 0) tx.addOutputAddress(changeAddress, BigInt(plan.changeSats), net.params);
  plan.inputs.forEach((u, i) => tx.signIdx(account.privateKey(u.chain, u.index), i));
  tx.finalize();
  if (Number(tx.fee) !== plan.feeSats) throw new Error('internal check failed: the fee does not match the plan');
  if (tx.vsize > plan.vsize + 2) throw new Error('internal check failed: the transaction is larger than planned');
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize, feeSats: plan.feeSats };
}
