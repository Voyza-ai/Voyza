/**
 * Re-searching a leg the user chose, on a new date, without losing the choice.
 *
 * Production: the user accepted "a later flight home in the evening" (TAP
 * 21:25), then "Give Paris one more night". The date edit moved the flight
 * home to Jan 18 and re-searched it — and took the cheapest flight that day,
 * a midday Iberia 13:09: the evening was lost.
 *
 * A leg the user chose carries `userChoice` (frontend lib/types.ts
 * LegPreference): set when they Accept a chat change (with what they asked:
 * "evening", "after 15:00", "later" = after the flight they had) or pick an
 * option on the card by hand. When a city or date edit re-searches that leg,
 * the pick keeps the preference; legs the user never touched get the
 * cheapest sensible option. Either way, a very long journey (tripLegs.ts
 * LONG_RATIO) is only picked when nothing else exists.
 */
import { formatMinutes } from './tripLegs';
import { isLongMinutes, longJourneyLimit } from './longJourney';

export type LegPreference = {
  source: 'chat' | 'card';
  departTime: string | null;
  operator: string | null;
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | null;
  earliestDepart?: string | null;
  latestDepart?: string | null;
  earliestArrive?: string | null;
  latestArrive?: string | null;
};

/** Anything with the fields a pick reads: home-leg rows and leg options alike. */
export type Pickable = {
  departTime: string | null;
  arriveTime: string | null;
  operator: string;
  price: number;
  durationMinutes: number;
  /** Leg options carry it; home-leg rows (all flights) don't. */
  mode?: 'flight' | 'train';
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t: string | null | undefined) => (t && HHMM.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
const BANDS = { morning: ['05:00', '11:59'], afternoon: ['12:00', '16:59'], evening: ['17:00', '23:59'] } as const;
/** A hand-picked time stays "similar" within this many minutes either way. */
const SIMILAR_MIN = 120;
/** The same airline is preferred while it costs at most this much more. */
const SAME_AIRLINE_SLACK = 0.1;

export function readPreference(leg: any): LegPreference | null {
  const p = leg?.userChoice;
  if (!p || typeof p !== 'object') return null;
  if (p.source !== 'chat' && p.source !== 'card') return null;
  return {
    source: p.source,
    departTime: typeof p.departTime === 'string' ? p.departTime : null,
    operator: typeof p.operator === 'string' && p.operator ? p.operator : null,
    timeOfDay: p.timeOfDay === 'morning' || p.timeOfDay === 'afternoon' || p.timeOfDay === 'evening' ? p.timeOfDay : null,
    earliestDepart: HHMM.test(p.earliestDepart ?? '') ? p.earliestDepart : null,
    latestDepart: HHMM.test(p.latestDepart ?? '') ? p.latestDepart : null,
    earliestArrive: HHMM.test(p.earliestArrive ?? '') ? p.earliestArrive : null,
    latestArrive: HHMM.test(p.latestArrive ?? '') ? p.latestArrive : null,
  };
}

/** "an evening flight", "a flight departing after 15:00", "a flight around 21:25". */
export function describePreference(p: LegPreference): string {
  if (p.timeOfDay) return `${p.timeOfDay === 'afternoon' ? 'an' : p.timeOfDay === 'evening' ? 'an' : 'a'} ${p.timeOfDay} flight`;
  const bits: string[] = [];
  if (p.earliestDepart && p.latestDepart) bits.push(`departing ${p.earliestDepart}–${p.latestDepart}`);
  else if (p.earliestDepart) bits.push(`departing after ${p.earliestDepart}`);
  else if (p.latestDepart) bits.push(`departing before ${p.latestDepart}`);
  if (p.earliestArrive) bits.push(`arriving after ${p.earliestArrive}`);
  if (p.latestArrive) bits.push(`arriving before ${p.latestArrive}`);
  if (bits.length) return `a flight ${bits.join(', ')}`;
  return p.departTime ? `a flight around ${p.departTime}` : 'the flight you chose';
}

/** Does this option keep the user's time preference? */
export function keepsPreference(o: Pickable, p: LegPreference): boolean {
  const dep = toMin(o.departTime);
  const arr = toMin(o.arriveTime);
  const within = (t: number | null, lo: string | null | undefined, hi: string | null | undefined) =>
    t != null && (lo == null || t >= toMin(lo)!) && (hi == null || t <= toMin(hi)!);
  if (p.timeOfDay) {
    const [lo, hi] = BANDS[p.timeOfDay];
    if (!within(dep, lo, hi)) return false;
  }
  if (p.earliestDepart || p.latestDepart) {
    if (!within(dep, p.earliestDepart, p.latestDepart)) return false;
  }
  if (p.earliestArrive || p.latestArrive) {
    if (!within(arr, p.earliestArrive, p.latestArrive)) return false;
  }
  const hasTimeRule = !!(p.timeOfDay || p.earliestDepart || p.latestDepart || p.earliestArrive || p.latestArrive);
  if (!hasTimeRule) {
    // A hand-picked (or exactly selected) flight: a similar time.
    const want = toMin(p.departTime);
    if (want != null && (dep == null || Math.abs(dep - want) > SIMILAR_MIN)) return false;
  }
  return true;
}

export type Pick<T> = {
  /** The chosen option first, then the rest cheapest first. */
  ordered: T[];
  /** Said in the proposal: the preference kept, or what was picked instead. */
  note: string | null;
};

/**
 * Pick the option for a re-searched leg. Sensible journeys only (unless none
 * exist); with a preference, the cheapest that keeps it — the same airline
 * when that costs at most 10% more — and, when none keeps it, the cheapest
 * sensible one with a note saying so.
 */
export function pickByPreference<T extends Pickable>(options: T[], pref: LegPreference | null, label: string, when: string): Pick<T> {
  const byPrice = [...options].sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
  if (byPrice.length === 0) return { ordered: [], note: null };
  // Long against the fastest option of its OWN mode, as compareLeg and
  // orderLegOptions judge it. Across modes, Salzburg → Prague (2027-03-21)
  // judged every train against a 3h 40m one-stop flight (limit 7h 20m): the
  // $381.99 and $387.87 trains (9h 10m, 8h 02m) were dropped as "long" and the
  // chat picked the $408.17 one, while the 6h 01m train made them sensible.
  const limitFor = new Map<string | undefined, number | null>();
  for (const mode of new Set(byPrice.map((o) => o.mode))) {
    limitFor.set(mode, longJourneyLimit(byPrice.filter((o) => o.mode === mode).map((o) => o.durationMinutes)));
  }
  const sensible = byPrice.filter((o) => !isLongMinutes(o.durationMinutes, limitFor.get(o.mode) ?? null));
  const pool = sensible.length > 0 ? sensible : byPrice;

  let pick = pool[0];
  let note: string | null = null;
  if (pref) {
    const keeping = pool.filter((o) => keepsPreference(o, pref));
    if (keeping.length > 0) {
      const cheapest = keeping[0];
      const same = pref.operator
        ? keeping.find((o) => o.operator && o.operator.toLowerCase() === pref.operator!.toLowerCase() && o.price <= cheapest.price * (1 + SAME_AIRLINE_SLACK))
        : undefined;
      pick = same ?? cheapest;
      note = `Kept your choice for ${label}: ${describePreference(pref)} (${pick.operator || 'flight'} ${pick.departTime ?? ''}).`.replace(' )', ')');
    } else {
      const long = byPrice.filter((o) => keepsPreference(o, pref) && !sensible.includes(o));
      const why = long.length > 0
        ? ` (only ones taking ${formatMinutes(Math.min(...long.map((o) => o.durationMinutes)))}+)`
        : '';
      note = `There's no ${describePreference(pref).replace(/^an? /, '')} for ${label} on ${when}${why}, so I picked ${pick.operator || 'a flight'} ${pick.departTime ?? ''} instead.`.replace(' ,', ',').replace(/\s+instead/, ' instead');
    }
  }
  return { ordered: [pick, ...byPrice.filter((o) => o !== pick)], note };
}
