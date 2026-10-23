/**
 * The FX fallback table, and what it costs when a currency is missing from it.
 *
 * Measured against production: Bora Bora returns real hotels, priced by the
 * provider in XPF. XPF was not in FALLBACK_RATES, so for as long as the
 * fallback was the active table `convertToUsd` returned null for every one of
 * those rows and `searchHotels` dropped them — the user saw a French
 * Polynesia city card with zero hotels and no explanation. Nothing failed
 * loudly; the city just went empty.
 *
 * So the table's coverage is itself behaviour worth testing. These tests force
 * the fallback to be the active table (the FX fetch always fails here) and
 * then assert:
 *   - every currency in the table converts, so a new entry can't be added
 *     with a rate of 0, a typo'd string or a missing anchor;
 *   - XPF lands at the right ORDER OF MAGNITUDE for a real Bora Bora room,
 *     which is what catches a rate that is off by a factor of ten;
 *   - the pegged entries are still derived from their anchor, not pasted over
 *     with a spot rate — a peg that stops tracking EUR is a stale price that
 *     looks authoritative;
 *   - an unconvertible currency still returns null rather than passing the
 *     foreign amount through to be relabelled 'USD' downstream.
 */

type CurrencyModule = typeof import('../services/currency');

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** FX unreachable — the case the whole fallback table exists for. */
const fxDown = () => mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

/** FX up, answering with just the rates given. */
const fxUp = (rates: Record<string, number>) =>
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ result: 'success', rates }),
  });

/**
 * A fresh copy of the module. Rates are cached in module scope, so tests that
 * exercise the cache and its TTL need their own instance rather than whatever
 * state the previous test left behind.
 */
function loadCurrency(): CurrencyModule {
  let mod!: CurrencyModule;
  jest.isolateModules(() => {
    mod = require('../services/currency');
  });
  return mod;
}

/** Captured logger output — `logger.warn` goes to stderr. */
let warnings: Array<Record<string, unknown>>;
let errSpy: jest.SpyInstance;

beforeEach(() => {
  jest.restoreAllMocks();
  mockFetch.mockReset();
  warnings = [];
  errSpy = jest.spyOn(console, 'error').mockImplementation((line?: unknown) => {
    warnings.push(JSON.parse(String(line)));
  });
});

afterEach(() => {
  errSpy.mockRestore();
});

/**
 * What `convertToUsd` must return for EUR while the fallback table is active,
 * computed the same way the implementation does (round to 2dp). Deriving it
 * keeps these tests pinned to the fallback ENGAGING rather than to a rate that
 * is refreshed whenever the table drifts.
 */
const eurFromTable = (amount: number) =>
  Math.round((amount / loadCurrency().FALLBACK_RATES.EUR) * 100) / 100;


describe('FALLBACK_RATES coverage', () => {
  it('converts every currency in the table to a finite positive number', async () => {
    fxDown();
    const { convertToUsd, FALLBACK_RATES } = loadCurrency();

    const broken: Array<[string, unknown]> = [];
    for (const code of Object.keys(FALLBACK_RATES)) {
      // 1000 units: large enough that no plausible rate rounds it to zero.
      const usd = await convertToUsd(1000, code);
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
        broken.push([code, usd]);
      }
    }

    expect(broken).toEqual([]);
  });

  it('holds a rate that is itself finite and positive for every entry', () => {
    const { FALLBACK_RATES } = loadCurrency();

    const broken = Object.entries(FALLBACK_RATES).filter(
      ([, rate]) => !Number.isFinite(rate) || rate <= 0,
    );

    expect(broken).toEqual([]);
    // Guards against the table being accidentally emptied or half-built: a
    // peg whose anchor is gone is deliberately skipped, so a typo in an
    // anchor name shows up here as a shrinking table.
    expect(Object.keys(FALLBACK_RATES).length).toBeGreaterThan(70);
  });
});

describe('XPF — the Bora Bora case', () => {
  it('prices a real overwater room in the right order of magnitude', async () => {
    fxDown();
    const { convertToUsd } = loadCurrency();

    // A nightly rate in the range the provider actually returns for a Bora
    // Bora overwater bungalow.
    const usd = await convertToUsd(200_000, 'XPF');

    // The failure this is really guarding against is a rate off by a factor
    // of ten in either direction — $18 or $180,000 both sail through any
    // "is it a number" check and both reach the UI as a confident price.
    expect(usd).not.toBeNull();
    expect(usd!).toBeGreaterThan(1_500);
    expect(usd!).toBeLessThan(2_200);
  });

  it('is case-insensitive, like every other code', async () => {
    fxDown();
    const { convertToUsd } = loadCurrency();

    expect(await convertToUsd(200_000, 'xpf')).toBe(await convertToUsd(200_000, 'XPF'));
  });

  it('converts a whole page of XPF hotels, leaving unpriced rows alone', async () => {
    fxDown();
    const { convertManyToUsd } = loadCurrency();

    const converted = await convertManyToUsd([200_000, 95_000, 0], 'XPF');

    expect(converted).not.toBeNull();
    expect(converted![0]).toBeGreaterThan(1_500);
    expect(converted![1]).toBeGreaterThan(700);
    expect(converted![1]).toBeLessThan(1_000);
    // 0 means "unknown" across this codebase; dividing it by a rate would
    // dress it up as a real $0.00 price.
    expect(converted![2]).toBe(0);
  });

  it('still converts when the live API answers without XPF in its table', async () => {
    fxUp({ EUR: 0.5 }); // live, but missing the code we need
    const { convertToUsd } = loadCurrency();

    // Live rates win where they exist…
    expect(await convertToUsd(100, 'EUR')).toBe(200);
    // …and the fallback fills the gap rather than dropping the row.
    const usd = await convertToUsd(200_000, 'XPF');
    expect(usd!).toBeGreaterThan(1_500);
    expect(usd!).toBeLessThan(2_200);
  });
});

describe('pegged currencies track their anchor', () => {
  /**
   * [code, anchor, units of code per 1 anchor] — the documented parity, held
   * here as a second copy so a change to the table has to be made twice.
   *
   * `toBe` rather than `toBeCloseTo` on purpose: the assertion repeats the
   * exact multiplication the module performs, so it holds for ANY value of
   * the anchor. That is the point — edit EUR in the table and XPF moves with
   * it and this still passes, while an XPF hardcoded to a spot rate fails
   * immediately.
   */
  const pegs: Array<[string, string, number]> = [
    ['XPF', 'EUR', 119.33174],
    ['XOF', 'EUR', 655.957],
    ['XAF', 'EUR', 655.957],
    ['BAM', 'EUR', 1.95583],
    ['BGN', 'EUR', 1.95583],
    ['SAR', 'USD', 3.75],
    ['QAR', 'USD', 3.64],
    ['OMR', 'USD', 0.3845],
    ['BHD', 'USD', 0.376],
    ['JOD', 'USD', 0.709],
    ['PAB', 'USD', 1],
    ['XCD', 'USD', 2.7],
    ['BBD', 'USD', 2],
    ['BSD', 'USD', 1],
    ['BZD', 'USD', 2],
    ['AWG', 'USD', 1.79],
    ['ANG', 'USD', 1.79],
    ['XCG', 'USD', 1.79],
    ['KYD', 'USD', 1 / 1.2],
    ['MOP', 'HKD', 1.03],
    ['NPR', 'INR', 1.6],
    ['BTN', 'INR', 1],
  ];

  it.each(pegs)('%s is derived from %s at its fixed parity', (code, anchor, perAnchor) => {
    const { FALLBACK_RATES } = loadCurrency();

    expect(FALLBACK_RATES[code]).toBe(FALLBACK_RATES[anchor] * perAnchor);
  });

  it('keeps XPF at 119.33174 to the euro whatever the euro rate is', () => {
    const { FALLBACK_RATES } = loadCurrency();

    // The peg stated as a ratio, so this reads as the parity rather than as
    // arithmetic: 1 EUR = 119.33174 XPF, a hard peg, not a float.
    expect(FALLBACK_RATES.XPF / FALLBACK_RATES.EUR).toBeCloseTo(119.33174, 4);
  });
});

describe('a currency we have no rate for', () => {
  it('returns null instead of passing the foreign amount through', async () => {
    fxDown();
    const { convertToUsd } = loadCurrency();

    // 800,000 of something unknown. The regression this pins: returning the
    // amount got it relabelled 'USD' by the caller and printed as "$800,000".
    expect(await convertToUsd(800_000, 'ZZZ')).toBeNull();
  });

  it('fails the whole batch rather than part of it', async () => {
    fxDown();
    const { convertManyToUsd } = loadCurrency();

    expect(await convertManyToUsd([100, 200], 'ZZZ')).toBeNull();
    // An empty batch is not a failure.
    expect(await convertManyToUsd([], 'ZZZ')).toEqual([]);
  });

  it('says so in the log, since the caller drops the row silently', async () => {
    fxDown();
    const { convertToUsd } = loadCurrency();

    await convertToUsd(800_000, 'ZZZ');

    const unknown = warnings.filter((w) => w.message === 'Unknown currency — cannot convert to USD');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ level: 'warn', code: 'ZZZ', amount: 800_000 });
  });

  it('returns 0 and NaN amounts untouched, before any rate lookup', async () => {
    fxDown();
    const { convertToUsd } = loadCurrency();

    // Documented: 0 means "unknown" elsewhere, so it is passed through as-is
    // for any currency, known or not.
    expect(await convertToUsd(0, 'ZZZ')).toBe(0);
    // Current behaviour, pinned rather than endorsed: a NaN price is NOT
    // null, so the callers' `=== null` check does not catch it and a NaN
    // survives conversion. Reported separately; the fix belongs in the
    // callers that parseFloat provider prices.
    expect(Number.isNaN((await convertToUsd(NaN, 'XPF')) as number)).toBe(true);
  });
});

describe('fallback engagement and cache TTL', () => {
  const t0 = Date.UTC(2026, 9, 23, 12, 0, 0);
  const atTime = (ms: number) => jest.spyOn(Date, 'now').mockReturnValue(ms);

  it('engages when the FX fetch fails, and says why', async () => {
    fxDown();
    const { convertToUsd } = loadCurrency();

    // Derived from the table rather than hardcoded: these tests pin that the
    // fallback ENGAGED, not what today's EUR rate happens to be. A literal
    // here breaks every time the rates are refreshed, which is a false
    // alarm on a chore that should stay cheap.
    expect(await convertToUsd(100, 'EUR')).toBe(eurFromTable(100));

    const failures = warnings.filter(
      (w) => w.message === 'Currency API failed, using fallback rates',
    );
    expect(failures).toHaveLength(1);
    // The short retry window is the thing that stops one blip costing a day
    // of pricing for every currency outside the table.
    expect(failures[0]).toMatchObject({ level: 'warn', retryInMs: 5 * 60 * 1000 });
  });

  it('engages on a non-200 and on a non-success body too', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const down = loadCurrency();
    expect(await down.convertToUsd(100, 'EUR')).toBe(eurFromTable(100));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: 'error', 'error-type': 'quota-reached' }),
    });
    const quota = loadCurrency();
    expect(await quota.convertToUsd(100, 'EUR')).toBe(eurFromTable(100));
  });

  it('reuses the fallback for 5 minutes, then retries', async () => {
    atTime(t0);
    fxDown();
    const { convertToUsd } = loadCurrency();

    await convertToUsd(100, 'EUR');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Inside the retry window: no second call.
    atTime(t0 + 4 * 60 * 1000);
    expect(await convertToUsd(100, 'EUR')).toBe(eurFromTable(100));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Past it: retry, and a recovered API takes over immediately.
    atTime(t0 + 5 * 60 * 1000 + 1);
    fxUp({ EUR: 0.5 });
    expect(await convertToUsd(100, 'EUR')).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('holds a successful fetch for 24 hours', async () => {
    atTime(t0);
    fxUp({ EUR: 0.5 });
    const { convertToUsd } = loadCurrency();

    expect(await convertToUsd(100, 'EUR')).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Well past the fallback's 5m window but inside the live 24h one.
    atTime(t0 + 23 * 60 * 60 * 1000);
    expect(await convertToUsd(100, 'EUR')).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    atTime(t0 + 24 * 60 * 60 * 1000 + 1);
    await convertToUsd(100, 'EUR');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight fetch between concurrent conversions', async () => {
    atTime(t0);
    fxDown();
    const { convertToUsd } = loadCurrency();

    const results = await Promise.all([
      convertToUsd(100, 'EUR'),
      convertToUsd(200_000, 'XPF'),
      convertToUsd(1000, 'ISK'),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r !== null)).toBe(true);
  });
});
