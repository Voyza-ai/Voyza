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
  /**
   * How long this entry may be reused. Per-entry rather than global so a
   * failed fetch can't pin the fallback table for a full day — see
   * FALLBACK_TTL_MS.
   */
  ttlMs: number;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
/**
 * Retry window after a failed fetch. Short on purpose: FALLBACK_RATES is a
 * fraction of the ~160 currencies the live API carries, so for as long as
 * it's the active table every currency NOT in it is unconvertible and its
 * offers get dropped. One transient FX blip must not cost us a destination's
 * pricing for 24 hours.
 */
const FALLBACK_TTL_MS = 5 * 60 * 1000; // 5m
let cache: RateCache | null = null;
let inflightFetch: Promise<RateCache> | null = null;

/**
 * Floating rates. Last-resort values in case the API is down — approximate,
 * Apr 2026, and internally consistent with each other at that vintage (the
 * European block all sits around EUR/USD 1.087). They are a stand-in for
 * what the live table WOULD have said, not an economic claim: where a country
 * runs an official rate alongside a divergent street rate, the number here is
 * the official one, the same as the API's.
 *
 * Pegged currencies do NOT belong here — see FALLBACK_PEGS below.
 */
const FALLBACK_FLOATS: Record<string, number> = {
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

  // ── Added after auditing the table against the destinations this app can
  // actually reach. Hotel search resolves ANY city name through Booking's
  // locations API, so the real bound isn't a city list — but every currency
  // below is one a hardcoded list, a shipped Browse preset or a target market
  // puts in front of us, and each was a dropped row while it was missing.
  // Same standard as the block above: approximate, not exact.

  // Europe — Browse presets and both city tables.
  ISK: 136, // Reykjavik ("Reykjavik Adventure Weekend" preset)
  UAH: 41.5, // Kyiv
  RON: 4.65, // Bucharest (managed, ~5.05 per EUR)
  RSD: 108, // Belgrade (managed, ~117 per EUR)

  // Latin America — the "South America Grand Tour" preset plus worldCities.
  PEN: 3.75, // Lima, Cusco, Machu Picchu
  COP: 4000, // Bogotá, Medellín, Cartagena
  CLP: 950, // Santiago
  UYU: 40, // Montevideo
  BOB: 6.9, // La Paz — official rate; the street rate is far weaker
  CRC: 510, // San José
  // Two Caribbean floats, alongside the pegged ones further down: both are
  // mass-market beach destinations the planner suggests unprompted.
  DOP: 62, // Punta Cana, Santo Domingo
  JMD: 157, // Montego Bay, Kingston

  // Africa & Middle East.
  MAD: 9.9, // Marrakech, Casablanca, Fez (basket-managed, ~10.8 per EUR)
  TND: 3.1, // Tunis
  KES: 129, // Nairobi
  TZS: 2600, // Zanzibar
  NGN: 1550, // Lagos — volatile; the widest band of anything here

  // Asia-Pacific.
  TWD: 31.5, // Taipei
  LKR: 295, // Colombo
  MVR: 15.4, // Malé — band 12.85–15.42, sits at the ceiling in practice
  UZS: 12600, // Tashkent, Samarkand — crawling depreciation
  KHR: 4050, // Siem Reap, Phnom Penh ("Southeast Asia Adventure" preset)
  LAK: 21700, // Luang Prabang
  FJD: 2.25, // Nadi
};

/**
 * Currencies with a HARD PEG to another currency in the table, expressed as
 * the peg itself: [code, anchor, units of `code` per 1 anchor].
 *
 * Derived rather than written out so they can't drift away from their anchor:
 * edit EUR above and every euro-pegged entry moves with it, which is the only
 * correct behaviour for a fixed parity. A future reader should NOT "update"
 * these to a spot rate they looked up — the parity is the rate, and a number
 * pasted over it would be wrong the moment the anchor is next touched.
 *
 * Only genuine fixed parities go here. A managed float that merely LOOKS
 * stable (RON, MAD, BOB…) stays in FALLBACK_FLOATS.
 */
const FALLBACK_PEGS: ReadonlyArray<readonly [string, string, number]> = [
  // ── Euro parities, fixed and unchanged since the euro's introduction.
  // CFP franc: French Polynesia (Bora Bora, Tahiti, Moorea), New Caledonia,
  // Wallis & Futuna. This is the gap that started the audit — Bora Bora
  // returns hotels priced in XPF, so an FX outage dropped every row.
  ['XPF', 'EUR', 119.33174],
  ['XOF', 'EUR', 655.957], // West African CFA — Dakar, Abidjan, Cotonou, Lomé
  ['XAF', 'EUR', 655.957], // Central African CFA — Douala, Libreville
  ['BAM', 'EUR', 1.95583], // Bosnia (currency board) — Sarajevo, Mostar
  ['BGN', 'EUR', 1.95583], // Bulgaria (currency board) — Sofia; legacy now
  //                          that the country is on the euro, but a feed can
  //                          still quote it.

  // ── USD parities. The Gulf pegs have held for decades.
  ['SAR', 'USD', 3.75], // Saudi Arabia — Riyadh
  ['QAR', 'USD', 3.64], // Qatar — Doha
  ['OMR', 'USD', 0.3845], // Oman — Muscat
  ['BHD', 'USD', 0.376], // Bahrain — Manama
  ['JOD', 'USD', 0.709], // Jordan — Amman, Petra
  ['PAB', 'USD', 1], // Panama — balboa is 1:1 and circulates beside the dollar
  // Caribbean, where the pegs are the whole point: these are high-season
  // resort markets whose rows would otherwise vanish during an outage.
  ['XCD', 'USD', 2.7], // East Caribbean dollar — St Lucia, Antigua, Grenada,
  //                      St Vincent, St Kitts, Dominica
  ['BBD', 'USD', 2], // Barbados
  ['BSD', 'USD', 1], // Bahamas
  ['BZD', 'USD', 2], // Belize
  ['AWG', 'USD', 1.79], // Aruba
  ['ANG', 'USD', 1.79], // Netherlands Antillean guilder — Curaçao, St Maarten
  ['XCG', 'USD', 1.79], // …and the Caribbean guilder that replaced it, same peg
  ['KYD', 'USD', 1 / 1.2], // Cayman Islands — pegged at 1 KYD = 1.20 USD

  // ── Pegged to a neighbour rather than to EUR/USD.
  ['MOP', 'HKD', 1.03], // Macanese pataca — pegged to the HK dollar
  ['NPR', 'INR', 1.6], // Nepalese rupee — pegged to the Indian rupee
  ['BTN', 'INR', 1], // Bhutanese ngultrum — 1:1 with the Indian rupee
];

/**
 * Floats plus every peg resolved against its anchor.
 *
 * Exported for the coverage test, which walks every key and asserts it
 * converts — that is what stops the next currency from being added here
 * without one.
 */
export const FALLBACK_RATES: Record<string, number> = (() => {
  const table: Record<string, number> = { ...FALLBACK_FLOATS };
  for (const [code, anchor, perAnchor] of FALLBACK_PEGS) {
    const anchorRate = table[anchor];
    // An anchor someone has removed leaves the peg OUT of the table rather
    // than in it at a nonsense rate: a missing currency drops the row
    // visibly, a wrong one quotes the customer a confident wrong price.
    if (!anchorRate || anchorRate <= 0) continue;
    table[code] = anchorRate * perAnchor;
  }
  return table;
})();

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
      ttlMs: CACHE_TTL_MS,
    };
  } catch (err: any) {
    logger.warn('Currency API failed, using fallback rates', {
      message: err?.message,
      retryInMs: FALLBACK_TTL_MS,
    });
    return {
      rates: FALLBACK_RATES,
      fetchedAt: Date.now(),
      ttlMs: FALLBACK_TTL_MS,
    };
  }
}

async function getRates(): Promise<RateCache> {
  if (cache && Date.now() - cache.fetchedAt < cache.ttlMs) return cache;
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
 *
 * Returns `null` when we have no rate for the currency. It deliberately does
 * NOT pass the amount through: every caller relabels the result 'USD', and
 * the whole app downstream (trip totals, maxPrice filters, the frontend,
 * which prints a hardcoded `$` and never reads the currency field) treats
 * these numbers as dollars. A pass-through therefore turned 800,000 COP into
 * "$800,000". Callers decide what an unconvertible price means for them —
 * drop the offer, or mark it unpriced — but none of them may relabel it.
 *
 * On success returns `Math.round(amount * 100) / 100` — 2-decimal precision.
 */
export async function convertToUsd(
  amount: number,
  fromCurrency: string,
): Promise<number | null> {
  if (!Number.isFinite(amount) || amount === 0) return amount;
  const code = fromCurrency?.toUpperCase().trim();
  if (!code || code === 'USD') return Math.round(amount * 100) / 100;

  const { rates } = await getRates();
  const rate = rates[code] ?? FALLBACK_RATES[code];
  if (!rate || rate <= 0) {
    logger.warn('Unknown currency — cannot convert to USD', { code, amount });
    return null;
  }

  // rates are "1 USD = N <currency>", so to go from foreign → USD divide
  return Math.round((amount / rate) * 100) / 100;
}

/**
 * Batch conversion helper — converts a list of numbers at once using
 * a single rate lookup. Useful when converting many offers from the
 * same currency (e.g. a page of hotels all priced in JPY).
 *
 * Returns `null` for the whole batch when we have no rate, for the same
 * reason `convertToUsd` does: the batch is one currency, so it's all-or
 * -nothing, and a silent pass-through would be relabelled 'USD' by the
 * caller.
 */
export async function convertManyToUsd(
  amounts: number[],
  fromCurrency: string,
): Promise<number[] | null> {
  if (amounts.length === 0) return [];
  const code = fromCurrency?.toUpperCase().trim();
  if (!code || code === 'USD') return amounts.map((a) => Math.round(a * 100) / 100);

  const { rates } = await getRates();
  const rate = rates[code] ?? FALLBACK_RATES[code];
  if (!rate || rate <= 0) {
    logger.warn('Unknown currency — cannot convert batch to USD', { code, count: amounts.length });
    return null;
  }

  return amounts.map((a) =>
    Number.isFinite(a) && a !== 0 ? Math.round((a / rate) * 100) / 100 : a,
  );
}
