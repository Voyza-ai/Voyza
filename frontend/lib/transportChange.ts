import type { HomeLeg, Transport, Trip } from './types';
import type { ChatLegRef, LegChoice, LegOptionsPayload, TransportChangeProposal } from './api';
import { liveTripTotal } from './tripTotals';
import { reconcileTripTransport } from './transportReconcile';

/**
 * Apply the AI chat's transport changes to a trip — any leg, the flights to
 * and from home included.
 *
 * Where each leg lives:
 *  - home → first city: `trip.origin.outboundLeg` (a HomeLeg, its other
 *    options on `.alternatives`);
 *  - city i → city i + 1: `cities[i].transportOut`, mirrored (without
 *    alternatives) on `cities[i + 1].transportIn`;
 *  - last city → home: `trip.origin.returnLeg`. The last city's own
 *    `transportOut` is an empty placeholder and is never the flight home.
 *
 * A switch works like picking an alternative on the card (tripStore
 * setTransportOut / setHomeLegAlternative): the chosen option becomes the
 * leg's selection and the old one goes first among its alternatives. The one
 * date that can move is the first stay's arrival, when the backend's
 * proposal says the new outbound lands another day (`firstStay`). The trip's
 * stored `totalCost` is left alone, as a card pick leaves it: the header
 * prices the live trip (liveTripTotal).
 *
 * Pure: the same trip and proposal give the same result.
 */

/** Alternatives a card shows (Connector renders them in one row). */
const MAX_ALTERNATIVES = 4;

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const samePrice = (a: number, b: number) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.01;
const eqOpt = (a: string | null | undefined, b: string | null | undefined) =>
  !a || !b || a.toUpperCase() === b.toUpperCase();

/** A Transport that is the "nothing found here" placeholder. */
function isPlaceholder(t: Transport | null | undefined): boolean {
  return !t || t.unavailable === true || (!(Number(t.price) > 0) && !String(t.operator ?? '').trim());
}

export function choiceMatchesHomeLeg(c: LegChoice, h: Omit<HomeLeg, 'alternatives'> | null | undefined): boolean {
  if (!h) return false;
  return (
    norm(c.operator) === norm(h.operator) &&
    (c.departTime ?? null) === (h.departTime ?? null) &&
    eqOpt(c.departDate, h.departDate) &&
    eqOpt(c.fromAirport, h.originAirport) &&
    eqOpt(c.toAirport, h.destAirport) &&
    samePrice(c.price, h.price)
  );
}

export function choiceMatchesTransport(c: LegChoice, t: Transport | null | undefined): boolean {
  if (!t) return false;
  return (
    c.mode === t.mode &&
    norm(c.operator) === norm(t.operator) &&
    (c.departTime ?? null) === (t.departTime ?? null) &&
    samePrice(c.price, t.price)
  );
}

function choiceToHomeLeg(c: LegChoice, fallbackDate: string | null): Omit<HomeLeg, 'alternatives'> {
  return {
    originAirport: c.fromAirport ?? '',
    destAirport: c.toAirport ?? '',
    price: c.price,
    currency: c.currency || 'USD',
    durationMinutes: c.durationMinutes,
    operator: c.operator,
    carrierCode: c.flightNumber ?? '',
    departTime: c.departTime,
    arriveTime: c.arriveTime,
    departDate: c.departDate ?? fallbackDate ?? '',
    ...(c.arriveDate ? { arriveDate: c.arriveDate } : {}),
    stops: c.stops,
    bookingUrl: c.bookingUrl,
  };
}

function choiceToTransport(c: LegChoice, from: string, to: string, fallbackDate: string | null): Transport {
  return {
    mode: c.mode,
    operator: c.operator,
    duration: c.duration,
    price: c.price,
    from,
    to,
    departTime: c.departTime ?? undefined,
    arriveTime: c.arriveTime ?? undefined,
    departDate: c.departDate ?? fallbackDate ?? undefined,
    layovers: c.mode === 'flight' ? c.stops : 0,
    bookingUrl: c.bookingUrl ?? undefined,
    flightNumber: c.mode === 'flight' ? (c.flightNumber ?? undefined) : undefined,
    trainNumber: c.mode === 'train' ? (c.flightNumber ?? undefined) : undefined,
  };
}

const flatHome = (h: HomeLeg): Omit<HomeLeg, 'alternatives'> => {
  const { alternatives: _a, ...rest } = h;
  return rest;
};
const flatTransport = (t: Transport): Transport => {
  const { alternatives: _a, ...rest } = t;
  return rest;
};

type LegNow =
  | { kind: 'outbound' | 'return'; slot: 'outboundLeg' | 'returnLeg'; current: HomeLeg | null }
  | { kind: 'intercity'; index: number; current: Transport | null };

/**
 * The leg `ref` names, on the trip as it is now, or null when the trip no
 * longer has it (cities removed or reordered since the chat answered).
 */
export function findLeg(trip: Trip, ref: ChatLegRef): LegNow | null {
  if (ref.kind === 'outbound' || ref.kind === 'return') {
    if (!trip.origin?.city || trip.cities.length === 0) return null;
    if (ref.kind === 'return' && trip.returnToHome === false) return null;
    const city = ref.kind === 'outbound' ? trip.cities[0] : trip.cities[trip.cities.length - 1];
    if (norm(city.name) !== norm(ref.kind === 'outbound' ? ref.to : ref.from)) return null;
    const slot = ref.kind === 'outbound' ? 'outboundLeg' : 'returnLeg';
    return { kind: ref.kind, slot, current: trip.origin[slot] ?? null };
  }
  const pairAt = (i: number) =>
    i >= 0 &&
    i + 1 < trip.cities.length &&
    norm(trip.cities[i].name) === norm(ref.from) &&
    norm(trip.cities[i + 1].name) === norm(ref.to);
  const index = pairAt(ref.index) ? ref.index : trip.cities.findIndex((_, i) => pairAt(i));
  if (index < 0) return null;
  const t = trip.cities[index].transportOut;
  return { kind: 'intercity', index, current: isPlaceholder(t) ? null : t };
}

/**
 * Does the proposal still describe the trip — the leg exists and still has
 * the option the proposal was priced against? If the traveller changed that
 * leg since (picked another flight on the card), Accept must not apply a
 * difference that was computed for something else.
 */
export function transportChangeApplies(trip: Trip, p: TransportChangeProposal): boolean {
  const leg = findLeg(trip, p.leg);
  if (!leg) return false;
  if (!p.before) return leg.current == null;
  if (leg.kind === 'intercity') return choiceMatchesTransport(p.before, leg.current);
  return choiceMatchesHomeLeg(p.before, leg.current);
}

/** The trip with the proposal's leg switched to `p.after`. Unchanged when it no longer applies. */
export function applyTransportChange(trip: Trip, p: TransportChangeProposal): Trip {
  if (!transportChangeApplies(trip, p)) return trip;
  const leg = findLeg(trip, p.leg)!;

  if (leg.kind === 'intercity') {
    const i = leg.index;
    const cities = [...trip.cities];
    const cur = leg.current;
    const alts = cur?.alternatives ?? [];
    const at = alts.findIndex((a) => choiceMatchesTransport(p.after, a));
    const chosen = at >= 0 ? flatTransport(alts[at]) : choiceToTransport(p.after, cities[i].name, cities[i + 1].name, p.leg.date);
    const rest = alts.filter((_, k) => k !== at).map(flatTransport);
    const nextAlts = (cur ? [flatTransport(cur), ...rest] : rest).slice(0, MAX_ALTERNATIVES);
    cities[i] = { ...cities[i], transportOut: { ...chosen, alternatives: nextAlts } };
    cities[i + 1] = { ...cities[i + 1], transportIn: chosen };
    return reconcileTripTransport({ ...trip, cities });
  }

  const origin = trip.origin!;
  const cur = leg.current;
  const alts = cur?.alternatives ?? [];
  const at = alts.findIndex((a) => choiceMatchesHomeLeg(p.after, a));
  const chosen = at >= 0 ? alts[at] : choiceToHomeLeg(p.after, p.leg.date);
  const rest = alts.filter((_, k) => k !== at);
  const nextAlts = (cur ? [flatHome(cur), ...rest] : rest).slice(0, MAX_ALTERNATIVES);
  const nextLeg: HomeLeg = { ...chosen, ...(nextAlts.length > 0 ? { alternatives: nextAlts } : {}) };

  let cities = trip.cities;
  // The first stay starts the day the new outbound lands — the date the
  // proposal showed and priced (backend firstStayArrival, the same rule as
  // a card pick in tripStore.setHomeLegAlternative).
  const fs = leg.kind === 'outbound' ? p.firstStay : null;
  if (fs && cities[0] && norm(cities[0].name) === norm(fs.city) && cities[0].dates.arrival === fs.arrivalBefore) {
    cities = [{ ...cities[0], dates: { ...cities[0].dates, arrival: fs.arrivalAfter } }, ...cities.slice(1)];
  }
  return reconcileTripTransport({ ...trip, cities, origin: { ...origin, [leg.slot]: nextLeg } });
}

/** What the proposal card shows: the header total before → after, priced on the client. */
export function transportChangeTotals(trip: Trip, p: TransportChangeProposal): { before: number; after: number } {
  return { before: liveTripTotal(trip), after: liveTripTotal(applyTransportChange(trip, p)) };
}

/**
 * Put the options the chat listed for a leg on its card, first, without
 * changing the selection (or the total). A leg with nothing selected keeps
 * its card as it is: the options are in the chat reply.
 */
export function applyLegOptions(trip: Trip, payload: LegOptionsPayload): Trip {
  const leg = findLeg(trip, payload.leg);
  if (!leg || !leg.current || payload.options.length === 0) return trip;

  if (leg.kind === 'intercity') {
    const i = leg.index;
    const cur = leg.current;
    const fresh = payload.options
      .filter((o) => !choiceMatchesTransport(o, cur))
      .map((o) => choiceToTransport(o, trip.cities[i].name, trip.cities[i + 1].name, payload.leg.date));
    const old = (cur.alternatives ?? []).filter((a) => !fresh.some((f) => sameTransport(f, a)));
    const cities = [...trip.cities];
    cities[i] = { ...cities[i], transportOut: { ...cur, alternatives: [...fresh, ...old].slice(0, MAX_ALTERNATIVES) } };
    return { ...trip, cities };
  }

  const cur = leg.current;
  const fresh = payload.options
    .filter((o) => !choiceMatchesHomeLeg(o, cur))
    .map((o) => choiceToHomeLeg(o, payload.leg.date));
  const old = (cur.alternatives ?? []).filter((a) => !fresh.some((f) => sameHome(f, a)));
  return {
    ...trip,
    origin: { ...trip.origin!, [leg.slot]: { ...cur, alternatives: [...fresh, ...old].slice(0, MAX_ALTERNATIVES) } },
  };
}

function sameTransport(a: Transport, b: Transport): boolean {
  return a.mode === b.mode && norm(a.operator) === norm(b.operator) && (a.departTime ?? null) === (b.departTime ?? null) && samePrice(a.price, b.price);
}

function sameHome(a: Omit<HomeLeg, 'alternatives'>, b: Omit<HomeLeg, 'alternatives'>): boolean {
  return (
    norm(a.operator) === norm(b.operator) &&
    a.departTime === b.departTime &&
    eqOpt(a.originAirport, b.originAirport) &&
    eqOpt(a.destAirport, b.destAirport) &&
    samePrice(a.price, b.price)
  );
}
