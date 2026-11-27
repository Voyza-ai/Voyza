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

/**
 * A caller's way to drop its Duffel searches that are not sent yet — for
 * optional work the plan stops waiting for.
 *
 * The date-shift probe starts as soon as ranking has the ordering, and its
 * searches may wait for the next Duffel minute (withDuffelRetryBudget). When
 * the plan's answer went out first, nobody read them, yet they were still sent
 * once the minute turned (~16 on a 3-city plan), into the window the next plan
 * needs. flights.ts asks `duffelCallCancelled()` before every attempt and sends
 * nothing once it says yes. A search another caller shares (flights.ts'
 * in-flight dedupe) fails with it, as with a retry budget.
 */
const cancelCheck = new AsyncLocalStorage<() => boolean>();

/** Run `fn` with its Duffel searches dropped, unsent, once `isCancelled()` turns true. */
export function withDuffelCancel<T>(isCancelled: () => boolean, fn: () => Promise<T>): Promise<T> {
  return cancelCheck.run(isCancelled, fn);
}

/** Whether the current call chain's Duffel searches have been given up on. */
export function duffelCallCancelled(): boolean {
  return cancelCheck.getStore()?.() ?? false;
}

/** The current call chain's cancel check, if any (tests read it after the chain is done). */
export function currentDuffelCancelCheck(): (() => boolean) | undefined {
  return cancelCheck.getStore();
}
