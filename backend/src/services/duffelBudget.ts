import { AsyncLocalStorage } from 'async_hooks';

/**
 * A caller's cap on how long its Duffel calls may wait to retry — for work
 * that is optional.
 *
 * flights.ts bounds every Duffel call to MAX_TOTAL_RETRY_WAIT_MS of retry
 * waiting (one rate-limit window). That is right for the searches a plan
 * cannot do without, and wrong for the extras: the optimizer's date-shift
 * probe ("leave a day early, save $X") is a banner, and when Duffel is
 * rate-limited it should give way rather than hold the whole plan for
 * another 60-second window.
 *
 * The cap travels with the async call chain (AsyncLocalStorage), so nothing
 * between the optimizer and flights.ts — scoreRoute, compareLeg,
 * searchHomeFlights — needs a new parameter. It lives in its own module so
 * suites that mock './flights' still get the real thing.
 */
const retryWaitBudget = new AsyncLocalStorage<number>();

/** Run `fn` with its Duffel calls allowed at most `maxWaitMs` of retry waiting each. */
export function withDuffelRetryBudget<T>(maxWaitMs: number, fn: () => Promise<T>): Promise<T> {
  return retryWaitBudget.run(Math.max(0, maxWaitMs), fn);
}

/** The cap in force for the current call chain, or undefined for none. */
export function currentDuffelRetryBudget(): number | undefined {
  return retryWaitBudget.getStore();
}
