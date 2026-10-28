import { useEffect, useState } from 'react';
import { loadRate, type Rate } from './lib/rate';
import { restoreSigner, type Signer } from './lib/signer';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { useRoute } from './lib/hooks';
import { Login } from './pages/Login';
import { InvitePage } from './pages/InvitePage';
import { parseInvite } from './lib/invite';
import { withNaira } from './lib/rate';
import { Home } from './pages/Home';
import { NewGroup } from './pages/NewGroup';
import { GroupPage } from './pages/GroupPage';
import { SettingsPage } from './pages/SettingsPage';
import { WalletPage } from './pages/WalletPage';

export interface Ctx {
  signer: Signer;
  settings: Settings;
  navigate: (to: string) => void;
  /** Saves part of the settings (for example the wallet connection) and keeps it. */
  updateSettings: (patch: Partial<Settings>) => void;
  /** Naira per bitcoin, when a rate could be fetched. Amounts are always in sats; naira is only an estimate. */
  rate?: Rate;
}

export function App() {
  const [signer, setSigner] = useState<Signer | undefined>(restoreSigner);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [route, navigate] = useRoute();
  const [rate, setRate] = useState<Rate>();
  useEffect(() => {
    let alive = true;
    const refresh = () => loadRate().then((r) => { if (alive) setRate(r); });
    refresh();
    const timer = setInterval(refresh, 10 * 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const invite = parseInvite(route);
  if (!signer) {
    const banner = invite && (
      <section className="card notice">
        <strong>You're invited to {invite.name}</strong>
        <div className="muted">{withNaira(invite.amountSats, rate)} per round. Sign in to ask to join.</div>
      </section>
    );
    return <Login onSignedIn={setSigner} banner={banner} />;
  }

  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    saveSettings(next);
    setSettings(next);
  };
  const ctx: Ctx = { signer, settings, navigate, rate, updateSettings };
  const group = route.match(/^\/g\/([0-9a-f]{64})\/(.+)$/);

  let page;
  if (invite) page = <InvitePage ctx={ctx} invite={invite} />;
  else if (group) page = <GroupPage ctx={ctx} author={group[1]!} id={decodeURIComponent(group[2]!)} />;
  else if (route === '/new') page = <NewGroup ctx={ctx} />;
  else if (route === '/wallet') page = <WalletPage ctx={ctx} />;
  else if (route === '/settings') {
    page = <SettingsPage ctx={ctx} onSave={(s) => { saveSettings(s); setSettings(s); navigate('/'); }} onSignOut={() => setSigner(undefined)} />;
  } else page = <Home ctx={ctx} />;

  return (
    <>
      <header className="bar">
        <a className="brand" href="#/">Bitcoin Ajo</a>
        <nav>
          <a href="#/wallet">Wallet</a>
          <a href="#/new">New group</a>
          <a href="#/settings">Settings</a>
        </nav>
      </header>
      <main>{page}</main>
    </>
  );
}
