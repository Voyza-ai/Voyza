/**
 * Long journeys — one rule for every place that picks a flight or train.
 *
 * An option is a LONG journey when it takes more than LONG_RATIO × the leg's
 * fastest option that day AND more than LONG_EXTRA_MIN minutes longer than it.
 *
 * Picked from Duffel's own offers for the production trip (test mode,
 * 2026-11-16): London → New York, Jan 17, 364 offers — nonstops 8h00–8h32,
 * ordinary one-stops 10h30–16h, then a separate cluster of overnight
 * connections at 22h–32h (TAP via Lisbon 29h–31h: the "later evening flight
 * home" production proposed, 30h 30m for +$431). Paris → New York looks the
 * same (8h17 nonstop, 26h–32h overnight); New York → Paris tops out at 19h.
 * Paris → London: 58m–1h20 nonstop, one-stops from 3h50.
 *
 * 1.5× / +3h would cut transatlantic at 12h, dropping London → New York's
 * median offer (12h05) and ordinary 12h30 one-stops. 2× / +3h cuts it at 16h:
 * every normal one-stop stays, every overnight 22h+ connection goes. On a
 * one-hour hop the +3h side decides (≈ 4h): nonstops stay, 4h+ detours go.
 *
 * Used by the AI chat (tripLegs.ts, legPreference.ts) and by the planner:
 * compareLeg.ts (route ranking, and re-pricing a card) and legOptions.ts (the
 * options a new plan's leg cards are filled from). Before the planner used it,
 * it priced Prague → Vienna (55m nonstop, $368) as a 22h 50m itinerary at $301
 * because that was the cheapest offer.
 *
 * A duration that is missing or not positive is unknown, never long: we can't
 * call a journey long when we don't know how long it is.
 */
export const LONG_RATIO = 2;
export const LONG_EXTRA_MIN = 180;

function known(m: unknown): m is number {
  return typeof m === 'number' && Number.isFinite(m) && m > 0;
}

/** The longest a sensible option may take, from the fastest known duration; null = none known. */
export function longJourneyLimit(minutes: Array<number | null | undefined>): number | null {
  const ok = minutes.filter(known);
  if (ok.length === 0) return null;
  const fastest = Math.min(...ok);
  return Math.max(fastest * LONG_RATIO, fastest + LONG_EXTRA_MIN);
}

export function isLongMinutes(minutes: number | null | undefined, limit: number | null): boolean {
  return limit != null && known(minutes) && minutes > limit;
}

type Timed = { price: number | null | undefined; durationMinutes?: number | null };

/**
 * The cheapest option that is not a long journey; the cheapest of all when
 * every option is long (all of them are, by this rule, only when none is
 * known — the fastest is never long). undefined for an empty list.
 * Unpriced options (null / 0) lose to any priced one.
 */
export function cheapestSensible<T extends Timed>(options: T[]): T | undefined {
  return sensibleFirst(options)[0];
}

/**
 * Cheapest first, with long journeys after every sensible option (each group
 * still cheapest first). Unpriced options (null / 0) go last within a group.
 * Stable: equal prices keep their order.
 */
export function sensibleFirst<T extends Timed>(options: T[]): T[] {
  const limit = longJourneyLimit(options.map((o) => o.durationMinutes));
  const rank = (o: T) => (isLongMinutes(o.durationMinutes, limit) ? 1 : 0);
  const price = (o: T) => (typeof o.price === 'number' && o.price > 0 ? o.price : Infinity);
  return options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || price(a.o) - price(b.o) || a.i - b.i)
    .map((x) => x.o);
}
