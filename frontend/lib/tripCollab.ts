import type { City, Trip } from './types';
import { withColorIndices } from './cityColors';

/**
 * What collaborators send each other while a shared trip is open on the
 * results page, and what the owner's save keeps as the trip's session: the
 * same `{ trip, cities }` shape the canvas used, so a session saved by the
 * old canvas still loads, and the summaries of proposed changes
 * (summarizeCanvasChanges) still read it.
 */
export type CollabState = {
  trip: {
    title?: string;
    travelers?: number;
    origin?: Trip['origin'] | null;
    returnToHome?: boolean;
    constraints?: Trip['constraints'];
    budget?: number;
    /**
     * The saving "vs your original city order" and the date-shift tip. A
     * hand rearrangement drops both; without them in the state, everyone
     * but the person who rearranged kept showing the stale saving box.
     */
    savings?: number;
    dateShiftSuggestion?: Trip['dateShiftSuggestion'] | null;
    dateShiftChecked?: boolean;
    /**
     * The stored total the saving box is measured against. A receiver kept
     * its own (the 4-city price) after a city was removed, and showed the
     * difference as "You can save $X".
     */
    totalCost?: number;
  };
  cities: City[];
};

export function tripToCollabState(trip: Trip): CollabState {
  return {
    trip: {
      title: trip.title,
      travelers: trip.travelers,
      origin: trip.origin ?? null,
      returnToHome: trip.returnToHome,
      ...(trip.constraints !== undefined ? { constraints: trip.constraints } : {}),
      ...(trip.budget !== undefined ? { budget: trip.budget } : {}),
      ...(typeof trip.savings === 'number' ? { savings: trip.savings } : {}),
      dateShiftSuggestion: trip.dateShiftSuggestion ?? null,
      ...(typeof trip.dateShiftChecked === 'boolean' ? { dateShiftChecked: trip.dateShiftChecked } : {}),
      ...(typeof trip.totalCost === 'number' ? { totalCost: trip.totalCost } : {}),
    },
    cities: trip.cities,
  };
}

/** Compares two trips as collaborators see them (what a broadcast carries). */
export function collabSignature(trip: Trip): string {
  // Without the stored total: it is re-derived on each screen as searches
  // settle, which is not anyone's edit (a suggester's page settling its
  // total read as an unsent change).
  const { totalCost: _total, ...t } = tripToCollabState(trip).trip;
  return JSON.stringify({ trip: t, cities: trip.cities });
}

/**
 * Put a collaborator's state on the trip on screen. Only the parts the state
 * carries change; what this page derived for itself (stored totals, the
 * date-shift tip, the AI picks run) stays. Cities saved before hotels[] or
 * selectedHotelIndex existed are normalised the way the canvas did.
 */
/**
 * A session save made by Blue, the text assistant (backend
 * services/textbot/applier.ts), on the owner's behalf: a traveller texted YES.
 * It carries `savedVia: 'text'` and a fresh `textSaveId`.
 */
export type TextSaveMark = { savedVia?: string; textSaveId?: string };

/**
 * Whether an OWNER's open tab should put a session save on screen. Their own
 * saves come back as echoes and are ignored (that's why the owner normally
 * skips session saves); a save Blue made from a texted YES is not theirs and
 * must be applied, or this tab's next autosave would write its older copy
 * over the change. Applied once per save (by `textSaveId`).
 */
export function ownerShouldApplySessionSave(state: unknown, lastAppliedTextSaveId: string | null): string | null {
  const s = (state ?? {}) as TextSaveMark;
  if (s.savedVia !== 'text' || typeof s.textSaveId !== 'string' || !s.textSaveId) return null;
  return s.textSaveId === lastAppliedTextSaveId ? null : s.textSaveId;
}

/** A session state written by the website: never carries Blue's mark (see ownerShouldApplySessionSave). */
export function withoutTextSaveMark<T extends Record<string, any>>(state: T): T {
  const { savedVia: _v, textSaveId: _id, ...rest } = state ?? ({} as T);
  return rest as T;
}

export function applyCollabState(cur: Trip, state: Partial<CollabState> | null | undefined): Trip {
  if (!state || !Array.isArray(state.cities) || state.cities.length === 0) return cur;
  const t = state.trip ?? {};
  const cities = withColorIndices(
    state.cities.map((c: any) => ({
      ...c,
      hotels: Array.isArray(c.hotels) && c.hotels.length > 0 ? c.hotels : c.hotel ? [c.hotel] : [],
      selectedHotelIndex: typeof c.selectedHotelIndex === 'number' ? c.selectedHotelIndex : 0,
      activities: Array.isArray(c.activities) ? c.activities : [],
      restaurants: Array.isArray(c.restaurants) ? c.restaurants : [],
    })),
  ) as City[];
  return {
    ...cur,
    cities,
    ...(typeof t.title === 'string' ? { title: t.title } : {}),
    ...(typeof t.travelers === 'number' && t.travelers > 0 ? { travelers: t.travelers } : {}),
    ...(t.origin !== undefined ? { origin: t.origin ?? undefined } : {}),
    ...(typeof t.returnToHome === 'boolean' ? { returnToHome: t.returnToHome } : {}),
    ...(t.constraints !== undefined ? { constraints: t.constraints } : {}),
    ...(typeof t.savings === 'number' ? { savings: t.savings } : {}),
    ...(t.dateShiftSuggestion !== undefined ? { dateShiftSuggestion: t.dateShiftSuggestion ?? undefined } : {}),
    ...(typeof t.dateShiftChecked === 'boolean' ? { dateShiftChecked: t.dateShiftChecked } : {}),
    ...(typeof t.totalCost === 'number' && t.totalCost > 0 ? { totalCost: t.totalCost } : {}),
  };
}

/**
 * True while a collaborator's change is being put on the trip. The results
 * page re-prices what a date change leaves stale (hotels, legs, home
 * flights) — but a received change was already re-priced on the sender's
 * screen, and every receiver searching again would multiply the searches.
 * Read synchronously inside store subscribers (they run during setTrip).
 */
let applyingRemote = false;
let lastRemoteAt = 0;

export function withRemoteApply(fn: () => void): void {
  applyingRemote = true;
  lastRemoteAt = Date.now();
  try {
    fn();
  } finally {
    applyingRemote = false;
  }
}

export function isApplyingRemote(): boolean {
  return applyingRemote;
}

/** A collaborator's change landed within `ms` — effects that run after render use this. */
export function remoteAppliedWithin(ms: number): boolean {
  return Date.now() - lastRemoteAt < ms;
}

/**
 * The dates a list of stays gets when its order or membership changes:
 * chained night after night from the trip's EARLIEST real arrival, each stay
 * keeping its own number of nights, so moving a city never moves the trip's
 * start. A city just added carries a 2000-01-01 placeholder arrival that only
 * encodes its nights. Same rule the canvas used.
 */
export function rechainDates<T extends { dates: { arrival: string; departure: string } }>(cities: T[]): T[] {
  if (cities.length === 0) return cities;
  const isPlaceholder = (iso: string) => iso.startsWith('2000-');
  let start = '';
  for (const c of cities) {
    const a = c.dates?.arrival;
    if (a && a.includes('-') && !isPlaceholder(a) && (!start || a < start)) start = a;
  }
  if (!start) start = cities.find((c) => c.dates?.arrival?.includes('-'))?.dates.arrival ?? '';
  if (!start) return cities;

  const parse = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const toIso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  let cursor = parse(start);
  return cities.map((c) => {
    let nights = 2;
    if (c.dates?.arrival?.includes('-') && c.dates?.departure?.includes('-')) {
      nights = Math.max(1, Math.round((parse(c.dates.departure).getTime() - parse(c.dates.arrival).getTime()) / 86400000));
    }
    const arrival = toIso(cursor);
    const dep = new Date(cursor);
    dep.setDate(dep.getDate() + nights);
    cursor = dep;
    return { ...c, dates: { arrival, departure: toIso(dep) } };
  });
}

// ── Merging edits made at the same time ─────────────────────────────────
//
// A broadcast carries the sender's whole trip, and receivers used to replace
// theirs with it. Two people editing within the same second each overwrote
// the other: measured with four people, the owner removed Rome while an
// editor removed Pisa, and everyone ended up with Pisa gone but Rome back.
//
// So a broadcast also carries WHAT changed since the state it was made from
// (its `base`). A receiver still on that same state takes the whole trip as
// before (exact). One that has moved on — it made its own change meanwhile —
// applies just the delta to its own trip, so both changes survive. Removals,
// additions, per-city changes and trip fields commute; a reorder is applied
// to the cities both sides have.

const cityKey = (c: { name: string }) => c.name.trim().toLowerCase();

type TripFields = Omit<CollabState['trip'], 'totalCost'>;
function tripFields(trip: Trip): TripFields {
  const { totalCost: _t, ...rest } = tripToCollabState(trip).trip;
  return rest;
}

export type CollabDelta = {
  /** collabSignature of the state the change was made from. */
  base: string;
  removed: string[];
  added: { city: City; after: string | null }[];
  changed: City[];
  /** The sender's full order, when it rearranged the cities both had. */
  order: string[] | null;
  /** Trip fields the sender changed. */
  trip: Partial<TripFields>;
  /** The sender's route ("Rome → Venice"), to tell an auto title. */
  route: string;
};

export function computeCollabDelta(base: Trip, latest: Trip): CollabDelta {
  const bk = base.cities.map(cityKey);
  const lk = latest.cities.map(cityKey);
  const bset = new Set(bk);
  const lset = new Set(lk);
  const baseBy = new Map(base.cities.map((c) => [cityKey(c), c]));
  const commonB = bk.filter((k) => lset.has(k));
  const commonL = lk.filter((k) => bset.has(k));
  const bf = tripFields(base) as Record<string, unknown>;
  const lf = tripFields(latest) as Record<string, unknown>;
  const trip: Record<string, unknown> = {};
  for (const k of Array.from(new Set(Object.keys(bf).concat(Object.keys(lf))))) {
    if (JSON.stringify(bf[k]) !== JSON.stringify(lf[k])) trip[k] = lf[k] === undefined ? null : lf[k];
  }
  return {
    base: collabSignature(base),
    removed: bk.filter((k) => !lset.has(k)),
    added: latest.cities
      .map((city, i) => ({ city, i }))
      .filter(({ city }) => !bset.has(cityKey(city)))
      .map(({ city, i }) => ({ city, after: i > 0 ? cityKey(latest.cities[i - 1]) : null })),
    changed: latest.cities.filter((c) => {
      const was = baseBy.get(cityKey(c));
      return !!was && JSON.stringify(was) !== JSON.stringify(c);
    }),
    order: commonB.join('|') !== commonL.join('|') ? lk : null,
    trip: trip as Partial<TripFields>,
    route: latest.cities.map((c) => c.name).join(' → '),
  };
}

export function applyCollabDelta(cur: Trip, d: CollabDelta): Trip {
  const removed = new Set(d.removed);
  const changed = new Map(d.changed.map((c) => [cityKey(c), c]));
  let cities: City[] = cur.cities.filter((c) => !removed.has(cityKey(c))).map((c) => changed.get(cityKey(c)) ?? c);
  for (const { city, after } of d.added) {
    if (cities.some((c) => cityKey(c) === cityKey(city))) continue;
    const i = after == null ? -1 : cities.findIndex((c) => cityKey(c) === after);
    const at = after == null ? 0 : i < 0 ? cities.length : i + 1;
    cities = [...cities.slice(0, at), city, ...cities.slice(at)];
  }
  if (d.order) {
    const rank = new Map(d.order.map((k, i) => [k, i]));
    const slots = cities.map((c, i) => (rank.has(cityKey(c)) ? i : -1)).filter((i) => i >= 0);
    const ranked = slots.map((i) => cities[i]).sort((a, b) => rank.get(cityKey(a))! - rank.get(cityKey(b))!);
    cities = [...cities];
    slots.forEach((slot, j) => (cities[slot] = ranked[j]));
  }
  if (cities.length === 0) return cur;
  cities = rechainDates(cities);
  const merged = applyCollabState(cur, { trip: d.trip as CollabState['trip'], cities });
  // An auto title ("Rome → Venice") follows the merged stops; a chosen name stays.
  const curRoute = cur.cities.map((c) => c.name).join(' → ');
  const wasAuto = !cur.title || cur.title === curRoute || (d.trip.title !== undefined && d.trip.title === d.route);
  if (wasAuto) merged.title = cities.map((c) => c.name).join(' → ');
  if (d.trip.dateShiftSuggestion === null) merged.dateShiftSuggestion = undefined;
  return merged;
}

/** Adjacent pairs whose leg doesn't join them (left over from before a merge). */
export function staleLegIndices(trip: Trip): number[] {
  const out: number[] = [];
  for (let i = 0; i < trip.cities.length - 1; i++) {
    const c = trip.cities[i];
    const t = c.transportOut;
    const to = trip.cities[i + 1];
    if (
      !t ||
      !t.operator ||
      (!!t.to && t.to.toLowerCase() !== to.name.toLowerCase()) ||
      (!!t.from && t.from.toLowerCase() !== c.name.toLowerCase())
    )
      out.push(i);
  }
  return out;
}
