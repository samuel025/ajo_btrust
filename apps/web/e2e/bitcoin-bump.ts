// Replace-by-fee on the real Mutinynet signet: send a tagged payment at the lowest fee, replace it with a
// faster one before it is mined, and check that the network accepted the replacement and mined only that one.
// Needs ONCHAIN_TEST_MNEMONIC with a few hundred confirmed test sats. Costs only network fees.
import { Account, Esplora, chosenNetwork, scanWallet, seedFromMnemonic } from '../src/lib/onchain/index';
import { buildBump, buildTransaction, planBump, planSend } from '../src/lib/onchain/send';

const mnemonic = process.env.ONCHAIN_TEST_MNEMONIC;
if (!mnemonic) throw new Error('set ONCHAIN_TEST_MNEMONIC');
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log('ok  ', msg); };
const net = chosenNetwork({});
const api = new Esplora(net.esplora);
const account = new Account(seedFromMnemonic(mnemonic), net);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const before = await scanWallet(account, api);
check(before.confirmedSats >= 1500, `the wallet holds ${before.confirmedSats} confirmed sats (needs 1,500)`);

// 1. a payment to the wallet's own next address at the lowest fee
const target = account.address(0, before.nextReceive);
const plan = planSend({ utxos: before.utxos, amountSats: 600, feeRate: 1, tagged: true });
const first = buildTransaction(plan, target, account.address(1, before.nextChange), account, net, 'a1b2c3d4e5f60718');
await api.broadcast(first.hex);
console.log(`sent ${first.txid} at ${plan.feeRate} sat/vB (fee ${plan.feeSats})`);

// 2. look at it as the block explorer does, and replace it with a faster one
let view;
for (let i = 0; i < 10 && !view; i++) { view = (await scanWallet(account, api)).raw[first.txid]; if (!view) await new Promise((r) => setTimeout(r, 1500)); }
check(!!view && !view.status.confirmed, 'the payment is waiting in the mempool');
const now = await scanWallet(account, api);
const bump = planBump({
  original: now.raw[first.txid]!, owned: now.owned, spare: now.utxos, feeRate: 6,
  changeTo: { chain: 1, index: now.nextChange, script: toHex(account.payment(1, now.nextChange).script) },
});
check(bump.feeSats > plan.feeSats, `the replacement pays a higher fee (${plan.feeSats} → ${bump.feeSats})`);
const second = buildBump(bump, account, net);
await api.broadcast(second.hex);
check(second.txid !== first.txid, `the network accepted the replacement ${second.txid}`);

// 3. only the replacement gets mined
let mined = false;
for (let i = 0; i < 40 && !mined; i++) {
  const snap = await scanWallet(account, api);
  mined = !!snap.raw[second.txid]?.status.confirmed;
  if (!mined) await new Promise((r) => setTimeout(r, 5000));
}
check(mined, 'the replacement was mined into a block');
const after = await scanWallet(account, api);
check(!after.raw[first.txid], 'the original payment is gone from the wallet\'s history');
const tagged = after.raw[second.txid]!.vout.some((o) => o.scriptpubkey === '6a08a1b2c3d4e5f60718');
check(tagged, 'the replacement still carries the payment tag');
