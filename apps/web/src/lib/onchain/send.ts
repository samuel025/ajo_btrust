import * as btc from '@scure/btc-signer';
import { checkAddress, type Account, type Chain } from './keys';
import type { NetworkConfig } from './network';
import type { EsploraTx } from './esplora';
import type { Snapshot, WalletUtxo } from './scan';

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

/** Signals that the payment may be replaced by one with a higher fee (BIP 125). Without it a stuck payment can't be sped up. */
export const RBF_SEQUENCE = 0xfffffffd;

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
    tx.addInput({ txid: u.txid, index: u.vout, sequence: RBF_SEQUENCE, witnessUtxo: { script: account.payment(u.chain, u.index).script, amount: BigInt(u.value) } });
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

/* ---------- speeding up a payment that is stuck ---------- */

export interface BumpInput { txid: string; vout: number; value: number; chain: Chain; index: number }
export interface BumpOutput { script: string; value: number; /** The wallet's own change output; its amount pays for the higher fee. */ change?: { chain: Chain; index: number } }
export interface BumpPlan { inputs: BumpInput[]; outputs: BumpOutput[]; feeSats: number; oldFeeSats: number; feeRate: number; vsize: number }

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
const outputBytes = (script: string) => 9 + script.length / 2; // 8 amount + 1 length + script

/**
 * Works out a replacement for a payment of the wallet's that hasn't been mined: the same payment to the same
 * place, with a higher fee taken from the change (or from more coins if the change is too small). The
 * replacement spends the same coins, which is what lets the network swap it in.
 */
export function planBump(args: { original: EsploraTx; owned: Snapshot['owned']; spare: WalletUtxo[]; feeRate: number; /** Where change goes if the original had none. */ changeTo: { chain: Chain; index: number; script: string } }): BumpPlan {
  const { original, owned, spare, feeRate } = args;
  if (original.status.confirmed) throw new SendError('fee', 'That payment is already confirmed, so it does not need speeding up.');
  if (!(feeRate >= 1) || feeRate > 1000) throw new SendError('fee', 'That fee rate is not sensible.');
  const inputs: BumpInput[] = original.vin.map((i) => {
    const address = i.prevout?.scriptpubkey_address;
    const mine = address ? owned[address] : undefined;
    if (!i.prevout || !mine) throw new SendError('fee', 'That payment was not made from this wallet, so it cannot be sped up here.');
    return { txid: i.txid, vout: i.vout, value: i.prevout.value, ...mine };
  });
  const outputs: BumpOutput[] = original.vout.map((o) => {
    const mine = o.scriptpubkey_address ? owned[o.scriptpubkey_address] : undefined;
    if (!o.scriptpubkey) throw new SendError('fee', 'The block explorer did not give enough detail about that payment.');
    return { script: o.scriptpubkey, value: o.value, ...(mine && mine.chain === 1 ? { change: mine } : {}) };
  });
  const oldFee = inputs.reduce((n, i) => n + i.value, 0) - outputs.reduce((n, o) => n + o.value, 0);
  const fixedBytes = outputs.filter((o) => !o.change).reduce((n, o) => n + outputBytes(o.script), 0);
  const fixedTotal = outputs.filter((o) => !o.change).reduce((n, o) => n + o.value, 0);
  const changeOut = outputs.find((o) => o.change);
  const changeScript = changeOut?.script ?? args.changeTo.script;
  const all: BumpInput[] = [...inputs];
  const unspent = spare.filter((u) => u.confirmed && !inputs.some((i) => i.txid === u.txid && i.vout === u.vout)).sort((a, b) => b.value - a.value);
  // the network wants the new fee to exceed the old one by at least the cost of relaying the new transaction (1 sat per byte)
  const need = (vsize: number) => Math.max(Math.ceil(vsize * feeRate), oldFee + vsize);

  for (;;) {
    const have = all.reduce((n, i) => n + i.value, 0) - fixedTotal;
    const base = 10.5 + 68 * all.length + fixedBytes;
    const sizeWith = Math.ceil(base + outputBytes(changeScript));
    const sizeWithout = Math.ceil(base);
    if (have - need(sizeWith) >= DUST_SATS) {
      const change = have - need(sizeWith);
      const built: BumpOutput[] = changeOut
        ? outputs.map((o) => (o.change ? { ...o, value: change } : o))
        : [...outputs, { script: changeScript, value: change, change: { chain: args.changeTo.chain, index: args.changeTo.index } }];
      return { inputs: all, outputs: built, feeSats: need(sizeWith), oldFeeSats: oldFee, feeRate, vsize: sizeWith };
    }
    if (have >= need(sizeWithout)) {
      // too little would be left to keep as change: it goes to the miners
      return { inputs: all, outputs: outputs.filter((o) => !o.change), feeSats: have, oldFeeSats: oldFee, feeRate, vsize: sizeWithout };
    }
    const next = unspent.shift();
    if (!next) throw new SendError('insufficient', 'There is not enough confirmed Bitcoin to pay a higher fee for this payment.');
    all.push({ txid: next.txid, vout: next.vout, value: next.value, chain: next.chain, index: next.index });
  }
}

/** Builds and signs the replacement described by `plan`. Nothing is sent. */
export function buildBump(plan: BumpPlan, account: Account, net: NetworkConfig): Built {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  for (const u of plan.inputs) tx.addInput({ txid: u.txid, index: u.vout, sequence: RBF_SEQUENCE, witnessUtxo: { script: account.payment(u.chain, u.index).script, amount: BigInt(u.value) } });
  for (const o of plan.outputs) tx.addOutput({ script: hexBytes(o.script), amount: BigInt(o.value) });
  plan.inputs.forEach((u, i) => tx.signIdx(account.privateKey(u.chain, u.index), i));
  tx.finalize();
  if (Number(tx.fee) !== plan.feeSats) throw new Error('internal check failed: the fee does not match the plan');
  void net;
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize, feeSats: plan.feeSats };
}
