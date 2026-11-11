/**
 * The legs of a trip as the AI chat sees, names, searches and changes them —
 * the flights to and from home included.
 *
 * Why this exists: the chat used to know only the trip's cities and each
 * city's `transportOut` (with no destination). Home lives on `trip.origin`
 * (`outboundLeg`, `returnLeg`), so the model never saw the flights to and from
 * home, the last city's empty placeholder read as "no return booked", and the
 * leg tools accepted only two consecutive trip cities. On production
 * (New York → Paris → London) "change my flight home to a later one" got
 * "London → Paris isn't a leg of this trip", and "show me evening flights
 * back to New York" got "there's no return transport booked yet".
 *
 * Here every leg gets a stable id (`home→Paris`, `Paris→London`,
 * `London→home`), its current option and the options its card shows, each
 * with an option id. A change is a proposal built and checked here from
 * searched data: the option satisfies what was asked, and the trip total
 * moves by exactly the difference the reply states.
 *
 * Units: every price is a PARTY total in USD (Duffel's `total_amount` for all
 * passengers; hotels priced for every room) — the unit the results header
 * sums (frontend lib/tripTotals.ts `liveTripTotal`).
 */
import { formatDurationMinutes, parseDurationMinutes } from '../utils/duration';
import { getCityCountry } from '../data/cityCountries';
import { logger } from '../utils/logger';
import { normalizeTimeOfDay, normalizeTimeWindow, searchLegOptions, type NormalizedTimeWindow } from './legOptions';
import { firstStayArrival, searchHomeLegOptions } from './optimizer';

export type LegKind = 'outbound' | 'intercity' | 'return';

/** One way to travel a leg: a card option, the current one, or a searched one. */
export type LegChoice = {
  /** `<leg id>#<n>` for the card's options (#0 = current), `<leg id>~<n>` for a fresh search. */
  optionId: string;
  mode: 'flight' | 'train';
  operator: string;
  /** Flight number or carrier code (home legs carry the carrier code), train number. */
  flightNumber: string | null;
  /** HH:MM local. */
  departTime: string | null;
  arriveTime: string | null;
  /** YYYY-MM-DD. */
  departDate: string | null;
  /** YYYY-MM-DD landing day when known (home legs); null = same day / unknown. */
  arriveDate: string | null;
  fromAirport: string | null;
  toAirport: string | null;
  durationMinutes: number;
  duration: string;
  stops: number;
  /** Party total, USD. 0 = unknown (a train with no fare). */
  price: number;
  currency: string;
  bookingUrl: string | null;
};

export type TripLeg = {
  /** "home→Paris", "Paris→London", "London→home". Unique within the trip. */
  id: string;
  kind: LegKind;
  /** intercity: i for cities[i] → cities[i + 1]; outbound: -1; return: the last city's index. */
  index: number;
  /** Place names: the home city for a home end. */
  from: string;
  to: string;
  /** Travel day, YYYY-MM-DD. */
  date: string | null;
  /** What the trip has on this leg now; null = nothing found / not searched yet. */
  current: LegChoice | null;
  /** The card's options: the current one first (#0), then its alternatives (#1…). */
  options: LegChoice[];
};

export type Home = {
  city: string;
  airports: string[];
  returnCity: string;
  returnAirports: string[];
  returnsHome: boolean;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const norm = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
const round2 = (n: number) => Math.round(n * 100) / 100;

function arrivalOf(c: any): string | null {
  return c?.dates?.arrival ?? c?.arrival_date ?? null;
}
function departureOf(c: any): string | null {
  return c?.dates?.departure ?? c?.departure_date ?? null;
}

/** The trip's home anchor, or null for a trip without one. */
export function homeOf(trip: any): Home | null {
  const o = trip?.origin;
  if (!o || !str(o.city).trim()) return null;
  const codes = (v: unknown) =>
    Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim().toUpperCase()) : [];
  const airports = codes(o.airports);
  const ret = codes(o.returnAirports);
  return {
    city: o.city.trim(),
    airports,
    returnCity: str(o.returnCity).trim() || o.city.trim(),
    returnAirports: ret.length > 0 ? ret : airports,
    returnsHome: trip?.returnToHome !== false,
  };
}

/** A Transport that is the "nothing here" placeholder rather than a real option. */
function isPlaceholder(t: any): boolean {
  return !t || t.unavailable === true || (!(Number(t.price) > 0) && !str(t.operator).trim());
}

function fromTransport(t: any, optionId: string, date: string | null): LegChoice {
  const mode = t.mode === 'train' ? 'train' : 'flight';
  const minutes = parseDurationMinutes(t.duration);
  return {
    optionId,
    mode,
    operator: str(t.operator),
    flightNumber: (mode === 'train' ? t.trainNumber : t.flightNumber) ?? null,
    departTime: t.departTime ?? null,
    arriveTime: t.arriveTime ?? null,
    departDate: t.departDate ?? date,
    arriveDate: null,
    fromAirport: null,
    toAirport: null,
    durationMinutes: minutes,
    duration: str(t.duration) || formatDurationMinutes(minutes),
    stops: Number(t.layovers ?? 0) || 0,
    price: Number(t.price) || 0,
    currency: 'USD',
    bookingUrl: t.bookingUrl ?? null,
  };
}

function fromHomeLeg(h: any, optionId: string, date: string | null): LegChoice {
  const minutes = Number(h.durationMinutes ?? 0) || 0;
  return {
    optionId,
    mode: 'flight',
    operator: str(h.operator),
    flightNumber: str(h.carrierCode) || null,
    departTime: h.departTime ?? null,
    arriveTime: h.arriveTime ?? null,
    departDate: h.departDate ?? date,
    arriveDate: h.arriveDate ?? null,
    fromAirport: h.originAirport ?? null,
    toAirport: h.destAirport ?? null,
    durationMinutes: minutes,
    duration: formatDurationMinutes(minutes),
    stops: Number(h.stops ?? 0) || 0,
    price: Number(h.price) || 0,
    currency: h.currency ?? 'USD',
    bookingUrl: h.bookingUrl ?? null,
  };
}

/** A card's options: the current one as #0, its alternatives as #1, #2, … */
function cardOptions(
  id: string,
  current: any,
  alternatives: any[],
  convert: (x: any, optionId: string) => LegChoice,
): { current: LegChoice | null; options: LegChoice[] } {
  const cur = current ? convert(current, `${id}#0`) : null;
  const alts = alternatives.filter((a) => a && !isPlaceholder(a)).map((a, i) => convert(a, `${id}#${i + 1}`));
  return { current: cur, options: cur ? [cur, ...alts] : alts };
}

/**
 * Every leg of the trip in travel order: home → first city, each pair of
 * consecutive cities, last city → home (when the trip returns home).
 */
export function tripLegs(trip: any): TripLeg[] {
  const cities: any[] = Array.isArray(trip?.cities) ? trip.cities : [];
  if (cities.length === 0) return [];
  const home = homeOf(trip);
  const legs: TripLeg[] = [];
  const seen = new Map<string, number>();
  const uniqueId = (base: string) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  };

  if (home) {
    const first = cities[0];
    const leg = trip.origin?.outboundLeg ?? null;
    const id = uniqueId(`home→${first.name}`);
    const date = leg?.departDate ?? arrivalOf(first);
    const { current, options } = leg
      ? cardOptions(id, leg, leg.alternatives ?? [], (x, oid) => fromHomeLeg(x, oid, date))
      : { current: null, options: [] };
    legs.push({ id, kind: 'outbound', index: -1, from: home.city, to: first.name, date, current, options });
  }

  for (let i = 0; i + 1 < cities.length; i++) {
    const from = cities[i];
    const to = cities[i + 1];
    const id = uniqueId(`${from.name}→${to.name}`);
    const date = departureOf(from);
    const t = from.transportOut;
    const { current, options } = cardOptions(
      id,
      isPlaceholder(t) ? null : t,
      t?.alternatives ?? [],
      (x, oid) => fromTransport(x, oid, date),
    );
    legs.push({ id, kind: 'intercity', index: i, from: from.name, to: to.name, date, current, options });
  }

  if (home && home.returnsHome) {
    const last = cities[cities.length - 1];
    const leg = trip.origin?.returnLeg ?? null;
    const id = uniqueId(`${last.name}→home`);
    const date = leg?.departDate ?? departureOf(last);
    const { current, options } = leg
      ? cardOptions(id, leg, leg.alternatives ?? [], (x, oid) => fromHomeLeg(x, oid, date))
      : { current: null, options: [] };
    legs.push({ id, kind: 'return', index: cities.length - 1, from: last.name, to: home.returnCity, date, current, options });
  }
  return legs;
}

/** "New York → Paris" — how a leg reads to the user. */
export function legLabel(leg: TripLeg): string {
  return `${leg.from} → ${leg.to}`;
}

/** "your flight home (London → New York)", "your flight out (New York → Paris)", "Paris → London". */
export function legPhrase(leg: TripLeg): string {
  const what = leg.current?.mode === 'train' ? 'train' : 'flight';
  if (leg.kind === 'return') return `your ${what} home (${legLabel(leg)})`;
  if (leg.kind === 'outbound') return `your ${what} out (${legLabel(leg)})`;
  return legLabel(leg);
}

// ─── Naming a leg ─────────────────────────────────────────────────

export type LegLookup =
  | { kind: 'leg'; leg: TripLeg }
  | { kind: 'missing' }
  | { kind: 'unknown_city'; from: string; to: string }
  | { kind: 'not_a_leg'; fromName: string; toName: string };

/** Lower-case, one space, no ", Country" suffix, no "(home)" tag. */
function placeKey(v: unknown): string {
  return norm(v).replace(/\s*\(home\)\s*$/, '').replace(/,.*$/, '').trim();
}

/** Every way the model may name each end of a leg. */
function endAliases(leg: TripLeg, end: 'from' | 'to', home: Home | null): Set<string> {
  const isHome = (end === 'from' && leg.kind === 'outbound') || (end === 'to' && leg.kind === 'return');
  const name = end === 'from' ? leg.from : leg.to;
  const out = new Set<string>([placeKey(name)]);
  if (isHome && home) {
    for (const a of ['home', 'back home', 'my home', 'home city']) out.add(a);
    for (const code of leg.kind === 'outbound' ? home.airports : home.returnAirports) out.add(code.toLowerCase());
    if (leg.kind === 'outbound' && leg.current?.fromAirport) out.add(leg.current.fromAirport.toLowerCase());
    if (leg.kind === 'return' && leg.current?.toAirport) out.add(leg.current.toAirport.toLowerCase());
  }
  return out;
}

const ARROW = /\s*(?:→|->|=>|–>|—>|⟶|\s+to\s+)\s*/i;

/**
 * Resolve the leg the model named — by id ("London→home"), by "from → to" in
 * any arrow spelling, or by separate from/to — to a leg of THIS trip. Home
 * ends answer to "home", the home city's name and its airport codes. Two
 * trip cities that aren't consecutive are not a leg (B9): a refresh is
 * applied to a city pair, so a non-leg would overwrite a real one.
 */
export function resolveLeg(trip: any, legs: TripLeg[], ref: { leg?: unknown; from?: unknown; to?: unknown }): LegLookup {
  const home = homeOf(trip);
  let from = str(ref.from);
  let to = str(ref.to);
  const raw = str(ref.leg).replace(/[#~]\d+$/, '').trim();
  if (raw) {
    const key = norm(raw).replace(ARROW, '→');
    const byId = legs.find((l) => norm(l.id) === key);
    if (byId) return { kind: 'leg', leg: byId };
    const parts = raw.split(ARROW);
    if (parts.length === 2) {
      from = parts[0];
      to = parts[1];
    }
  }
  if (!from.trim() || !to.trim()) return { kind: 'missing' };

  const f = placeKey(from);
  const t = placeKey(to);
  for (const leg of legs) {
    if (endAliases(leg, 'from', home).has(f) && endAliases(leg, 'to', home).has(t)) {
      return { kind: 'leg', leg };
    }
  }
  const nameOf = (k: string): string | null => {
    for (const leg of legs) {
      if (endAliases(leg, 'from', home).has(k)) return leg.from;
      if (endAliases(leg, 'to', home).has(k)) return leg.to;
    }
    return null;
  };
  const fromName = nameOf(f);
  const toName = nameOf(t);
  if (!fromName || !toName) return { kind: 'unknown_city', from: from.trim(), to: to.trim() };
  return { kind: 'not_a_leg', fromName, toName };
}

/** "New York → Paris, Paris → London and London → New York". */
export function listLegs(legs: TripLeg[], joiner = 'and'): string {
  const labels = legs.map(legLabel);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} ${joiner} ${labels[labels.length - 1]}`;
}

/**
 * The reply for a non-leg: names the trip's real legs — home ones included —
 * so the user (and the model, reading it back next turn) can pick one.
 */
export function notALegReply(legs: TripLeg[], lookup: { fromName: string; toName: string }): string {
  const asked = `${lookup.fromName} → ${lookup.toName}`;
  if (legs.length === 0) return `${asked} isn't a leg of this trip — it has no travel between cities.`;
  if (legs.length === 1) {
    return `${asked} isn't a leg of this trip — its only leg is ${legLabel(legs[0])}. Did you mean that one?`;
  }
  return `${asked} isn't a leg of this trip — its legs are ${listLegs(legs)}. Which one did you mean?`;
}

/** "Which one — New York → Paris (Jan 12), Paris → London (Jan 15) or London → New York (Jan 17)?" */
export function whichLegReply(legs: TripLeg[]): string {
  if (legs.length === 0) return "This trip has no flights or trains to change yet.";
  const labels = legs.map((l) => `${legLabel(l)}${l.date ? ` (${shortDate(l.date)})` : ''}`);
  if (labels.length === 1) return `Did you mean ${labels[0]}? It's the only leg of this trip.`;
  return `Which one — ${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}?`;
}

// ─── What the model is told ───────────────────────────────────────

function choiceForModel(c: LegChoice, current: LegChoice | null) {
  return {
    optionId: c.optionId,
    mode: c.mode,
    operator: c.operator || null,
    flightNumber: c.flightNumber,
    depart: [c.fromAirport, c.departTime, c.departDate].filter(Boolean).join(' ') || null,
    arrive:
      [c.toAirport, c.arriveTime, c.arriveDate && c.arriveDate !== c.departDate ? c.arriveDate : null]
        .filter(Boolean)
        .join(' ') || null,
    duration: c.duration || null,
    stops: c.stops,
    price: c.price,
    ...(current && c !== current ? { priceChange: round2(c.price - current.price) } : {}),
  };
}

/**
 * The trip as the chat model sees it: home, every city's stay, and every leg
 * with its id, current option and the options on its card. Raw payloads
 * (hotel lists, schedules) are left out.
 */
export function tripContextForChat(trip: any): any {
  const cities: any[] = Array.isArray(trip?.cities) ? trip.cities : [];
  const home = homeOf(trip);
  const legs = tripLegs(trip);
  return {
    title: trip?.title,
    travelers: trip?.travelers,
    prices: `USD, each price is the total for all ${trip?.travelers ?? 1} traveller(s)`,
    totalCost: trip?.totalCost ?? trip?.total_cost,
    vibe: trip?.vibe ?? null,
    budget: trip?.budget ?? null,
    home: home
      ? {
          city: home.city,
          airports: home.airports,
          ...(home.returnCity !== home.city ? { returnCity: home.returnCity, returnAirports: home.returnAirports } : {}),
          returnsHome: home.returnsHome,
        }
      : null,
    cities: cities.map((c, idx) => ({
      position: idx,
      name: c.name,
      country: c.country ?? null,
      arrival: arrivalOf(c),
      departure: departureOf(c),
      hotel: c.customHotel?.name ?? c.hotel?.name ?? null,
      hotelNightly: c.customHotel ? null : c.hotel?.pricePerNight ?? null,
    })),
    legs: legs.map((l) => ({
      id: l.id,
      from: l.kind === 'outbound' ? `${l.from} (home)` : l.from,
      to: l.kind === 'return' ? `${l.to} (home)` : l.to,
      date: l.date,
      current: l.current ? choiceForModel(l.current, null) : 'none found yet',
      cardOptions: l.options.filter((o) => o !== l.current).map((o) => choiceForModel(o, l.current)),
    })),
    existingConstraints: trip?.constraints ?? {},
  };
}

// ─── Searching a leg ──────────────────────────────────────────────

/** Same service (mode, operator, day, time, airports) — price aside. */
export function sameService(a: LegChoice, b: LegChoice): boolean {
  const eq = (x: string | null, y: string | null) => !x || !y || x.toUpperCase() === y.toUpperCase();
  return (
    a.mode === b.mode &&
    norm(a.operator) === norm(b.operator) &&
    (a.departTime ?? null) === (b.departTime ?? null) &&
    eq(a.departDate, b.departDate) &&
    eq(a.fromAirport, b.fromAirport) &&
    eq(a.toAirport, b.toAirport)
  );
}

export type LegSearch = { ok: true; choices: LegChoice[] } | { ok: false; reply: string };

/**
 * Search a leg fresh, cheapest first. Home legs search the traveller's home
 * airports exactly as the optimizer prices home flights (searchHomeLegOptions:
 * every home airport, then the metro code); inter-city legs search flights
 * and trains (searchLegOptions).
 */
export async function searchLeg(trip: any, leg: TripLeg): Promise<LegSearch> {
  const cities: any[] = trip?.cities ?? [];
  const travelers = Number.isInteger(trip?.travelers) && trip.travelers > 0 ? trip.travelers : 1;
  const tripCityNames = cities.map((c) => c.name);
  if (!leg.date) return { ok: false, reply: `I need a travel date for ${legLabel(leg)} before I can search it.` };

  let raw: LegChoice[] = [];
  if (leg.kind === 'intercity') {
    const from = cities[leg.index];
    const to = cities[leg.index + 1];
    const r = await searchLegOptions({
      from: from.name,
      to: to.name,
      date: leg.date,
      travelers,
      fromCountry: from.country ?? getCityCountry(from.name),
      toCountry: to.country ?? getCityCountry(to.name),
      limit: 40,
      tripCityNames,
    });
    raw = r.options.map((o, i) => ({
      optionId: `${leg.id}~${i + 1}`,
      mode: o.mode,
      operator: o.operator ?? '',
      flightNumber: o.flightNumber ?? null,
      departTime: o.departTime,
      arriveTime: o.arriveTime,
      departDate: leg.date,
      arriveDate: null,
      fromAirport: null,
      toAirport: null,
      durationMinutes: o.durationMinutes,
      duration: o.duration,
      stops: o.stops ?? 0,
      price: o.price,
      currency: o.currency ?? 'USD',
      bookingUrl: o.bookingUrl ?? null,
    }));
  } else {
    const home = homeOf(trip)!;
    const outbound = leg.kind === 'outbound';
    const airports = outbound ? home.airports : home.returnAirports;
    if (airports.length === 0) {
      return { ok: false, reply: `I don't know which airports to search at home (${outbound ? home.city : home.returnCity}), so I can't search ${legLabel(leg)}.` };
    }
    const rows = await searchHomeLegOptions(
      {
        originAirports: airports,
        destinationCity: outbound ? cities[0].name : cities[cities.length - 1].name,
        date: leg.date,
        travelers,
        reverse: !outbound,
        originCity: outbound ? home.city : home.returnCity,
        tripCityNames,
      },
      40,
    );
    raw = rows.map((h, i) => fromHomeLeg(h, `${leg.id}~${i + 1}`, leg.date));
  }

  // One row per service, the cheapest fare for it; unknown prices last.
  const deduped: LegChoice[] = [];
  for (const c of raw) {
    const dup = deduped.findIndex((d) => sameService(d, c) && d.price === c.price);
    if (dup < 0) deduped.push(c);
  }
  deduped.sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
  return { ok: true, choices: deduped };
}

// ─── What the user asked for ──────────────────────────────────────

/** Part-of-day words, as departure windows. */
export const TIME_OF_DAY: Record<string, { earliestDepart: string; latestDepart: string }> = {
  morning: { earliestDepart: '05:00', latestDepart: '11:59' },
  afternoon: { earliestDepart: '12:00', latestDepart: '16:59' },
  evening: { earliestDepart: '17:00', latestDepart: '23:59' },
};

/** A transport request, checked and normalised. */
export type ChoiceRequest = {
  /** select_transport_option: exactly this option. */
  optionId?: string;
  window?: NormalizedTimeWindow;
  timeOfDay?: 'morning' | 'afternoon' | 'evening';
  relative?: 'later' | 'earlier';
  cheaper?: boolean;
  mode?: 'flight' | 'train';
  operator?: string;
};

const BOUND_LABEL = {
  earliestDepart: 'earliest departure',
  latestDepart: 'latest departure',
  earliestArrive: 'earliest arrival',
  latestArrive: 'latest arrival',
} as const;

/**
 * Read a find_transport_option / set_transport_window input into a request.
 * A bound or word we can't read is refused with a reply, never dropped.
 */
export function readRequest(input: any): { ok: true; request: ChoiceRequest } | { ok: false; reply: string } {
  const request: ChoiceRequest = {};
  const tod = norm(input?.timeOfDay);
  if (tod && tod !== 'null' && tod !== 'any') {
    if (!TIME_OF_DAY[tod]) {
      return { ok: false, reply: `I couldn't read "${input.timeOfDay}" as a time of day — say morning, afternoon or evening, or give me a time like 17:00.` };
    }
    request.timeOfDay = tod as ChoiceRequest['timeOfDay'];
  }
  const bounds = {
    earliestDepart: input?.departAfter ?? input?.earliestDepart ?? null,
    latestDepart: input?.departBefore ?? input?.latestDepart ?? null,
    earliestArrive: input?.arriveAfter ?? input?.earliestArrive ?? null,
    latestArrive: input?.arriveBefore ?? input?.latestArrive ?? null,
  };
  const normalized = normalizeTimeWindow(bounds);
  if (!normalized.ok) {
    return {
      ok: false,
      reply: `I couldn't use ${JSON.stringify(normalized.raw)} as the ${BOUND_LABEL[normalized.bound]} — give me a clock time like 17:00 or 5pm.`,
    };
  }
  const w = { ...normalized.window };
  if (request.timeOfDay) {
    const t = TIME_OF_DAY[request.timeOfDay];
    w.earliestDepart = !w.earliestDepart || w.earliestDepart < t.earliestDepart ? t.earliestDepart : w.earliestDepart;
    w.latestDepart = !w.latestDepart || w.latestDepart > t.latestDepart ? t.latestDepart : w.latestDepart;
  }
  if (w.earliestDepart || w.latestDepart || w.earliestArrive || w.latestArrive) request.window = w;

  const rel = norm(input?.relative ?? input?.when);
  if (rel === 'later' || rel === 'earlier') request.relative = rel;
  if (input?.cheaper === true) request.cheaper = true;
  const mode = norm(input?.mode);
  if (mode === 'flight' || mode === 'train') request.mode = mode;
  const op = str(input?.operator).trim();
  if (op && norm(op) !== 'null' && norm(op) !== 'any') request.operator = op;
  return { ok: true, request };
}

const minutesOf = (hhmm: string | null | undefined): number | null => {
  const t = normalizeTimeOfDay(hhmm ?? null);
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** "2027-01-17 19:25" sort key; null without a time. */
function departKey(c: LegChoice, legDate: string | null): string | null {
  if (!c.departTime) return null;
  return `${c.departDate ?? legDate ?? ''} ${c.departTime}`;
}

function operatorMatches(c: LegChoice, wanted: string): boolean {
  const w = norm(wanted);
  const op = norm(c.operator);
  if (!w) return true;
  if (op && (op.includes(w) || w.includes(op))) return true;
  return !!c.flightNumber && c.flightNumber.trim().toUpperCase() === wanted.trim().toUpperCase();
}

/**
 * The parts of `request` that `c` breaks, as phrases ("departing after
 * 17:00"); empty = it satisfies all of them. One predicate for filtering the
 * search and for checking the proposal afterwards.
 */
export function unmetCriteria(c: LegChoice, request: ChoiceRequest, current: LegChoice | null, legDate: string | null): string[] {
  const unmet: string[] = [];
  const w = request.window;
  if (w) {
    const dep = minutesOf(c.departTime);
    const arr = minutesOf(c.arriveTime);
    const nextDay = !!c.arriveDate && !!c.departDate && c.arriveDate > c.departDate;
    const lt = (a: number | null, b: string | null) => a != null && b != null && a < (minutesOf(b) as number);
    const gt = (a: number | null, b: string | null) => a != null && b != null && a > (minutesOf(b) as number);
    if (w.earliestDepart && (dep == null || lt(dep, w.earliestDepart))) unmet.push(`departing after ${w.earliestDepart}`);
    if (w.latestDepart && (dep == null || gt(dep, w.latestDepart))) unmet.push(`departing before ${w.latestDepart}`);
    if (w.earliestArrive && !nextDay && (arr == null || lt(arr, w.earliestArrive))) unmet.push(`arriving after ${w.earliestArrive}`);
    if (w.latestArrive && (nextDay || arr == null || gt(arr, w.latestArrive))) unmet.push(`arriving before ${w.latestArrive}`);
  }
  if (request.relative && current) {
    const mine = departKey(c, legDate);
    const now = departKey(current, legDate);
    const ok = mine != null && now != null && (request.relative === 'later' ? mine > now : mine < now);
    if (!ok) unmet.push(`${request.relative} than your current ${current.departTime ?? 'one'}`);
  }
  if (request.cheaper && current && !(c.price > 0 && c.price < current.price - 0.005)) {
    unmet.push(`cheaper than your current ${money(current.price)}`);
  }
  if (request.mode && c.mode !== request.mode) unmet.push(`by ${request.mode}`);
  if (request.operator && !operatorMatches(c, request.operator)) unmet.push(`with ${request.operator}`);
  return unmet;
}

/** Why a request can't be checked against this leg at all, or null. */
export function requestProblem(request: ChoiceRequest, leg: TripLeg): string | null {
  if ((request.relative || request.cheaper) && !leg.current) {
    return `${legLabel(leg)} has no ${request.cheaper ? 'price' : 'time'} to compare with yet, so I can't look for a ${request.cheaper ? 'cheaper' : request.relative} one`;
  }
  if (request.relative && leg.current && !leg.current.departTime) {
    return `I don't know when your current ${legLabel(leg)} option leaves, so I can't look for a ${request.relative} one`;
  }
  if (request.mode === 'train' && leg.kind !== 'intercity') {
    return `I can only search flights to and from home, so there's no train for ${legLabel(leg)}`;
  }
  return null;
}

/** "a later evening flight with British Airways" — what was asked, in words. */
export function describeRequest(request: ChoiceRequest, leg: TripLeg): string {
  const words: string[] = [];
  if (request.cheaper) words.push('cheaper');
  if (request.relative) words.push(request.relative);
  if (request.timeOfDay) words.push(request.timeOfDay);
  const thing = request.mode ?? (leg.current?.mode === 'train' ? 'train' : 'flight');
  let s = `${words.length ? words.join(' ') + ' ' : ''}${thing}`;
  if (request.operator) s += ` with ${request.operator}`;
  const w = request.window;
  if (w && !request.timeOfDay) {
    const bits: string[] = [];
    if (w.earliestDepart && w.latestDepart) bits.push(`departing ${w.earliestDepart}–${w.latestDepart}`);
    else if (w.earliestDepart) bits.push(`departing after ${w.earliestDepart}`);
    else if (w.latestDepart) bits.push(`departing before ${w.latestDepart}`);
    if (w.earliestArrive) bits.push(`arriving after ${w.earliestArrive}`);
    if (w.latestArrive) bits.push(`arriving before ${w.latestArrive}`);
    if (bits.length) s += ` ${bits.join(', ')}`;
  }
  return s;
}

/** Candidates that satisfy the request, cheapest first; the current option never counts. */
export function matchingChoices(choices: LegChoice[], request: ChoiceRequest, leg: TripLeg): LegChoice[] {
  return choices
    .filter((c) => !(leg.current && sameService(c, leg.current)))
    .filter((c) => unmetCriteria(c, request, leg.current, leg.date).length === 0)
    .sort((a, b) => (a.price || Infinity) - (b.price || Infinity) || (departKey(a, leg.date) ?? '').localeCompare(departKey(b, leg.date) ?? ''));
}

// ─── The trip total, as the header computes it ────────────────────

function nightsBetween(arrival: string | null, departure: string | null): number {
  if (!arrival || !departure) return 0;
  const a = Date.parse(`${arrival}T00:00:00Z`);
  const d = Date.parse(`${departure}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(d)) return 0;
  return Math.max(0, Math.round((d - a) / 86_400_000));
}

/** One stay's cost — frontend lib/tripTotals.ts `effectiveHotel(...).total`. */
function stayCost(c: any): number {
  const nights = nightsBetween(arrivalOf(c), departureOf(c));
  const custom = c?.customHotel;
  if (custom) return custom.mode === 'total' ? Number(custom.amount) || 0 : (Number(custom.amount) || 0) * nights;
  const h = (Array.isArray(c?.hotels) ? c.hotels[c.selectedHotelIndex ?? 0] : undefined) ?? c?.hotel;
  if (!h) return 0;
  return ((Number(h.pricePerNight) || 0) + (Number(h.taxesPerNight) || 0)) * nights;
}

/**
 * The header's total — frontend lib/tripTotals.ts `liveTripTotal`: every
 * stay, every city's transportOut, and the two home flights, rounded once.
 */
export function headerTotal(trip: any): number {
  const cities: any[] = trip?.cities ?? [];
  let sum = cities.reduce((s, c) => s + stayCost(c), 0);
  sum += cities.reduce((s, c) => s + (Number(c?.transportOut?.price) || 0), 0);
  if (trip?.origin?.outboundLeg) sum += Number(trip.origin.outboundLeg.price ?? 0) || 0;
  if (trip?.origin?.returnLeg) sum += Number(trip.origin.returnLeg.price ?? 0) || 0;
  return Math.round(sum);
}

// ─── The proposal ─────────────────────────────────────────────────

export type TransportChangeProposal = {
  kind: 'transport_change';
  toolName: string;
  leg: { id: string; kind: LegKind; index: number; from: string; to: string; date: string | null };
  before: LegChoice | null;
  after: LegChoice;
  /** What was asked — the proposal was checked against it. */
  request: ChoiceRequest;
  /** after.price − before.price, USD party total. */
  priceDelta: number;
  /**
   * Outbound only, when the new flight lands on another day: the first stay
   * starts that day (the optimizer's rule) and its nights change.
   */
  firstStay: {
    city: string;
    arrivalBefore: string;
    arrivalAfter: string;
    nightsBefore: number;
    nightsAfter: number;
    /** Stay cost after − before, USD. */
    hotelDelta: number;
  } | null;
  /** The header total before → after (whole USD); null when it couldn't be checked against the trip's total. */
  totals: { before: number; after: number; delta: number } | null;
};

/** The trip with `after` on `leg` — only what the total reads. */
function tripWithChoice(trip: any, leg: TripLeg, after: LegChoice, firstArrival: string | null): any {
  const cities = [...(trip?.cities ?? [])];
  const origin = trip?.origin ? { ...trip.origin } : trip?.origin;
  if (leg.kind === 'outbound') {
    origin.outboundLeg = { ...(origin.outboundLeg ?? {}), price: after.price };
    if (firstArrival && cities[0]) cities[0] = { ...cities[0], dates: { ...cities[0].dates, arrival: firstArrival } };
  } else if (leg.kind === 'return') {
    origin.returnLeg = { ...(origin.returnLeg ?? {}), price: after.price };
  } else {
    const c = cities[leg.index];
    cities[leg.index] = { ...c, transportOut: { ...(c.transportOut ?? {}), price: after.price } };
  }
  return { ...trip, cities, origin };
}

/**
 * Build the proposal for switching `leg` to `after`, with the price change in
 * the header's units. Outbound: a flight landing another day moves the first
 * stay's start (frontend store setHomeLegAlternative applies the same rule).
 */
export function buildTransportProposal(
  trip: any,
  leg: TripLeg,
  after: LegChoice,
  request: ChoiceRequest,
  toolName: string,
): TransportChangeProposal {
  const before = leg.current;
  let firstStay: TransportChangeProposal['firstStay'] = null;
  let firstArrival: string | null = null;
  if (leg.kind === 'outbound') {
    const first = trip.cities[0];
    const arrivalBefore = arrivalOf(first);
    const departure = departureOf(first);
    const startDate = after.departDate || leg.date;
    if (arrivalBefore && departure && startDate) {
      const arrivalAfter = firstStayArrival({ startDate, firstDeparture: departure, landed: after.arriveDate ?? after.departDate });
      if (arrivalAfter !== arrivalBefore) {
        firstArrival = arrivalAfter;
        const moved = { ...first, dates: { ...(first.dates ?? {}), arrival: arrivalAfter, departure } };
        firstStay = {
          city: first.name,
          arrivalBefore,
          arrivalAfter,
          nightsBefore: nightsBetween(arrivalBefore, departure),
          nightsAfter: nightsBetween(arrivalAfter, departure),
          hotelDelta: round2(stayCost(moved) - stayCost(first)),
        };
      }
    }
  }
  const totalBefore = headerTotal(trip);
  const totalAfter = headerTotal(tripWithChoice(trip, leg, after, firstArrival));
  // The trip arrives with the header's own total (frontend withLiveTotal). If
  // ours disagrees, our sum isn't the header's, and no total is claimed.
  const sent = Number(trip?.totalCost);
  const totalsHold = !Number.isFinite(sent) || trip?.totalCost == null || sent === totalBefore;
  if (!totalsHold) {
    logger.warn('tripChat: header total mismatch, totals not claimed', { sent, computed: totalBefore });
  }
  return {
    kind: 'transport_change',
    toolName,
    leg: { id: leg.id, kind: leg.kind, index: leg.index, from: leg.from, to: leg.to, date: leg.date },
    before,
    after,
    request,
    priceDelta: round2(after.price - (before?.price ?? 0)),
    firstStay,
    totals: totalsHold ? { before: totalBefore, after: totalAfter, delta: totalAfter - totalBefore } : null,
  };
}

/**
 * Check a proposal before it is offered: the option is the one asked for (or
 * satisfies every part of the request), it is a change, and the totals add
 * up — the header moves by the fare change (plus the stay change for an
 * outbound that moves the first night), to rounding. Returns the problems;
 * empty = verified.
 */
export function verifyTransportProposal(p: TransportChangeProposal, leg: TripLeg): string[] {
  const problems: string[] = [];
  const { before, after, request } = p;
  if (before && sameService(before, after) && Math.abs(before.price - after.price) < 0.01) {
    problems.push('the proposed option is the current one');
  }
  if (request.optionId) {
    const listed = leg.options.find((o) => o.optionId === request.optionId);
    if (!listed || listed.optionId !== after.optionId || !sameService(listed, after) || listed.price !== after.price) {
      problems.push(`the proposed option is not ${request.optionId}`);
    }
  }
  problems.push(...unmetCriteria(after, request, before, leg.date).map((u) => `not ${u}`));
  if (Math.abs(p.priceDelta - round2(after.price - (before?.price ?? 0))) > 0.001) problems.push('price change does not match the fares');
  if (p.totals) {
    if (p.totals.delta !== p.totals.after - p.totals.before) problems.push('total change does not match the totals');
    const expected = p.priceDelta + (p.firstStay?.hotelDelta ?? 0);
    if (Math.abs(p.totals.delta - expected) > 1) problems.push('total change does not match the fare and stay changes');
  }
  return problems;
}

// ─── Words ────────────────────────────────────────────────────────

export function money(n: number): string {
  return `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
}

export function signedMoney(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '±$0';
  return `${r > 0 ? '+' : '−'}${money(r)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return iso ?? '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** "British Airways LHR 19:25 → EWR 22:40" (+ "next day" / a mode word when useful). */
export function describeChoice(c: LegChoice): string {
  const who = c.operator || (c.mode === 'train' ? 'Train' : 'Flight');
  const dep = [c.fromAirport, c.departTime].filter(Boolean).join(' ');
  const arr = [c.toAirport, c.arriveTime].filter(Boolean).join(' ');
  const times = dep || arr ? ` ${dep || '?'} → ${arr || '?'}` : '';
  const nextDay = c.arriveDate && c.departDate && c.arriveDate > c.departDate ? ` (lands ${shortDate(c.arriveDate)})` : '';
  const train = c.mode === 'train' && c.operator ? ' train' : '';
  return `${who}${train}${times}${nextDay}`;
}

/** The proposal's chat reply, written from the verified proposal only. */
export function describeTransportProposal(p: TransportChangeProposal, leg: TripLeg, lead: string): string {
  const parts: string[] = [];
  const now = p.before ? ` instead of ${describeChoice(p.before)} at ${money(p.before.price)}` : '';
  parts.push(`${lead} ${describeChoice(p.after)} on ${shortDate(p.after.departDate ?? leg.date)}, ${money(p.after.price)}${now}.`);
  if (p.firstStay) {
    const fs = p.firstStay;
    parts.push(
      `It lands ${shortDate(fs.arrivalAfter)}, so ${fs.city} starts ${shortDate(fs.arrivalAfter)}: ${fs.nightsAfter} night${fs.nightsAfter === 1 ? '' : 's'} instead of ${fs.nightsBefore} (hotel ${signedMoney(fs.hotelDelta)}).`,
    );
  }
  if (p.totals) {
    parts.push(`Trip total ${money(p.totals.before)} → ${money(p.totals.after)} (${signedMoney(p.totals.delta)}).`);
  } else {
    parts.push(`The fare changes by ${signedMoney(p.priceDelta)}.`);
  }
  parts.push('Accept to switch, or Reject to keep it as it is.');
  return parts.join(' ');
}
