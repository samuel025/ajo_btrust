import { useEffect, useRef, useState } from 'react';
import { CirclePlus, House, Monitor, Moon, Settings as SettingsIcon, Sun, Wallet } from 'lucide-react';
import { BrandMark } from './components/BrandMark';
import { useTheme } from './lib/theme';
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
  const mainRef = useRef<HTMLElement>(null);
  const theme = useTheme();
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
    return <Login onSignedIn={setSigner} banner={banner} themeToggle={<ThemeToggle theme={theme} />} />;
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

  const links = [
    { to: '/', label: 'Groups', Icon: House, on: route === '/' || route.startsWith('/g/') },
    { to: '/wallet', label: 'Wallet', Icon: Wallet, on: route === '/wallet' },
    { to: '/new', label: 'New group', Icon: CirclePlus, on: route === '/new' },
    { to: '/settings', label: 'Settings', Icon: SettingsIcon, on: route === '/settings' },
  ];
  return (
    <>
      <button className="skip secondary" onClick={() => mainRef.current?.focus()}>Skip to content</button>
      <header className="bar">
        <div className="inner">
          <a className="brand" href="#/"><BrandMark />Bitcoin Ajo</a>
          <nav aria-label="Main">
            {links.filter((l) => l.to !== '/').map(({ to, label, Icon, on }) => (
              <a key={to} href={`#${to}`} aria-current={on ? 'page' : undefined}><Icon size={18} aria-hidden="true" />{label}</a>
            ))}
          </nav>
          <ThemeToggle theme={theme} />
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1}>{page}</main>
      <nav className="bottomnav" aria-label="Main">
        {links.map(({ to, label, Icon, on }) => (
          <a key={to} href={`#${to}`} aria-current={on ? 'page' : undefined}><Icon size={22} aria-hidden="true" />{label === 'New group' ? 'New' : label}</a>
        ))}
      </nav>
    </>
  );
}

/** Cycles System, Light and Dark. The button says which one is on, and what it will switch to. */
function ThemeToggle({ theme }: { theme: ReturnType<typeof useTheme> }) {
  const { choice, cycle } = theme;
  const next = choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system';
  const Icon = choice === 'light' ? Sun : choice === 'dark' ? Moon : Monitor;
  return (
    <button className="icon-btn" onClick={cycle} title={`Theme: ${choice}. Switch to ${next}.`} aria-label={`Theme: ${choice}. Switch to ${next}.`}>
      <Icon size={20} aria-hidden="true" />
    </button>
  );
}
