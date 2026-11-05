import { addDays, clampToFuture } from '../utils/dates';
import { logger } from '../utils/logger';
import { MAX_STAY_NIGHTS } from './constraints';
import { searchHotels, roomsFor, type HotelResult } from './hotels';
import { searchLegOptions, type LegOption } from './legOptions';
import { buildHomeLeg, firstStayArrival, type HomeLeg } from './optimizer';
import { getCityCountry } from '../data/cityCountries';
import { resolve } from './location/resolve';
import { originIndex } from './location/originAirports';

/**
 * Post-results city edits from the AI chat: add_city, remove_city and
 * replace_city on /api/plan/chat.
 *
 * Two halves:
 *
 *  - `planCityEdit` is pure. It decides the new city list and its dates, and
 *    lists exactly what was priced for the old trip and no longer holds — the
 *    hotels whose stay dates moved, the legs whose ends or day changed, and
 *    the home flights whose trip end changed.
 *  - `buildCityEditProposal` prices only that list with the same services the
 *    optimizer uses (hotel search, searchLegOptions, buildHomeLeg) and returns
 *    a proposal. Nothing is applied: the frontend shows it as a diff card and
 *    applies it on Accept (lib/cityEdit.ts there).
 *
 * Date rules — chosen so an edit moves as little as possible:
 *  - replace: the new city takes the old city's exact dates.
 *  - remove: the trip keeps its length. The previous city keeps the removed
 *    city's nights (the next city, when the first one goes), so the flights
 *    home stay on their days.
 *  - add: the new city gets `nights` (default 2) after `afterCity` (default:
 *    the last city) and everything after it moves later by that much — the
 *    trip gets longer rather than taking nights from a city the user didn't
 *    mention.
 */

export type CityEditOp =
  | { kind: 'add'; city: string; afterCity?: string | null; nights?: number | null }
  | { kind: 'remove'; city: string }
  | { kind: 'replace'; oldCity: string; newCity: string };

export type Stop = { name: string; arrival: string; departure: string };

export type PlannedStop = Stop & {
  /** kept = untouched; moved = same city, new dates; added / replaced = a new city. */
  status: 'kept' | 'moved' | 'added' | 'replaced';
  /** For status 'replaced': the city it stands in for. */
  replaces?: string;
  /** For kept / moved: the index in the ORIGINAL trip. */
  fromIndex?: number;
};

export type CityEditPlan = {
  after: PlannedStop[];
  removed: string[];
  /** Indexes into `after` whose hotels must be searched for their dates. */
  hotels: number[];
  /** Indexes i into `after`: the leg after[i] → after[i + 1] must be priced. */
  legs: number[];
  outbound: boolean;
  ret: boolean;
  /** One plain sentence about where the nights went. */
  note: string;
};

export const DEFAULT_ADDED_NIGHTS = 2;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function nightsBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Decide the new trip. `{ ok: false, reason }` reads as "I couldn't …: <reason>." */
export function planCityEdit(
  stops: Stop[],
  op: CityEditOp,
): { ok: true; plan: CityEditPlan } | { ok: false; reason: string } {
  if (stops.length === 0) return { ok: false, reason: 'this trip has no cities yet' };
  const names = stops.map((s) => s.name).join(', ');
  const indexOf = (city: string) => stops.findIndex((s) => sameName(s.name, city));
  const kept = (s: Stop, i: number): PlannedStop => ({ ...s, status: 'kept', fromIndex: i });
  const last = stops.length - 1;

  if (op.kind === 'replace') {
    const idx = indexOf(op.oldCity);
    if (idx < 0) return { ok: false, reason: `${op.oldCity} isn't in this trip (it has ${names})` };
    if (sameName(op.oldCity, op.newCity)) return { ok: false, reason: `that's the same city` };
    const dup = indexOf(op.newCity);
    if (dup >= 0) return { ok: false, reason: `${stops[dup].name} is already in this trip` };
    const after = stops.map(kept);
    after[idx] = {
      name: op.newCity,
      arrival: stops[idx].arrival,
      departure: stops[idx].departure,
      status: 'replaced',
      replaces: stops[idx].name,
    };
    const legs: number[] = [];
    if (idx > 0) legs.push(idx - 1);
    if (idx < last) legs.push(idx);
    return {
      ok: true,
      plan: {
        after,
        removed: [stops[idx].name],
        hotels: [idx],
        legs,
        outbound: idx === 0,
        ret: idx === last,
        note: `${op.newCity} takes ${stops[idx].name}'s dates, so nothing else moves.`,
      },
    };
  }

  if (op.kind === 'remove') {
    const idx = indexOf(op.city);
    if (idx < 0) return { ok: false, reason: `${op.city} isn't in this trip (it has ${names})` };
    if (stops.length === 1) {
      return {
        ok: false,
        reason: `${stops[0].name} is the only city in this trip, and a trip needs at least one — ask me to replace it with another city instead`,
      };
    }
    const removed = stops[idx];
    const nights = nightsBetween(removed.arrival, removed.departure);
    const after: PlannedStop[] = stops.map(kept);
    let absorber: number;
    if (idx > 0) {
      absorber = idx - 1;
      after[absorber] = { ...after[absorber], departure: removed.departure, status: 'moved' };
    } else {
      absorber = idx + 1;
      after[absorber] = { ...after[absorber], arrival: removed.arrival, status: 'moved' };
    }
    after.splice(idx, 1);
    const absorberAfter = absorber > idx ? absorber - 1 : absorber;
    const legs: number[] = [];
    // The new leg prev → next, on the day prev now leaves.
    if (idx > 0 && idx < last) legs.push(idx - 1);
    return {
      ok: true,
      plan: {
        after,
        removed: [removed.name],
        hotels: [absorberAfter],
        legs,
        outbound: idx === 0,
        ret: idx === last,
        note: `${after[absorberAfter].name} keeps ${removed.name}'s ${plural(nights, 'night')}, so your trip dates don't change.`,
      },
    };
  }

  // add
  const dup = indexOf(op.city);
  if (dup >= 0) return { ok: false, reason: `${stops[dup].name} is already in this trip` };
  let afterIdx = last;
  if (op.afterCity) {
    afterIdx = indexOf(op.afterCity);
    if (afterIdx < 0) return { ok: false, reason: `${op.afterCity} isn't in this trip (it has ${names})` };
  }
  const requested = op.nights == null ? DEFAULT_ADDED_NIGHTS : Number(op.nights);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_STAY_NIGHTS) {
    return {
      ok: false,
      reason: `a stay has to be a whole number of nights from 1 to ${MAX_STAY_NIGHTS}, and I got ${JSON.stringify(op.nights)}`,
    };
  }
  const n = requested;
  const arrival = stops[afterIdx].departure;
  const added: PlannedStop = { name: op.city, arrival, departure: addDays(arrival, n), status: 'added' };
  const after: PlannedStop[] = [];
  stops.forEach((s, i) => {
    if (i <= afterIdx) after.push(kept(s, i));
    else after.push({ name: s.name, arrival: addDays(s.arrival, n), departure: addDays(s.departure, n), status: 'moved', fromIndex: i });
    if (i === afterIdx) after.push(added);
  });
  const newIdx = afterIdx + 1;
  const hotels = after.map((_, i) => i).filter((i) => i >= newIdx);
  // Every leg from the city before the new one onwards: the two that touch
  // it, plus the later ones whose day moved.
  const legs = after.map((_, i) => i).filter((i) => i >= afterIdx && i < after.length - 1);
  const shifted = after.length - 1 - newIdx;
  return {
    ok: true,
    plan: {
      after,
      removed: [],
      hotels,
      legs,
      outbound: false,
      ret: true,
      note:
        shifted === 1
          ? `${op.city} adds ${plural(n, 'night')} after ${stops[afterIdx].name}, so ${after[after.length - 1].name} moves ${plural(n, 'day')} later.`
          : shifted > 1
          ? `${op.city} adds ${plural(n, 'night')} after ${stops[afterIdx].name}, so the ${shifted} cities after it move ${plural(n, 'day')} later.`
          : `${op.city} adds ${plural(n, 'night')} at the end, so you fly home ${plural(n, 'day')} later.`,
    },
  };
}

/**
 * Is `name` a city we can plan a stay in? Uses the checked-in location
 * index. A country is refused (the planner needs a city); a near
 * miss answers with "did you mean". A name shared by several cities is
 * accepted (the searches read it against the rest of the trip). A name the index has never heard of and
 * has nothing close to is let through — the index only holds places with
 * airports, so Amalfi is "unknown" — and is judged by the searches instead.
 */
export type CityCheck =
  | { ok: true }
  | { ok: false; reply: string };

export function checkCityName(name: string, otherCities: string[]): CityCheck {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { ok: false, reply: 'Which city did you mean?' };
  let r: any;
  try {
    r = resolve(trimmed, { tripDestinationNames: otherCities }, originIndex());
  } catch (err: any) {
    logger.warn('cityEdit: location resolve failed', { name: trimmed, message: err?.message });
    return { ok: true };
  }
  if (r.status === 'resolved') {
    if (r.place.kind === 'country' || r.place.kind === 'state' || r.place.kind === 'region') {
      return { ok: false, reply: `${trimmed} is a ${r.place.kind}, not a city — which city there should I use?` };
    }
    return { ok: true };
  }
  if (r.status === 'ambiguous') {
    const cands: any[] = r.candidates ?? [];
    if (cands.some((c) => c.place?.kind === 'country')) {
      return { ok: false, reply: `${trimmed} is a country, not a city — which city there should I use?` };
    }
    // Several cities share the name (Venice, Italy / Venice, Florida). The
    // searches already resolve a name against the rest of the trip, so the
    // name is fine as it is.
    return { ok: true };
  }
  const suggestions: string[] = (r.suggestions ?? []).slice(0, 3).map((c: any) => c.label);
  if (suggestions.length > 0) {
    return { ok: false, reply: `I couldn't find a city called ${trimmed}. Did you mean ${orList(suggestions)}?` };
  }
  return { ok: true };
}

function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

// ─── Pricing the plan ─────────────────────────────────────────────

export type CityEditLeg = {
  /** Index i into `after`: after[i] → after[i + 1]. */
  index: number;
  from: string;
  to: string;
  date: string;
  /** Cheapest first, flights and trains mixed (searchLegOptions). Empty = nothing found. */
  options: LegOption[];
};

export type CityEditProposal = {
  kind: 'city_edit';
  toolName: 'add_city' | 'remove_city' | 'replace_city';
  op: CityEditOp;
  before: Stop[];
  after: Array<PlannedStop & { hotels?: HotelResult[] }>;
  removed: string[];
  legs: CityEditLeg[];
  /** Present only when re-searched. null = searched, nothing found. */
  outboundLeg?: HomeLeg | null;
  returnLeg?: HomeLeg | null;
  note: string;
};

function stopsOf(trip: any): Stop[] {
  return (trip?.cities ?? []).map((c: any) => ({
    name: String(c.name ?? ''),
    arrival: c.dates?.arrival ?? c.arrival_date ?? '',
    departure: c.dates?.departure ?? c.departure_date ?? '',
  }));
}

/** The day the outbound leaves: the flight's own day, else the first stay's arrival. */
function tripStart(trip: any, stops: Stop[]): string {
  return trip?.origin?.outboundLeg?.departDate ?? stops[0]?.arrival;
}

/**
 * Plan, check and price one city edit. Returns either a proposal or the
 * plain reply the chat should answer with instead ("I couldn't …").
 */
export async function buildCityEditProposal(
  currentTrip: any,
  toolName: CityEditProposal['toolName'],
  op: CityEditOp,
): Promise<{ type: 'proposal'; proposal: CityEditProposal } | { type: 'answer'; reply: string }> {
  const before = stopsOf(currentTrip);
  if (before.some((s) => !s.arrival || !s.departure)) {
    return { type: 'answer', reply: "I couldn't change the cities: some of them have no dates yet." };
  }
  const attempt =
    op.kind === 'add' ? `add ${op.city}` : op.kind === 'remove' ? `remove ${op.city}` : `replace ${op.oldCity} with ${op.newCity}`;

  const planned = planCityEdit(before, op);
  if (!planned.ok) return { type: 'answer', reply: `I couldn't ${attempt}: ${planned.reason}.` };
  const { plan } = planned;

  const newCity = op.kind === 'add' ? op.city : op.kind === 'replace' ? op.newCity : null;
  if (newCity) {
    const others = plan.after.filter((s) => !sameName(s.name, newCity)).map((s) => s.name);
    const check = checkCityName(newCity, others);
    if (!check.ok) return { type: 'answer', reply: check.reply };
  }

  const travelers = Number.isInteger(currentTrip?.travelers) && currentTrip.travelers > 0 ? currentTrip.travelers : 1;
  const tripCityNames = plan.after.map((s) => s.name);
  const countryOf = (name: string) => {
    const orig = (currentTrip.cities ?? []).find((c: any) => sameName(c.name, name));
    return orig?.country || getCityCountry(name);
  };

  const hotelJobs = plan.hotels.map(async (i) => {
    const s = plan.after[i];
    try {
      return await searchHotels({ city: s.name, checkin: s.arrival, checkout: s.departure, adults: travelers, rooms: roomsFor(travelers) });
    } catch (err: any) {
      logger.warn('cityEdit: hotel search failed', { city: s.name, message: err?.message });
      return [] as HotelResult[];
    }
  });

  const legJobs = plan.legs.map(async (i): Promise<CityEditLeg> => {
    const from = plan.after[i];
    const to = plan.after[i + 1];
    const date = from.departure;
    try {
      const r = await searchLegOptions({
        from: from.name,
        to: to.name,
        date: clampToFuture(date),
        travelers,
        fromCountry: countryOf(from.name),
        toCountry: countryOf(to.name),
        limit: 4,
        tripCityNames,
      });
      return { index: i, from: from.name, to: to.name, date, options: r.options };
    } catch (err: any) {
      logger.warn('cityEdit: leg search failed', { from: from.name, to: to.name, message: err?.message });
      return { index: i, from: from.name, to: to.name, date, options: [] };
    }
  });

  const origin = currentTrip?.origin;
  const airports: string[] = Array.isArray(origin?.airports) ? origin.airports.filter(Boolean) : [];
  const returnAirports: string[] =
    Array.isArray(origin?.returnAirports) && origin.returnAirports.length > 0 ? origin.returnAirports : airports;
  const returnsHome = (currentTrip?.returnToHome ?? true) !== false;
  const wantOutbound = plan.outbound && !!origin?.city && airports.length > 0;
  const wantReturn = plan.ret && returnsHome && !!origin?.city && returnAirports.length > 0;
  const start = tripStart(currentTrip, before);
  const first = plan.after[0];
  const lastStop = plan.after[plan.after.length - 1];

  const outboundJob = wantOutbound
    ? buildHomeLeg({
        originAirports: airports,
        destinationCity: first.name,
        date: clampToFuture(start),
        travelers,
        originCity: origin.city,
        tripCityNames,
      }).catch(() => null)
    : Promise.resolve(undefined);
  const returnJob = wantReturn
    ? buildHomeLeg({
        originAirports: returnAirports,
        destinationCity: lastStop.name,
        date: clampToFuture(lastStop.departure),
        travelers,
        reverse: true,
        originCity: origin.returnCity ?? origin.city,
        tripCityNames,
      }).catch(() => null)
    : Promise.resolve(undefined);

  const [hotelResults, legs, outboundLeg, returnLeg] = await Promise.all([
    Promise.all(hotelJobs),
    Promise.all(legJobs),
    outboundJob,
    returnJob,
  ]);

  const after: CityEditProposal['after'] = plan.after.map((s) => ({ ...s }));
  plan.hotels.forEach((i, k) => {
    after[i].hotels = hotelResults[k];
  });

  // A new city nothing could be found for — no hotel and no way in or out —
  // is almost always a name that isn't a place we can plan. Say so rather
  // than propose a trip with a $0 stay and "no option" legs.
  if (newCity) {
    const idx = after.findIndex((s) => sameName(s.name, newCity));
    const touching = legs.filter((l) => l.index === idx - 1 || l.index === idx);
    const noHotels = (after[idx]?.hotels ?? []).length === 0;
    const homeTouch = [idx === 0 ? outboundLeg : undefined, idx === after.length - 1 ? returnLeg : undefined].filter(
      (l) => l !== undefined,
    );
    const noTravel =
      touching.every((l) => l.options.length === 0) && homeTouch.every((l) => l == null);
    if (noHotels && noTravel) {
      return {
        type: 'answer',
        reply: `I couldn't ${attempt}: I found no hotels in ${newCity} and no flights or trains to it. Is that the right spelling?`,
      };
    }
  }

  // The first stay starts when the new outbound lands (the optimizer's rule).
  if (outboundLeg && outboundLeg.arriveDate) {
    const arrival = firstStayArrival({
      startDate: start,
      firstDeparture: after[0].departure,
      landed: outboundLeg.arriveDate,
      city: after[0].name,
    });
    if (arrival !== after[0].arrival) {
      after[0].arrival = arrival;
      if (after[0].status === 'kept') after[0].status = 'moved';
    }
  }

  const proposal: CityEditProposal = {
    kind: 'city_edit',
    toolName,
    op,
    before,
    after,
    removed: plan.removed,
    legs,
    note: plan.note,
  };
  if (outboundLeg !== undefined) proposal.outboundLeg = outboundLeg;
  if (returnLeg !== undefined) proposal.returnLeg = returnLeg;
  return { type: 'proposal', proposal };
}

/** The chat's tool input → an op, or null when a required field is missing. */
export function cityEditOpFromTool(toolName: string, input: any): CityEditOp | null {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (toolName === 'add_city') {
    const city = str(input?.city);
    if (!city) return null;
    const nights = input?.nights;
    return { kind: 'add', city, afterCity: str(input?.afterCity), nights: nights == null ? null : nights };
  }
  if (toolName === 'remove_city') {
    const city = str(input?.city);
    return city ? { kind: 'remove', city } : null;
  }
  if (toolName === 'replace_city') {
    const oldCity = str(input?.old ?? input?.oldCity);
    const newCity = str(input?.new ?? input?.newCity);
    return oldCity && newCity ? { kind: 'replace', oldCity, newCity } : null;
  }
  return null;
}
