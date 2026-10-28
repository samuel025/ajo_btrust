import type { GroupRail } from '@ajo/core';
import { loadVault } from '../lib/onchain/vault';
import { payoutAddressFor } from '../lib/onchain/payout';

/** Where a member is paid: a Lightning address, or (in an on-chain group) a Bitcoin address, which can be the app's own wallet. */
export function PayoutField({ rail, value, onChange, groupId }: { rail?: GroupRail; value: string; onChange: (v: string) => void; groupId: string }) {
  if (rail !== 'onchain') {
    return (
      <label>Your Lightning address
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="you@wallet.com" />
      </label>
    );
  }
  const vault = loadVault();
  const hasWallet = !!(vault?.addresses?.length || vault?.address);
  return (
    <label>Your Bitcoin address
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="tb1q…" autoComplete="off" autoCapitalize="none" />
      {hasWallet
        ? <><button type="button" className="secondary" onClick={() => onChange(payoutAddressFor(groupId, vault)!)}>Use my wallet's address</button><span className="muted small">A different address of your wallet is used for each group, which keeps your groups from being linked on the blockchain.</span></>
        : <span className="muted small">No wallet yet? <a href="#/wallet">Create one in the Wallet page</a> (12 words, takes a minute), then come back.</span>}
    </label>
  );
}
