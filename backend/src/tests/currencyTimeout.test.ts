/**
 * A rate fetch that never answers must not stall every conversion.
 *
 * `convertToUsd` single-flights the FX fetch: every non-USD conversion in the
 * process waits on one shared promise. That fetch had no timeout, so a
 * provider that accepted the connection and then went quiet held it until
 * undici's own headersTimeout (300 s) — five minutes in which every EUR flight,
 * JPY hotel and CHF train price in the process was waiting on the same dead
 * socket. Reproduced at 54fd844: after 2 s the USD conversion had settled and
 * the EUR and JPY ones had not, one fetch had been made, and it carried no
 * abort signal.
 *
 * The fake fetch below behaves the way undici does: it never resolves on its
 * own, and rejects only when the caller's signal fires — once for a stalled
 * connection, and again for a response whose body stalls after the headers.
 */

// A module, not a script: currency.test.ts declares the same top-level names,
// and `tsc` type-checks every test file in one program.
export {};

type CurrencyModule = typeof import('../services/currency');

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Rejects only when `signal` fires, with the signal's own reason — like fetch. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

function loadCurrency(): CurrencyModule & { logger: typeof import('../utils/logger').logger } {
  let mod!: CurrencyModule;
  let logger!: typeof import('../utils/logger').logger;
  jest.isolateModules(() => {
    mod = require('../services/currency');
    // The same isolated copy currency.ts imported, so a spy on it is seen.
    logger = require('../utils/logger').logger;
  });
  return { ...mod, logger };
}

let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.restoreAllMocks();
  mockFetch.mockReset();
  // logger.warn goes to stderr; keep the run readable.
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

it('a stalled FX connection is given up after ~10 s and every waiting conversion settles at the fallback rate', async () => {
  // Real timers on purpose: this is the one test that proves the deadline is
  // an actual clock and not a promise someone has to resolve by hand.
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => untilAborted(init?.signal ?? undefined));
  const { convertToUsd, FALLBACK_RATES } = loadCurrency();

  const started = Date.now();
  const settled: Array<[string, number | null, number]> = [];
  const track = (label: string, p: Promise<number | null>) =>
    p.then((v) => settled.push([label, v, Date.now() - started]));

  const all = Promise.all([
    track('EUR flight', convertToUsd(100, 'EUR')),
    track('JPY hotel', convertToUsd(5000, 'JPY')),
  ]);
  // Bounded wait, so the unfixed code fails with a message instead of a Jest
  // timeout: it would still be waiting at 13 s (and at 300 s).
  let bound: NodeJS.Timeout | undefined;
  await Promise.race([all, new Promise((r) => (bound = setTimeout(r, 13_000)))]);
  clearTimeout(bound);

  expect(settled.map(([label]) => label).sort()).toEqual(['EUR flight', 'JPY hotel']);
  for (const [, , ms] of settled) {
    expect(ms).toBeGreaterThanOrEqual(9_900);
    expect(ms).toBeLessThan(12_000);
  }
  expect(settled.find(([l]) => l === 'EUR flight')?.[1]).toBe(
    Math.round((100 / FALLBACK_RATES.EUR) * 100) / 100,
  );
  expect(settled.find(([l]) => l === 'JPY hotel')?.[1]).toBe(
    Math.round((5000 / FALLBACK_RATES.JPY) * 100) / 100,
  );
  // Still single-flight: both conversions shared the one fetch.
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
}, 20_000);

describe('with the deadline driven by hand', () => {
  /**
   * `AbortSignal.timeout` runs on Node's internal timers, which Jest's fake
   * timers do not reach, so these tests hand out a controller's signal in its
   * place and fire it themselves. They check what happens AT the deadline;
   * the test above checks that the deadline is real and roughly 10 s.
   */
  let fire: () => void;
  let requestedMs: number[];
  beforeEach(() => {
    requestedMs = [];
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      requestedMs.push(ms);
      const controller = new AbortController();
      fire = () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      return controller.signal;
    });
  });

  it('cuts off a response whose headers arrive and whose body then stalls', async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve({ ok: true, json: () => untilAborted(init?.signal ?? undefined) }),
    );
    const { convertToUsd, FALLBACK_RATES } = loadCurrency();

    let result: number | null | undefined;
    const pending = convertToUsd(100, 'EUR').then((v) => (result = v));
    await new Promise((r) => setImmediate(r));
    expect(result).toBeUndefined(); // headers in, body stalled — still waiting

    fire();
    await pending;
    expect(result).toBe(Math.round((100 / FALLBACK_RATES.EUR) * 100) / 100);
    expect(requestedMs).toEqual([10_000]);
  });

  it('does not hand the dead fetch to later callers: once the fallback expires, the next conversion fetches again and gets the live rate', async () => {
    mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => untilAborted(init?.signal ?? undefined));
    const { convertToUsd, FALLBACK_RATES } = loadCurrency();

    const first = convertToUsd(100, 'EUR');
    await new Promise((r) => setImmediate(r));
    fire();
    expect(await first).toBe(Math.round((100 / FALLBACK_RATES.EUR) * 100) / 100);

    // The fallback table is held for its short TTL (5 min), then retried.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: 'success', rates: { USD: 1, EUR: 0.8 } }),
    });
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 5 * 60 * 1000 + 1);

    expect(await convertToUsd(100, 'EUR')).toBe(125);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

it('a shared fetch that REJECTS is not kept as the in-flight promise for everyone after it', async () => {
  // fetchRates turns every failure it sees into the fallback table, so the
  // only way to make it reject is to break its own error path. Before the
  // `finally`, the rejected promise stayed in `inflightFetch` for good and
  // every later non-USD conversion in the process rejected with it.
  mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND open.er-api.com'));
  const { convertToUsd, logger } = loadCurrency();
  jest.spyOn(logger, 'warn').mockImplementationOnce(() => {
    throw new Error('logger blew up');
  });

  await expect(convertToUsd(100, 'EUR')).rejects.toThrow('logger blew up');

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ result: 'success', rates: { USD: 1, EUR: 0.8 } }),
  });
  expect(await convertToUsd(100, 'EUR')).toBe(125);
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
