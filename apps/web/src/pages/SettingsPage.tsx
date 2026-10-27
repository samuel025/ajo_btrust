import { useState } from 'react';
import { nip19 } from 'nostr-tools';
import { forgetLocalKey, localSecretKey } from '../lib/signer';
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
      {ctx.signer.kind === 'local' && <KeyBackup />}
      <hr />
      <button type="button" className="secondary" onClick={() => {
        if (ctx.signer.kind === 'local' && !confirm('This deletes your test key from this browser. Make sure you saved the nsec if you need it.')) return;
        forgetLocalKey();
        onSignOut();
      }}>Sign out</button>
    </form>
  );
}

/** The account on this device is just a key. Showing it lets people save it, so a lost phone isn't a lost account. */
function KeyBackup() {
  const [shown, setShown] = useState(false);
  const nsec = shown ? localSecretKey() : undefined;
  return (
    <section className="card">
      <h2>Back up your account</h2>
      <p className="muted small">Your account is a secret key kept on this device. Save it somewhere safe, like a password manager. Anyone who has it can act as you, and without it you can't sign back in on another device.</p>
      {nsec ? (
        <>
          <input readOnly value={nsec} onFocus={(e) => e.target.select()} aria-label="Secret key" />
          <button type="button" className="secondary" onClick={() => navigator.clipboard?.writeText(nsec)}>Copy</button>
          <button type="button" className="link" onClick={() => setShown(false)}>Hide</button>
        </>
      ) : (
        <button type="button" className="secondary" onClick={() => setShown(true)}>Show my secret key</button>
      )}
    </section>
  );
}
