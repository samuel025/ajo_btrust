import { useState } from 'react';
import type { Esplora } from '../lib/onchain/esplora';
import { pickFeeRate } from '../lib/onchain/esplora';
import type { Account } from '../lib/onchain/keys';
import type { NetworkConfig } from '../lib/onchain/network';
import { scanWallet } from '../lib/onchain/scan';
import { SendError, buildBump, planBump, type BumpPlan } from '../lib/onchain/send';

/** Offers to replace a payment that is waiting for a block with one that pays a higher fee. */
export function SpeedUp({ txid, account, api, net, onDone }: { txid: string; account: Account; api: Esplora; net: NetworkConfig; onDone: () => void }) {
  const [plan, setPlan] = useState<BumpPlan>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const prepare = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const fresh = await scanWallet(account, api);
      const original = fresh.raw[txid];
      if (!original) throw new SendError('fee', 'That payment is no longer waiting. It may have just been confirmed.');
      const estimates = await api.feeEstimates().catch(() => ({}));
      const rate = Math.max(pickFeeRate(estimates, 1), 2); // aim for the next block, and always above the 1 sat/vB it may have paid
      const changeIndex = fresh.nextChange;
      setPlan(planBump({
        original, owned: fresh.owned, spare: fresh.utxos, feeRate: rate,
        changeTo: { chain: 1, index: changeIndex, script: Array.from(account.payment(1, changeIndex).script, (b) => b.toString(16).padStart(2, '0')).join('') },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const replace = async () => {
    if (!plan) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.broadcast(buildBump(plan, account, net).hex);
      setDone(true);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <p className="muted small">✓ Replaced with a higher fee. It should be mined in the next block or two.</p>;
  if (plan) {
    return (
      <div className="speedup">
        <p className="small">Pay a higher fee: <b>{plan.oldFeeSats.toLocaleString('en')}</b> → <b>{plan.feeSats.toLocaleString('en')} sats</b> ({plan.feeRate} sat/vB). The same payment is sent again to the same place, and the old one is dropped.</p>
        {error && <p className="error">{error}</p>}
        <button aria-busy={busy} disabled={busy} onClick={replace}>{busy ? 'Replacing…' : 'Replace with a faster payment'}</button>{' '}
        <button className="secondary" disabled={busy} onClick={() => setPlan(undefined)}>Cancel</button>
      </div>
    );
  }
  return (
    <>
      {error && <p className="error">{error}</p>}
      <button className="secondary" aria-busy={busy} disabled={busy} onClick={prepare}>{busy ? 'Checking…' : 'Speed up'}</button>
    </>
  );
}
