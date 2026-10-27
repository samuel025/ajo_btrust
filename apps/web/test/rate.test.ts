import { describe, expect, it } from 'vitest';
import { fetchRate, formatNaira, median, nairaToSats, satsToNaira, withNaira } from '../src/lib/rate';

const RATE = 110_000_000; // naira per BTC

describe('conversion', () => {
  it('converts between sats and naira', () => {
    expect(satsToNaira(1000, RATE)).toBeCloseTo(1100);
    expect(satsToNaira(100_000_000, RATE)).toBe(RATE);
    expect(nairaToSats(1100, RATE)).toBe(1000);
    expect(nairaToSats(satsToNaira(54_321, RATE), RATE)).toBe(54_321);
  });

  it('formats naira readably at every size', () => {
    expect(formatNaira(1_234_567)).toBe('₦1,234,567');
    expect(formatNaira(1100.4)).toBe('₦1,100');
    expect(formatNaira(4.5)).toBe('₦4.50');
    expect(formatNaira(0.2)).toBe('< ₦1');
  });

  it('shows sats alone when there is no rate', () => {
    expect(withNaira(1000)).toBe('1,000 sats');
    expect(withNaira(1000, { ngnPerBtc: RATE, fetchedAt: 0, sources: 3 })).toBe('1,000 sats (≈ ₦1,100)');
  });
});

describe('fetchRate', () => {
  const answer = (url: string, rates: Record<string, unknown>) => {
    const key = Object.keys(rates).find((k) => url.includes(k));
    if (key === undefined) throw new Error('unexpected url');
    const value = rates[key];
    if (value instanceof Error) throw value;
    return { ok: true, json: async () => value };
  };

  it('takes the median of the sources that answer', async () => {
    const fetchImpl = async (url: string) => answer(url, {
      yadio: { BTC: { NGN: 112_000_000 } },
      blockchain: { NGN: { last: 110_000_000 } },
      coingecko: { bitcoin: { ngn: 109_000_000 } },
    });
    expect(await fetchRate(fetchImpl, 5)).toEqual({ ngnPerBtc: 110_000_000, fetchedAt: 5, sources: 3 });
  });

  it('ignores one wildly wrong source', async () => {
    const fetchImpl = async (url: string) => answer(url, {
      yadio: { BTC: { NGN: 112_000_000 } },
      blockchain: { NGN: { last: 1_100_000_000_000 } },
      coingecko: { bitcoin: { ngn: 109_000_000 } },
    });
    // the median of an odd count is a real quote, so one outlier can never become the rate
    expect((await fetchRate(fetchImpl))!.ngnPerBtc).toBe(112_000_000);
  });

  it('copes with sources that fail, return junk, or are down', async () => {
    const fetchImpl = async (url: string) => answer(url, {
      yadio: new Error('network'),
      blockchain: { NGN: { last: 'not a number' } },
      coingecko: { bitcoin: { ngn: 109_000_000 } },
    });
    expect(await fetchRate(fetchImpl)).toMatchObject({ ngnPerBtc: 109_000_000, sources: 1 });
    expect(await fetchRate(async () => { throw new Error('offline'); })).toBeUndefined();
  });

  it('median works for even counts', () => {
    expect(median([1, 3])).toBe(2);
    expect(median([5, 1, 3])).toBe(3);
  });
});
