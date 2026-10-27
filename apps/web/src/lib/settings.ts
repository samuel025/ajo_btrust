export interface Settings {
  relay: string;
  coordinator: string;
  /** NWC connection used to pay contributions. Stored only in this browser. */
  nwcUrl: string;
}

const KEY = 'ajo.settings';

/**
 * The Vite dev server talks to a relay on this machine. A built, hosted site serves its own relay at
 * /relay on the same domain, so there is nothing to configure (and wss:// works because the page is https://).
 */
function defaultRelay(): string {
  if (import.meta.env.VITE_RELAY) return import.meta.env.VITE_RELAY;
  if (import.meta.env.DEV) return 'ws://localhost:7777';
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/relay`;
}

const defaults: Settings = {
  relay: defaultRelay(),
  coordinator: import.meta.env.VITE_COORDINATOR ?? '',
  nwcUrl: '',
};

export function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
