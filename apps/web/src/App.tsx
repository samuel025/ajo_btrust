import { useEffect, useState } from 'react';
import { loadRate, type Rate } from './lib/rate';
import { restoreSigner, type Signer } from './lib/signer';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { useRoute } from './lib/hooks';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { NewGroup } from './pages/NewGroup';
import { GroupPage } from './pages/GroupPage';
import { SettingsPage } from './pages/SettingsPage';

export interface Ctx {
  signer: Signer;
  settings: Settings;
  navigate: (to: string) => void;
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

  if (!signer) return <Login onSignedIn={setSigner} />;

  const ctx: Ctx = { signer, settings, navigate, rate };
  const group = route.match(/^\/g\/([0-9a-f]{64})\/(.+)$/);

  let page;
  if (group) page = <GroupPage ctx={ctx} author={group[1]!} id={decodeURIComponent(group[2]!)} />;
  else if (route === '/new') page = <NewGroup ctx={ctx} />;
  else if (route === '/settings') {
    page = <SettingsPage ctx={ctx} onSave={(s) => { saveSettings(s); setSettings(s); navigate('/'); }} onSignOut={() => setSigner(undefined)} />;
  } else page = <Home ctx={ctx} />;

  return (
    <>
      <header className="bar">
        <a className="brand" href="#/">Bitcoin Ajo</a>
        <nav>
          <a href="#/new">New group</a>
          <a href="#/settings">Settings</a>
        </nav>
      </header>
      <main>{page}</main>
    </>
  );
}
