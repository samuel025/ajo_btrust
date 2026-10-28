/** The three speeds offered for a payment: how many blocks the person is willing to wait for. */
export const SPEEDS = [
  { key: 'slow', label: 'Slow', target: 12 },
  { key: 'normal', label: 'Normal', target: 3 },
  { key: 'fast', label: 'Fast', target: 1 },
] as const;

export type SpeedKey = (typeof SPEEDS)[number]['key'];

/** A rough wait for a speed, in words. Signet makes a block about every 30 seconds, Bitcoin about every 10 minutes. */
export function waitText(target: number, testCoins: boolean): string {
  const minutes = target * (testCoins ? 0.5 : 10);
  return minutes < 1 ? 'about a minute' : `about ${Math.round(minutes)} min`;
}
