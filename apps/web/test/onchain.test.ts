import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Account, checkAddress } from '../src/lib/onchain/keys';
import { NETWORKS, chosenNetwork } from '../src/lib/onchain/network';
import { checksPass, isValidMnemonic, newMnemonic, normalizeMnemonic, pickChecks, seedFromMnemonic } from '../src/lib/onchain/seed';
import { openMnemonic, sealMnemonic } from '../src/lib/onchain/vault';
import { Esplora, describeBroadcastError, pickFeeRate, type EsploraTx } from '../src/lib/onchain/esplora';
import { GAP_LIMIT, scanWallet } from '../src/lib/onchain/scan';
import { DUST_SATS, SendError, assertSaneFee, buildTransaction, planSend, vsizeOf } from '../src/lib/onchain/send';
import type { WalletUtxo } from '../src/lib/onchain/scan';

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

// The standard BIP-39 test phrase. Its BIP-84 addresses are published in the BIP, so they are a fixed target.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const main = NETWORKS.mainnet;
const signet = NETWORKS.signet;

describe('recovery phrase', () => {
  it('accepts a valid phrase and rejects a bad checksum or the wrong length', () => {
    expect(isValidMnemonic(PHRASE)).toBe(true);
    expect(isValidMnemonic(PHRASE.replace('about', 'abandon'))).toBe(false);
    expect(isValidMnemonic('abandon abandon abandon')).toBe(false);
    expect(isValidMnemonic('')).toBe(false);
  });

  it('is forgiving about how a phrase is pasted', () => {
    expect(normalizeMnemonic('  ABANDON   abandon\nabandon ')).toBe('abandon abandon abandon');
    expect(isValidMnemonic(`  ${PHRASE.toUpperCase()}\n`)).toBe(true);
  });

  it('generates a fresh, valid, twelve-word phrase each time', () => {
    const a = newMnemonic(), b = newMnemonic();
    expect(a.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('asks for three different words, in order, and checks the answers', () => {
    const picks = pickChecks(12);
    expect(new Set(picks).size).toBe(3);
    expect(picks).toEqual([...picks].sort((x, y) => x - y));
    const words = PHRASE.split(' ');
    expect(checksPass(PHRASE, [0, 5, 11], [words[0]!, words[5]!, words[11]!])).toBe(true);
    expect(checksPass(PHRASE, [0, 5, 11], ['abandon', 'abandon', 'abandon'])).toBe(false); // 'about' is word 12
    expect(checksPass(PHRASE, [], [])).toBe(false);
  });
});

describe('keys and addresses', () => {
  const account = new Account(seedFromMnemonic(PHRASE), main);

  it('derives the addresses published in BIP-84', () => {
    expect(account.address(0, 0)).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(account.address(0, 1)).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
    expect(account.address(1, 0)).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  });

  it('uses the test-network coin type and prefix for test coins', () => {
    expect(new Account(seedFromMnemonic(PHRASE), signet).address(0, 0)).toBe('tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl');
  });

  it('accepts addresses of its own network only', () => {
    expect(checkAddress(' tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl ', signet)).toBe('tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl');
    expect(() => checkAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', signet)).toThrow(/valid/);
    expect(() => checkAddress('tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl', main)).toThrow(/valid/);
    expect(() => checkAddress('not an address', signet)).toThrow(/valid/);
    expect(() => checkAddress('', signet)).toThrow();
  });
});

describe('which network', () => {
  it('defaults to the test network and refuses the real one unless switched on', () => {
    expect(chosenNetwork().name).toBe('signet');
    expect(() => chosenNetwork({ network: 'mainnet' })).toThrow(/switched off/);
    expect(chosenNetwork({ network: 'mainnet', allowMainnet: '1' }).name).toBe('mainnet');
    expect(() => chosenNetwork({ network: 'dogecoin' })).toThrow(/unknown/);
  });
});

describe('the encrypted vault', () => {
  it('opens with the right password and not with a wrong one', async () => {
    const record = await sealMnemonic(PHRASE, 'correct horse', 'signet', 1000);
    expect(await openMnemonic(record, 'correct horse')).toBe(PHRASE);
    await expect(openMnemonic(record, 'wrong horse')).rejects.toThrow('wrong password');
    await expect(openMnemonic(record, '')).rejects.toThrow('wrong password');
  });

  it('never stores the phrase in the clear, and differs on every save', async () => {
    const a = await sealMnemonic(PHRASE, 'pw', 'signet', 1000), b = await sealMnemonic(PHRASE, 'pw', 'signet', 1000);
    const text = JSON.stringify(a);
    for (const word of ['abandon', 'about']) expect(text).not.toContain(word);
    expect(a.data).not.toBe(b.data);
    expect(a.salt).not.toBe(b.salt);
  });

  it('notices tampering', async () => {
    const record = await sealMnemonic(PHRASE, 'pw', 'signet', 1000);
    const flipped = { ...record, data: (record.data[0] === 'A' ? 'B' : 'A') + record.data.slice(1) };
    await expect(openMnemonic(flipped, 'pw')).rejects.toThrow('wrong password');
  });
});

const utxo = (value: number, extra: Partial<WalletUtxo> = {}): WalletUtxo =>
  ({ txid: 'ab'.repeat(32), vout: 0, value, confirmed: true, chain: 0, index: 0, address: 'x', ...extra });

describe('choosing coins and the fee', () => {
  it('spends the fewest, largest coins that cover the amount and fee', () => {
    const plan = planSend({ utxos: [utxo(5_000, { vout: 0 }), utxo(50_000, { vout: 1 }), utxo(9_000, { vout: 2 })], amountSats: 20_000, feeRate: 2 });
    expect(plan.inputs.map((u) => u.value)).toEqual([50_000]);
    expect(plan.toSats).toBe(20_000);
    expect(plan.feeSats).toBe(Math.ceil(vsizeOf(1, 2) * 2));
    expect(plan.changeSats).toBe(50_000 - 20_000 - plan.feeSats);
  });

  it('never loses a sat: inputs = payment + change + fee', () => {
    for (const [coins, amount, rate] of [[[100_000], 1_000, 1], [[3_000, 4_000, 5_000], 9_000, 3], [[60_000, 60_000], 100_000, 10]] as const) {
      const plan = planSend({ utxos: coins.map((v, i) => utxo(v, { vout: i })), amountSats: amount, feeRate: rate });
      expect(plan.toSats + plan.changeSats + plan.feeSats).toBe(plan.inputs.reduce((n, u) => n + u.value, 0));
    }
  });

  it('adds change that is too small to keep to the fee instead of making a dust output', () => {
    const plan = planSend({ utxos: [utxo(10_000)], amountSats: 9_800, feeRate: 1 });
    expect(plan.changeSats).toBe(0);
    expect(plan.feeSats).toBe(10_000 - 9_800);
  });

  it('sends everything, less the fee', () => {
    const plan = planSend({ utxos: [utxo(30_000), utxo(20_000, { vout: 1 })], feeRate: 1, sendAll: true });
    expect(plan.inputs).toHaveLength(2);
    expect(plan.changeSats).toBe(0);
    expect(plan.toSats + plan.feeSats).toBe(50_000);
  });

  it('only spends confirmed coins, and says so when that is the problem', () => {
    const coins = [utxo(100_000, { confirmed: false })];
    expect(() => planSend({ utxos: coins, amountSats: 1_000, feeRate: 1 })).toThrow(SendError);
    expect(() => planSend({ utxos: coins, amountSats: 1_000, feeRate: 1 })).toThrow(/waiting for a confirmation/);
  });

  it.each([
    ['not enough', () => planSend({ utxos: [utxo(1_000)], amountSats: 5_000, feeRate: 1 }), 'insufficient'],
    ['nothing to spend', () => planSend({ utxos: [], amountSats: 5_000, feeRate: 1 }), 'insufficient'],
    ['too small', () => planSend({ utxos: [utxo(50_000)], amountSats: DUST_SATS - 1, feeRate: 1 }), 'dust'],
    ['zero', () => planSend({ utxos: [utxo(50_000)], amountSats: 0, feeRate: 1 }), 'amount'],
    ['fraction', () => planSend({ utxos: [utxo(50_000)], amountSats: 10.5, feeRate: 1 }), 'amount'],
    ['absurd fee rate', () => planSend({ utxos: [utxo(50_000)], amountSats: 1_000, feeRate: 5_000 }), 'fee'],
    ['send-all that the fee eats', () => planSend({ utxos: [utxo(200)], feeRate: 1, sendAll: true }), 'insufficient'],
  ])('refuses: %s', (_name, run, code) => {
    expect(run).toThrow(SendError);
    try { run(); } catch (e) { expect((e as SendError).code).toBe(code); }
  });

  it('refuses a fee that would eat more than half of the payment', () => {
    const plan = planSend({ utxos: [utxo(2_000_000)], amountSats: 15_000, feeRate: 400 });
    expect(() => assertSaneFee(plan)).toThrow(/more than half/);
    expect(() => assertSaneFee(planSend({ utxos: [utxo(2_000_000)], amountSats: 1_000_000, feeRate: 400 }))).not.toThrow();
  });
});

describe('building and signing a transaction', () => {
  const account = new Account(seedFromMnemonic(PHRASE), signet);
  const own = account.address(0, 0);
  const funds = utxo(100_000, { txid: 'cd'.repeat(32), vout: 1, address: own });
  const destination = new Account(seedFromMnemonic(PHRASE.replace('about', 'zoo').replace(/^(\S+ ){11}/, 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo ')), signet).address(0, 0);

  const plan = planSend({ utxos: [funds], amountSats: 30_000, feeRate: 2 });
  const change = account.address(1, 0);
  const built = buildTransaction(plan, destination, change, account, signet);
  const parsed = btc.Transaction.fromRaw(hexToBytes(built.hex), { allowUnknownOutputs: true });

  it('produces a transaction that pays the right amounts to the right places', () => {
    expect(parsed.id).toBe(built.txid);
    expect(parsed.outputsLength).toBe(2);
    const outs = [0, 1].map((i) => parsed.getOutput(i));
    const payTo = (addr: string) => btc.Address(signet.params).decode(addr);
    expect(outs[0]!.amount).toBe(30_000n);
    expect(btc.OutScript.decode(outs[0]!.script!)).toMatchObject({ type: 'wpkh' });
    expect(Buffer.from(outs[0]!.script!).toString('hex')).toBe(Buffer.from(btc.OutScript.encode(payTo(destination))).toString('hex'));
    expect(outs[1]!.amount).toBe(BigInt(plan.changeSats));
    expect(Buffer.from(outs[1]!.script!).toString('hex')).toBe(Buffer.from(btc.OutScript.encode(payTo(change))).toString('hex'));
  });

  it('pays the planned fee and no more, at about the requested rate', () => {
    expect(built.feeSats).toBe(plan.feeSats);
    expect(100_000 - 30_000 - plan.changeSats).toBe(plan.feeSats);
    const rate = plan.feeSats / built.vsize;
    expect(rate).toBeGreaterThanOrEqual(2);
    expect(rate).toBeLessThan(2.1);
  });

  it('carries a signature that really verifies against the wallet key', () => {
    const input = parsed.getInput(0);
    const [sig, pubkey] = input.finalScriptWitness!;
    expect(Buffer.from(pubkey!).toString('hex')).toBe(Buffer.from(account.publicKey(0, 0)).toString('hex'));
    const der = sig!.slice(0, -1); // the last byte is the sighash type
    expect(sig![sig!.length - 1]).toBe(btc.SigHash.ALL);
    // BIP-143: a SegWit key-hash input signs a digest that commits to the classic key-hash script and the amount
    const scriptCode = btc.p2pkh(account.publicKey(0, 0), signet.params).script;
    const digest = parsed.preimageWitnessV0(0, scriptCode, btc.SigHash.ALL, 100_000n);
    expect(secp256k1.verify(der, digest, pubkey!, { format: 'der', lowS: true, prehash: false })).toBe(true);
    // and it does not verify for a different amount: the signature commits to what is being spent
    const wrong = parsed.preimageWitnessV0(0, scriptCode, btc.SigHash.ALL, 99_999n);
    expect(secp256k1.verify(der, wrong, pubkey!, { format: 'der', lowS: true, prehash: false })).toBe(false);
  });

  it('refuses an address from the wrong network instead of sending to it', () => {
    expect(() => buildTransaction(plan, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', change, account, signet)).toThrow(/valid/);
  });

  it('omits the change output when there is none', () => {
    const all = planSend({ utxos: [funds], feeRate: 1, sendAll: true });
    const tx = btc.Transaction.fromRaw(hexToBytes(buildTransaction(all, destination, change, account, signet).hex), { allowUnknownOutputs: true });
    expect(tx.outputsLength).toBe(1);
  });
});

describe('the block-explorer client', () => {
  const reply = (status: number, body: string) => async () => ({ ok: status < 400, status, text: async () => body });

  it('reads json, and reports the explorer\'s own words on an error', async () => {
    expect(await new Esplora('https://x', reply(200, '{"a":1}')).feeEstimates()).toEqual({ a: 1 });
    await expect(new Esplora('https://x', reply(404, 'Address not found')).address('a')).rejects.toThrow(/Address not found/);
  });

  it('sends the transaction as plain hex and returns its id', async () => {
    let seen: { url?: string; body?: string; method?: string } = {};
    const api = new Esplora('https://x/api', async (url, init) => { seen = { url, body: init?.body, method: init?.method }; return { ok: true, status: 200, text: async () => 'abc123\n' }; });
    expect(await api.broadcast('0200ff')).toBe('abc123');
    expect(seen).toEqual({ url: 'https://x/api/tx', body: '0200ff', method: 'POST' });
  });

  it.each([
    ['sendrawtransaction RPC error: min relay fee not met', /fee was too low/],
    ['bad-txns-inputs-missingorspent', /already spent/],
    ['txn-already-known', /already has/],
    ['dust', /too small/],
    ['something strange', /rejected the transaction: something strange/],
  ])('explains the network refusing %j', async (text, words) => {
    await expect(new Esplora('https://x', reply(400, text)).broadcast('00')).rejects.toThrow(words);
    expect(describeBroadcastError(text)).toMatch(words);
  });

  it('picks a fee rate for a confirmation target, never below 1', () => {
    const est = { '1': 12.04, '3': 8, '6': 4.5, '144': 1 };
    expect(pickFeeRate(est, 1)).toBe(12.1);
    expect(pickFeeRate(est, 3)).toBe(8);
    expect(pickFeeRate(est, 5)).toBe(4.5); // next target at or beyond 5
    expect(pickFeeRate(est, 500)).toBe(1);
    expect(pickFeeRate({ '1': 0.2 }, 1)).toBe(1);
    expect(pickFeeRate({}, 1)).toBe(1);
  });
});

/** A tiny blockchain that speaks just enough Esplora for the scanner to be tested. */
class FakeChain {
  txs: (EsploraTx & { time: number })[] = [];
  private n = 0;
  add(opts: { vin?: { address: string; value: number; txid: string; vout: number }[]; vout: { address: string; value: number }[]; confirmed?: boolean }) {
    const txid = String(++this.n).padStart(64, '0');
    this.txs.push({
      txid, time: this.n,
      vin: (opts.vin ?? []).map((i) => ({ txid: i.txid, vout: i.vout, prevout: { scriptpubkey_address: i.address, value: i.value } })),
      vout: opts.vout.map((o) => ({ scriptpubkey_address: o.address, value: o.value })),
      status: { confirmed: opts.confirmed ?? true, block_height: opts.confirmed === false ? undefined : this.n, block_time: opts.confirmed === false ? undefined : this.n },
    });
    return txid;
  }
  private involving(address: string) { return this.txs.filter((t) => t.vout.some((o) => o.scriptpubkey_address === address) || t.vin.some((i) => i.prevout?.scriptpubkey_address === address)); }
  async address(a: string) {
    const t = this.involving(a);
    return { chain_stats: { tx_count: t.filter((x) => x.status.confirmed).length }, mempool_stats: { tx_count: t.filter((x) => !x.status.confirmed).length } };
  }
  async utxos(a: string) {
    const spent = new Set(this.txs.flatMap((t) => t.vin.map((i) => `${i.txid}:${i.vout}`)));
    return this.txs.flatMap((t) => t.vout.flatMap((o, vout) => o.scriptpubkey_address === a && !spent.has(`${t.txid}:${vout}`) ? [{ txid: t.txid, vout, value: o.value, status: { confirmed: t.status.confirmed } }] : []));
  }
  async txsOf(a: string) { return this.involving(a); }
  async tipHeight() { return 1000; }
}
const asEsplora = (c: FakeChain) => ({ address: (a: string) => c.address(a), utxos: (a: string) => c.utxos(a), txs: (a: string) => c.txsOf(a), tipHeight: () => c.tipHeight() }) as unknown as Esplora;

describe('finding the wallet\'s coins on the blockchain', () => {
  const account = new Account(seedFromMnemonic(PHRASE), signet);
  const addr = (chain: 0 | 1, i: number) => account.address(chain, i);

  it('finds coins on a used address and points to the next unused one', async () => {
    const chain = new FakeChain();
    chain.add({ vout: [{ address: addr(0, 3), value: 40_000 }] });
    const snap = await scanWallet(account, asEsplora(chain));
    expect(snap.confirmedSats).toBe(40_000);
    expect(snap.nextReceive).toBe(4);
    expect(snap.nextChange).toBe(0);
    expect(snap.utxos).toHaveLength(1);
    expect(snap.utxos[0]).toMatchObject({ chain: 0, index: 3, value: 40_000, confirmed: true });
  });

  it('keeps looking while addresses stay in use, up to the gap limit', async () => {
    const reachable = new FakeChain();
    reachable.add({ vout: [{ address: addr(0, 0), value: 1_000 }] });
    reachable.add({ vout: [{ address: addr(0, GAP_LIMIT), value: 2_000 }] }); // exactly the last index the rule still checks
    expect((await scanWallet(account, asEsplora(reachable))).confirmedSats).toBe(3_000);

    const tooFar = new FakeChain();
    tooFar.add({ vout: [{ address: addr(0, 0), value: 1_000 }] });
    tooFar.add({ vout: [{ address: addr(0, GAP_LIMIT + 1), value: 2_000 }] }); // ten empty addresses in between: not found
    expect((await scanWallet(account, asEsplora(tooFar))).confirmedSats).toBe(1_000);
  });

  it('finds change on the change chain, and tracks what was spent', async () => {
    const chain = new FakeChain();
    const fund = chain.add({ vout: [{ address: addr(0, 0), value: 100_000 }] });
    // spent 30,000 to someone else, 69,800 back to a change address, 200 fee
    chain.add({ vin: [{ address: addr(0, 0), value: 100_000, txid: fund, vout: 0 }], vout: [{ address: 'tb1qsomeoneelse', value: 30_000 }, { address: addr(1, 0), value: 69_800 }] });
    const snap = await scanWallet(account, asEsplora(chain));
    expect(snap.confirmedSats).toBe(69_800);
    expect(snap.utxos.map((u) => [u.chain, u.index])).toEqual([[1, 0]]);
    expect(snap.nextChange).toBe(1);
    expect(snap.nextReceive).toBe(1);
  });

  it('reports each transaction as money in or out, with the fee counted as going out', async () => {
    const chain = new FakeChain();
    const fund = chain.add({ vout: [{ address: addr(0, 0), value: 100_000 }] });
    chain.add({ vin: [{ address: addr(0, 0), value: 100_000, txid: fund, vout: 0 }], vout: [{ address: 'tb1qsomeoneelse', value: 30_000 }, { address: addr(1, 0), value: 69_800 }] });
    const snap = await scanWallet(account, asEsplora(chain));
    expect(snap.txs.map((t) => t.netSats)).toEqual([-30_200, 100_000]); // newest first
  });

  it('shows a payment to oneself as costing only the fee', async () => {
    const chain = new FakeChain();
    const fund = chain.add({ vout: [{ address: addr(0, 0), value: 50_000 }] });
    chain.add({ vin: [{ address: addr(0, 0), value: 50_000, txid: fund, vout: 0 }], vout: [{ address: addr(0, 1), value: 49_859 }] });
    const snap = await scanWallet(account, asEsplora(chain));
    expect(snap.txs[0]!.netSats).toBe(-141);
    expect(snap.confirmedSats).toBe(49_859);
  });

  it('keeps unconfirmed coins apart from confirmed ones', async () => {
    const chain = new FakeChain();
    chain.add({ vout: [{ address: addr(0, 0), value: 10_000 }] });
    chain.add({ vout: [{ address: addr(0, 1), value: 5_000 }], confirmed: false });
    const snap = await scanWallet(account, asEsplora(chain));
    expect(snap.confirmedSats).toBe(10_000);
    expect(snap.pendingSats).toBe(5_000);
    expect(snap.txs[0]!.confirmed).toBe(false); // the unconfirmed one is listed first
  });

  it('has nothing to show for a wallet that was never used', async () => {
    const snap = await scanWallet(account, asEsplora(new FakeChain()));
    expect(snap).toMatchObject({ confirmedSats: 0, pendingSats: 0, nextReceive: 0, nextChange: 0, txs: [], utxos: [] });
  });
});

describe('tagged payments', () => {
  const tag = 'a1b2c3d4e5f60718';
  const utxo = (value: number) => ({ txid: 'ab'.repeat(32), vout: 0, value, chain: 0 as const, index: 0, confirmed: true, address: 'x' });

  it('plans a larger fee for the tag output, and builds a transaction that carries the tag and the payment', () => {
    const plain = planSend({ utxos: [utxo(100_000)], amountSats: 20_000, feeRate: 2 });
    const tagged = planSend({ utxos: [utxo(100_000)], amountSats: 20_000, feeRate: 2, tagged: true });
    expect(tagged.feeSats - plain.feeSats).toBe(Math.ceil(19 * 2));
    const account = new Account(seedFromMnemonic(PHRASE), signet);
    const real = { ...utxo(100_000), txid: 'cd'.repeat(32) };
    const plan = planSend({ utxos: [real], amountSats: 20_000, feeRate: 2, tagged: true });
    const to = account.address(0, 5);
    const built = buildTransaction(plan, to, account.address(1, 0), account, signet, tag);
    const parsed = btc.Transaction.fromRaw(Uint8Array.from(built.hex.match(/../g)!.map((h) => parseInt(h, 16))), { allowUnknownOutputs: true });
    const scripts = Array.from({ length: parsed.outputsLength }, (_, i) => parsed.getOutput(i));
    expect(scripts.some((o) => o.amount === 0n && Buffer.from(o.script!).toString('hex') === `6a08${tag}`)).toBe(true);
    expect(scripts.some((o) => o.amount === 20_000n)).toBe(true);
    expect(built.vsize).toBeLessThanOrEqual(plan.vsize + 2);
  });
});

describe('backup files', () => {
  it('a backup file restores the same wallet, and anything else is refused', async () => {
    const { vaultFromFile, vaultToFile } = await import('../src/lib/onchain/vault');
    const record = { ...(await sealMnemonic(PHRASE, 'pw pw pw pw', 'signet', 1000)), address: 'tb1qexample' };
    const back = vaultFromFile(vaultToFile(record));
    expect(back).toEqual(record);
    expect(await openMnemonic(back, 'pw pw pw pw')).toBe(PHRASE);
    await expect(openMnemonic(back, 'wrong')).rejects.toThrow('wrong password');
    expect(() => vaultFromFile('not json')).toThrow(/backup/);
    expect(() => vaultFromFile(JSON.stringify({ v: 1, network: 'signet' }))).toThrow(/backup/);
    expect(() => vaultFromFile(JSON.stringify({ ...record, iterations: 0 }))).toThrow(/backup/);
  });
});
