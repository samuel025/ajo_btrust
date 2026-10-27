export interface Settings {
  relay: string;
  coordinator: string;
  /** NWC connection used to pay contributions. Stored only in this browser. */
  nwcUrl: string;
}

const KEY = 'ajo.settings';

const defaults: Settings = {
  relay: import.meta.env.VITE_RELAY ?? 'ws://localhost:7777',
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
