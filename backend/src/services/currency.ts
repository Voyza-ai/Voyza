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
 * Floating rates. Last-resort values in case the API is down.
 *
 * Taken verbatim from open.er-api.com/v6/latest/USD on 2026-10-23, rounded to
 * four significant figures, so they are internally consistent with each other
 * at that one vintage (EUR/USD 1.122). They are a stand-in for what the live
 * table WOULD have said, not an economic claim: where a country runs an
 * official rate alongside a divergent street rate, the number here is whatever
 * the API quotes, which is the same thing the live path would have used.
 *
 * THESE DRIFT. The previous set was labelled Apr 2026 and by Oct 2026 twenty of
 * them were more than 10% from live, the worst three being ARS at -41%, TRY at
 * -36% and ILS at +19%. A stale rate is worse than a missing currency: a
 * missing one drops the row visibly, a stale one quotes a confidently wrong
 * price. Re-read the feed and replace this block wholesale rather than patching
 * individual numbers from memory, and update the date above when you do.
 *
 * Pegged currencies do NOT belong here — see FALLBACK_PEGS below. AED is the
 * one exception: it is a hard peg at 3.6725, but it predates that split and the
 * value above is exact, so moving it would be churn for its own sake.
 */
const FALLBACK_FLOATS: Record<string, number> = {
  USD: 1,
  EUR: 0.8915,
  GBP: 0.7467,
  JPY: 156.9,
  CNY: 6.6882,
  KRW: 1325,
  INR: 94.9,
  CAD: 1.4014,
  AUD: 1.4253,
  CHF: 0.8213,
  SEK: 9.9102,
  NOK: 9.344,
  DKK: 6.6678,
  MXN: 18.73,
  BRL: 5.0428,
  ZAR: 16.5,
  THB: 33.73,
  SGD: 1.2773,
  HKD: 7.8372,
  NZD: 1.7596,
  TRY: 49.68,
  AED: 3.6725,
  RUB: 81.52,
  PLN: 3.8993,
  CZK: 21.63,
  HUF: 326.2,
  IDR: 18082,
  PHP: 63.53,
  VND: 25831,
  MYR: 4.083,
  ILS: 3.1107,
  ARS: 1528,
  EGP: 55.22,

  // ── Added after auditing the table against the destinations this app can
  // actually reach. Hotel search resolves ANY city name through Booking's
  // locations API, so the real bound isn't a city list — but every currency
  // below is one a hardcoded list, a shipped Browse preset or a target market
  // puts in front of us, and each was a dropped row while it was missing.
  // Same standard as the block above: approximate, not exact.

  // Europe — Browse presets and both city tables.
  ISK: 121.4, // Reykjavik ("Reykjavik Adventure Weekend" preset)
  UAH: 45.07, // Kyiv
  RON: 4.7649, // Bucharest (managed, ~5.05 per EUR)
  RSD: 104.8, // Belgrade (managed, ~117 per EUR)

  // Latin America — the "South America Grand Tour" preset plus worldCities.
  PEN: 3.4409, // Lima, Cusco, Machu Picchu
  COP: 3184, // Bogotá, Medellín, Cartagena
  CLP: 981.1, // Santiago
  UYU: 40.17, // Montevideo
  // La Paz. Bolivia ran an official ~6.9 for years with a far weaker street
  // rate; the feed now quotes 11.74, so the gap has moved into the official
  // number. Taking the feed is the point — this table's job is to say what the
  // live path would have said, not to pick a side.
  BOB: 11.74,
  CRC: 456.1, // San José
  // Two Caribbean floats, alongside the pegged ones further down: both are
  // mass-market beach destinations the planner suggests unprompted.
  DOP: 61.42, // Punta Cana, Santo Domingo
  JMD: 158.8, // Montego Bay, Kingston

  // Africa & Middle East.
  MAD: 9.8106, // Marrakech, Casablanca, Fez (basket-managed, ~10.8 per EUR)
  TND: 2.9987, // Tunis
  KES: 129.9, // Nairobi
  TZS: 2645, // Zanzibar
  NGN: 1325, // Lagos — volatile; the widest band of anything here

  // Asia-Pacific.
  TWD: 32.59, // Taipei
  LKR: 332, // Colombo
  MVR: 15.45, // Malé — band 12.85–15.42, sits at the ceiling in practice
  UZS: 11901, // Tashkent, Samarkand — crawling depreciation
  KHR: 4060, // Siem Reap, Phnom Penh ("Southeast Asia Adventure" preset)
  LAK: 22358, // Luang Prabang
  FJD: 2.2511, // Nadi
  // Indian Ocean beach destinations. Both were still missing after the first
  // audit, and both are destinations production returns no hotels for today —
  // so they would have been dropped twice over.
  MUR: 47.27, // Mauritius — Port Louis, Grand Baie, Flic-en-Flac
  SCR: 14.03, // Seychelles — Mahé, Praslin, La Digue
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
  // A non-finite amount is not convertible, and must not be returned as
  // though it were. This used to `return amount`, and because NaN !== null
  // every caller's `=== null` check passed it straight through — so a NaN
  // fare reached the trip total. Hotels happened to catch it downstream in
  // `dropUnusablePrices`; flights and trains did not.
  if (!Number.isFinite(amount)) return null;

  // Zero is genuinely zero in any currency, so it needs no rate.
  if (amount === 0) return 0;

  const code = fromCurrency?.toUpperCase().trim();

  // A BLANK OR MALFORMED CODE IS UNKNOWN, NOT USD. This used to fall into the
  // same branch as 'USD' and return the raw number, which is the
  // 800,000-COP-shown-as-$800,000 failure from the other side: the amount is
  // in some unit nobody has established, and everything downstream reads
  // HotelResult.price / FlightOffer.price as dollars. The three callers each
  // had their own `!x.currency` short-circuit doing the same thing, so a
  // provider sending `currency: ''` was trusted in four separate places.
  //
  // Returning null routes it to the drop path the callers already have for an
  // unconvertible currency, which is the honest answer: a row we cannot price
  // is a row we cannot show.
  if (!code || !/^[A-Z]{3}$/.test(code)) {
    logger.warn('Missing or malformed currency code — cannot convert to USD', {
      code: fromCurrency ?? null,
      amount,
    });
    return null;
  }

  if (code === 'USD') return Math.round(amount * 100) / 100;

  const { rates } = await getRates();
  const rate = rates[code] ?? FALLBACK_RATES[code];
  if (!rate || rate <= 0) {
    logger.warn('Unknown currency — cannot convert to USD', { code, amount });
    return null;
  }

  // rates are "1 USD = N <currency>", so to go from foreign → USD divide
  return Math.round((amount / rate) * 100) / 100;
}
