import type { GroupRail } from '@ajo/core';
import { loadVault } from '../lib/onchain/vault';

/** Where a member is paid: a Lightning address, or (in an on-chain group) a Bitcoin address, which can be the app's own wallet. */
export function PayoutField({ rail, value, onChange }: { rail?: GroupRail; value: string; onChange: (v: string) => void }) {
  if (rail !== 'onchain') {
    return (
      <label>Your Lightning address
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="you@wallet.com" />
      </label>
    );
  }
  const own = loadVault()?.address;
  return (
    <label>Your Bitcoin address
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="tb1q…" autoComplete="off" autoCapitalize="none" />
      {own
        ? <button type="button" className="secondary" onClick={() => onChange(own)}>Use my wallet's address</button>
        : <span className="muted small">No wallet yet? <a href="#/wallet">Create one in the Wallet page</a> (12 words, takes a minute), then come back.</span>}
    </label>
  );
}
