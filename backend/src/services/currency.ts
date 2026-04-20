import { logger } from '../utils/logger';

/**
 * Currency service — converts any currency to USD using the free
 * open.er-api.com endpoint. Rates are cached in memory for 24 hours so
 * we only hit the API at most once per day per process.
 *
 * No API key required. Rates update daily at 00:00 UTC.
 */

type RateCache = {
  rates: Record<string, number>; // currency → rate relative to USD (1 USD = N currency)
  fetchedAt: number;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let cache: RateCache | null = null;
let inflightFetch: Promise<RateCache> | null = null;

const FALLBACK_RATES: Record<string, number> = {
  // Last-resort rates in case the API is down. Approximate, Apr 2026.
  USD: 1,
  EUR: 0.92,
  GBP: 0.78,
  JPY: 150,
  CNY: 7.2,
  KRW: 1350,
  INR: 83,
  CAD: 1.36,
  AUD: 1.52,
  CHF: 0.88,
  SEK: 10.5,
  NOK: 10.8,
  DKK: 6.9,
  MXN: 17,
  BRL: 5.1,
  ZAR: 18.5,
  THB: 36,
  SGD: 1.35,
  HKD: 7.8,
  NZD: 1.65,
  TRY: 32,
  AED: 3.67,
  RUB: 92,
  PLN: 4.0,
  CZK: 23,
  HUF: 360,
  IDR: 15800,
  PHP: 56,
  VND: 25000,
  MYR: 4.7,
  ILS: 3.7,
  ARS: 900,
  EGP: 49,
};

async function fetchRates(): Promise<RateCache> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data: any = await res.json();
    if (data.result !== 'success' || !data.rates) {
      throw new Error('API returned non-success result');
    }
    return {
      rates: data.rates,
      fetchedAt: Date.now(),
    };
  } catch (err: any) {
    logger.warn('Currency API failed, using fallback rates', { message: err?.message });
    return {
      rates: FALLBACK_RATES,
      fetchedAt: Date.now(),
    };
  }
}

async function getRates(): Promise<RateCache> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (inflightFetch) return inflightFetch;

  inflightFetch = fetchRates().then((fresh) => {
    cache = fresh;
    inflightFetch = null;
    return fresh;
  });
  return inflightFetch;
}

/**
 * Convert an amount in `fromCurrency` to USD.
 * If the currency is unknown or the rate is missing, the amount is returned
 * unchanged so that worst-case we just display the raw price.
 *
 * Returns `Math.round(amount * 100) / 100` — 2-decimal precision.
 */
export async function convertToUsd(amount: number, fromCurrency: string): Promise<number> {
  if (!Number.isFinite(amount) || amount === 0) return amount;
  const code = fromCurrency?.toUpperCase().trim();
  if (!code || code === 'USD') return Math.round(amount * 100) / 100;

  const { rates } = await getRates();
  const rate = rates[code] ?? FALLBACK_RATES[code];
  if (!rate || rate <= 0) {
    logger.warn('Unknown currency, returning amount as-is', { code, amount });
    return Math.round(amount * 100) / 100;
  }

  // rates are "1 USD = N <currency>", so to go from foreign → USD divide
  return Math.round((amount / rate) * 100) / 100;
}

/**
 * Batch conversion helper — converts a list of numbers at once using
 * a single rate lookup. Useful when converting many offers from the
 * same currency (e.g. a page of hotels all priced in JPY).
 */
export async function convertManyToUsd(
  amounts: number[],
  fromCurrency: string,
): Promise<number[]> {
  if (amounts.length === 0) return [];
  const code = fromCurrency?.toUpperCase().trim();
  if (!code || code === 'USD') return amounts.map((a) => Math.round(a * 100) / 100);

  const { rates } = await getRates();
  const rate = rates[code] ?? FALLBACK_RATES[code];
  if (!rate || rate <= 0) return amounts.map((a) => Math.round(a * 100) / 100);

  return amounts.map((a) =>
    Number.isFinite(a) && a !== 0 ? Math.round((a / rate) * 100) / 100 : a,
  );
}
