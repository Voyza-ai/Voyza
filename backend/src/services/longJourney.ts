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

/**
 * Small hours — leaving or arriving from 00:00 to 04:59 local time.
 *
 * Cheapest-first picked Prague → Vienna as an ÖBB train leaving at 00:36
 * ($120, 6h 53m), and Salzburg → Prague at 00:13 to save $26 over the 11:11;
 * the next cheapest Salzburg train left at 19:07 and arrived at 03:09. Either
 * way the traveller loses a night (a hotel paid for and left at midnight, or
 * a city reached with nowhere to go at 3 am). A small-hours option is still
 * offered, but every priced option at sensible hours goes first. A night train
 * that leaves in the evening and arrives in the morning is not small hours.
 */
export const SMALL_HOURS_END = 5;

type Clock = { departTime?: string | null; departure?: string | null; arriveTime?: string | null; arrival?: string | null };

/** HH from "00:36" or an ISO "2027-03-19T00:36"; null = unknown. */
function hourOf(hhmm: string | null | undefined, iso: string | null | undefined): number | null {
  const raw = (typeof hhmm === 'string' && hhmm) || (typeof iso === 'string' && iso.includes('T') ? iso.split('T')[1] : '');
  const m = /^(\d{1,2}):\d{2}/.exec(raw || '');
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h < 24 ? h : null;
}

/** True when the option leaves or arrives between 00:00 and 04:59; unknown times never count. */
export function inSmallHours(o: Clock): boolean {
  const dep = hourOf(o.departTime, o.departure);
  const arr = hourOf(o.arriveTime, o.arrival);
  return (dep != null && dep < SMALL_HOURS_END) || (arr != null && arr < SMALL_HOURS_END);
}

type Timed = Clock & {
  price: number | null | undefined;
  durationMinutes?: number | null;
};

/**
 * Sort key shared by every pick: priced before unpriced, then sensible hours
 * before small hours, then cheapest. Long journeys are ranked by the caller (their
 * limit depends on which options are judged together).
 */
export function pickKey(o: Timed): [number, number, number] {
  const priced = typeof o.price === 'number' && o.price > 0;
  return [priced ? 0 : 1, inSmallHours(o) ? 1 : 0, priced ? (o.price as number) : Infinity];
}

export function comparePick(a: Timed, b: Timed): number {
  const ka = pickKey(a);
  const kb = pickKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

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
 * still cheapest first). Within a group: unpriced options (null / 0) last,
 * and small-hours departures after every priced daytime one.
 * Stable: equal prices keep their order.
 */
export function sensibleFirst<T extends Timed>(options: T[]): T[] {
  const limit = longJourneyLimit(options.map((o) => o.durationMinutes));
  const rank = (o: T) => (isLongMinutes(o.durationMinutes, limit) ? 1 : 0);
  return options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || comparePick(a.o, b.o) || a.i - b.i)
    .map((x) => x.o);
}
