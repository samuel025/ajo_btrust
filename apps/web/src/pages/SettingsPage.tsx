import { useState } from 'react';
import { forgetLocalKey } from '../lib/signer';
import type { Settings } from '../lib/settings';
import type { Ctx } from '../App';

export function SettingsPage({ ctx, onSave, onSignOut }: { ctx: Ctx; onSave: (s: Settings) => void; onSignOut: () => void }) {
  const [draft, setDraft] = useState(ctx.settings);
  const set = (key: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: e.target.value });

  return (
    <form className="narrow" onSubmit={(e) => { e.preventDefault(); onSave({ ...draft, relay: draft.relay.trim(), coordinator: draft.coordinator.trim(), nwcUrl: draft.nwcUrl.trim() }); }}>
      <h1>Settings</h1>
      <label>Relay
        <input value={draft.relay} onChange={set('relay')} placeholder="wss://…" />
      </label>
      <label>Default coordinator key
        <input value={draft.coordinator} onChange={set('coordinator')} placeholder="npub1… or hex" />
      </label>
      <label>Wallet connection (NWC)
        <input type="password" autoComplete="off" value={draft.nwcUrl} onChange={set('nwcUrl')} placeholder="nostr+walletconnect://…" />
        <span className="muted small">
          Lets this app pay your contribution from your wallet. It's saved in this browser only. Use a
          connection with a spending budget, never a full-access one for real money.
        </span>
      </label>
      <button>Save</button>
      <hr />
      <button type="button" className="secondary" onClick={() => {
        if (ctx.signer.kind === 'local' && !confirm('This deletes your test key from this browser. Make sure you saved the nsec if you need it.')) return;
        forgetLocalKey();
        onSignOut();
      }}>Sign out</button>
    </form>
  );
}
