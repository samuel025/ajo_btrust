/** Bitcoin's price in naira, from several free public sources so no single one has to be trusted. */
export interface Rate {
  ngnPerBtc: number;
  /** Unix milliseconds when the rate was fetched. */
  fetchedAt: number;
  /** How many sources agreed to make up the median. */
  sources: number;
}

const SATS_PER_BTC = 100_000_000;
const CACHE_KEY = 'ajo.rate';
const FRESH_MS = 10 * 60_000;
/** A cached rate older than this is not shown at all: a stale price misleads more than none. */
const MAX_AGE_MS = 24 * 60 * 60_000;

const SOURCES: { url: string; read: (json: any) => unknown }[] = [
  { url: 'https://api.yadio.io/exrates/btc', read: (j) => j?.BTC?.NGN },
  { url: 'https://blockchain.info/ticker', read: (j) => j?.NGN?.last },
  { url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=ngn', read: (j) => j?.bitcoin?.ngn },
];

export const satsToNaira = (sats: number, ngnPerBtc: number) => (sats / SATS_PER_BTC) * ngnPerBtc;
export const nairaToSats = (naira: number, ngnPerBtc: number) => Math.round((naira / ngnPerBtc) * SATS_PER_BTC);

export function formatNaira(naira: number): string {
  if (naira < 1) return '< ₦1';
  return `₦${(naira < 10 ? naira.toFixed(2) : Math.round(naira).toLocaleString('en'))}`;
}

/** "1,000 sats (≈ ₦1,100)", or just the sats when there is no rate. */
export function withNaira(sats: number, rate?: Rate): string {
  const text = `${sats.toLocaleString('en')} sats`;
  return rate ? `${text} (≈ ${formatNaira(satsToNaira(sats, rate.ngnPerBtc))})` : text;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Asks every source and returns the median of the plausible answers; undefined if none answered. */
export async function fetchRate(fetchImpl: Fetch = fetch as unknown as Fetch, now = Date.now()): Promise<Rate | undefined> {
  const answers = await Promise.all(SOURCES.map(async (source) => {
    try {
      const res = await fetchImpl(source.url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return undefined;
      const value = Number(source.read(await res.json()));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }));
  const values = answers.filter((v): v is number => v !== undefined);
  if (!values.length) return undefined;
  // One source far from the others is wrong (or a different market); the median ignores it.
  return { ngnPerBtc: median(values), fetchedAt: now, sources: values.length };
}

function readCache(now: number): Rate | undefined {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Rate | null;
    return cached && now - cached.fetchedAt < MAX_AGE_MS ? cached : undefined;
  } catch {
    return undefined;
  }
}

/** A fresh rate if one is cached or fetchable; else a recent-enough cached one; else undefined. */
export async function loadRate(fetchImpl?: Fetch, now = Date.now()): Promise<Rate | undefined> {
  const cached = readCache(now);
  if (cached && now - cached.fetchedAt < FRESH_MS) return cached;
  const fresh = await fetchRate(fetchImpl, now);
  if (fresh) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(fresh)); } catch { /* storage unavailable */ }
    return fresh;
  }
  return cached;
}
