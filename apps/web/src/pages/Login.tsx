import { useState } from 'react';
import { BrandMark } from '../components/BrandMark';
import { extensionSigner, hasExtension, localSigner, type Signer } from '../lib/signer';

export function Login({ onSignedIn, banner, themeToggle }: { onSignedIn: (s: Signer) => void; banner?: React.ReactNode; themeToggle?: React.ReactNode }) {
  const [error, setError] = useState<string>();
  const [nsec, setNsec] = useState('');
  const [busy, setBusy] = useState(false);

  const attempt = async (fn: () => Promise<Signer> | Signer) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try { onSignedIn(await fn()); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  // Someone arriving from an invite link just wants to continue; the Nostr details can wait.
  if (banner) {
    return (
      <main className="narrow auth">
        <div className="auth-top">{themeToggle}</div>
        <div className="auth-mark"><BrandMark size={56} /></div>
        <h1>Bitcoin Ajo</h1>
        {banner}
        <section className="card">
          <h2>Continue</h2>
          <p className="muted">
            We'll set up your account on this device. It takes one click and needs no email or password.
            Back it up later in Settings so you can sign in again if you switch devices.
          </p>
          <button aria-busy={busy} onClick={() => attempt(() => localSigner())}>Continue</button>
          <details>
            <summary>I already have a Nostr account</summary>
            <button className="secondary" aria-busy={busy} disabled={!hasExtension()} onClick={() => attempt(extensionSigner)}>Use my Nostr extension</button>
            {!hasExtension() && <p className="muted small">No extension found in this browser.</p>}
            <input placeholder="or paste your key: nsec1…" value={nsec} onChange={(e) => setNsec(e.target.value)} />
            <button className="secondary" disabled={!nsec} onClick={() => attempt(() => localSigner(nsec.trim()))}>Use this key</button>
          </details>
        </section>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main className="narrow auth">
      <div className="auth-top">{themeToggle}</div>
      <div className="auth-mark"><BrandMark size={56} /></div>
      <h1>Bitcoin Ajo</h1>
      {banner}
      <p className="lead">
        A savings circle you can trust without a middleman. Each round, everyone pays the member whose
        turn it is, straight to their wallet over Lightning.
      </p>

      <section className="card">
        <h2>Sign in with Nostr</h2>
        <p className="muted">Your Nostr key is your identity here. The app never sees your private key.</p>
        <button aria-busy={busy} disabled={!hasExtension()} onClick={() => attempt(extensionSigner)}>Use my Nostr extension</button>
        {!hasExtension() && <p className="muted small">No extension found in this browser.</p>}
      </section>

      <section className="card">
        <h2>Try it without an extension</h2>
        <p className="muted">A key stored in this browser only. Fine for testing, not for real savings.</p>
        <button className="secondary" aria-busy={busy} onClick={() => attempt(() => localSigner())}>Create a test key</button>
        <details>
          <summary>I already have a test key</summary>
          <input placeholder="nsec1…" value={nsec} onChange={(e) => setNsec(e.target.value)} />
          <button className="secondary" disabled={!nsec} onClick={() => attempt(() => localSigner(nsec.trim()))}>Use this key</button>
        </details>
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
