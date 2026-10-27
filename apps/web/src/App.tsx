import { useState } from 'react';
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
}

export function App() {
  const [signer, setSigner] = useState<Signer | undefined>(restoreSigner);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [route, navigate] = useRoute();

  if (!signer) return <Login onSignedIn={setSigner} />;

  const ctx: Ctx = { signer, settings, navigate };
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
