import { useCallback, useEffect, useMemo, useState } from 'react';
import { findOnchainPayments, paymentTag, type ChainTx, type GroupDef, type RoundState } from '@ajo/core';
import { Esplora, pickFeeRate } from '../lib/onchain/esplora';
import { Account, checkAddress } from '../lib/onchain/keys';
import { walletNetwork } from '../lib/onchain/config';
import { scanWallet, type Snapshot } from '../lib/onchain/scan';
import { seedFromMnemonic } from '../lib/onchain/seed';
import { SendError, assertSaneFee, buildTransaction, planSend, type Built, type Plan } from '../lib/onchain/send';
import { useUnlocked, setUnlocked } from '../lib/onchain/session';
import { loadVault, openMnemonic } from '../lib/onchain/vault';
import { formatSats, shortKey } from '../lib/format';

/**
 * Pays this round's contribution from the app's own Bitcoin wallet. The payment carries a tag that says
 * "this member, this round", so the coordinator can see who paid by reading the blockchain.
 */
export function PayOnChain({ group, state, recipientAddress, me, naira }: {
  group: GroupDef; state: RoundState; recipientAddress: string | undefined; me: string; naira: (sats: number) => string;
}) {
  const { net, problem } = useMemo(walletNetwork, []);
  const api = useMemo(() => (net ? new Esplora(net.esplora) : undefined), [net]);
  const account = useUnlocked();
  const tag = paymentTag(group.id, state.round, me);
  const [mine, setMine] = useState<{ txid: string; confirmations: number }>();
  const [snap, setSnap] = useState<Snapshot>();
  const [review, setReview] = useState<{ plan: Plan; built: Built }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState('');

  // Has this member's payment already been made (even if still unconfirmed)? Never offer to pay twice.
  const look = useCallback(async () => {
    if (!api || !recipientAddress) return;
    try {
      const [raw, tip] = await Promise.all([api.txs(recipientAddress), api.tipHeight()]);
      const txs: ChainTx[] = raw.map((t) => ({ txid: t.txid, status: t.status, vout: t.vout.map((o) => ({ scriptpubkey: o.scriptpubkey ?? '', scriptpubkey_address: o.scriptpubkey_address, value: o.value })) }));
      const found = findOnchainPayments({ txs, tip, recipientAddress, amountSats: group.amountSats, groupId: group.id, round: state.round, payers: [me], minConfirmations: 0 });
      const txid = found[me];
      const tx = txs.find((t) => t.txid === txid);
      setMine(txid ? { txid, confirmations: tx?.status.confirmed && tx.status.block_height ? tip - tx.status.block_height + 1 : 0 } : undefined);
    } catch { /* the coordinator's own check is what counts; this is only to avoid a double payment */ }
  }, [api, recipientAddress, group.id, group.amountSats, state.round, me]);
  useEffect(() => { void look(); const t = setInterval(() => void look(), 15_000); return () => clearInterval(t); }, [look]);

  useEffect(() => {
    if (account && api) scanWallet(account, api).then(setSnap).catch((e) => setError((e as Error).message));
  }, [account, api]);

  if (!net || !api) return <p className="error">{problem}</p>;
  if (!recipientAddress) return <p className="muted">Waiting for {shortKey(state.recipient)} to add a Bitcoin address.</p>;

  if (mine) {
    return (
      <>
        <p>✓ Your payment is on the blockchain ({mine.confirmations === 0 ? 'not yet in a block' : `${mine.confirmations} confirmation${mine.confirmations === 1 ? '' : 's'}`}).</p>
        <p className="muted small">The coordinator marks it paid once it has enough confirmations. <a href={`${net.explorer}/tx/${mine.txid}`} target="_blank" rel="noreferrer">View transaction</a></p>
      </>
    );
  }

  const vault = loadVault();
  if (!vault) {
    return <p>Pay from your Bitcoin wallet. You don't have one yet: <a href="#/wallet">create it in the Wallet page</a> (12 words, takes a minute), add coins, and come back.</p>;
  }
  if (!account) {
    const unlock = async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(undefined);
      try { setUnlocked(new Account(seedFromMnemonic(await openMnemonic(vault, pw)), net)); } catch { setError('Wrong password.'); } finally { setBusy(false); }
    };
    return (
      <form onSubmit={unlock}>
        <p>Unlock your Bitcoin wallet to pay.</p>
        <label>Wallet password<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy || !pw}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </form>
    );
  }

  const prepare = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const to = checkAddress(recipientAddress, net);
      const fresh = snap ?? (await scanWallet(account, api));
      setSnap(fresh);
      const rate = pickFeeRate(await api.feeEstimates().catch(() => ({})), 3);
      const plan = planSend({ utxos: fresh.utxos, amountSats: group.amountSats, feeRate: rate, tagged: true });
      assertSaneFee(plan);
      setReview({ plan, built: buildTransaction(plan, to, account.address(1, fresh.nextChange), account, net, tag) });
    } catch (e) {
      setError(e instanceof SendError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!review) return;
    setBusy(true);
    setError(undefined);
    try {
      const txid = await api.broadcast(review.built.hex);
      setMine({ txid, confirmations: 0 });
      setReview(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (review) {
    return (
      <>
        <dl className="kv">
          <dt>To</dt><dd>{shortKey(state.recipient)} <code className="address">{recipientAddress}</code></dd>
          <dt>Contribution</dt><dd><b>{formatSats(review.plan.toSats)}</b>{naira(review.plan.toSats)}</dd>
          <dt>Network fee</dt><dd>{formatSats(review.plan.feeSats)}{naira(review.plan.feeSats)}</dd>
          <dt>Total leaving your wallet</dt><dd>{formatSats(review.plan.toSats + review.plan.feeSats)}</dd>
        </dl>
        <p className="muted small">The payment is marked with a tag for this group and round, so the coordinator can tell it is yours. A Bitcoin payment can't be undone.</p>
        {error && <p className="error">{error}</p>}
        <button disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Sign and send'}</button>{' '}
        <button className="secondary" disabled={busy} onClick={() => setReview(undefined)}>Cancel</button>
      </>
    );
  }
  return (
    <>
      <p className="muted small">Your wallet holds {snap ? formatSats(snap.confirmedSats) : '…'}.{net.testCoins && net.faucet ? <> Need test coins? <a href={net.faucet} target="_blank" rel="noreferrer">{net.faucet.replace('https://', '')}</a>.</> : null}</p>
      {error && <p className="error">{error}</p>}
      <button disabled={busy || !snap} onClick={prepare}>{busy ? 'Preparing…' : `Pay ${formatSats(group.amountSats)} from my wallet`}</button>
    </>
  );
}
