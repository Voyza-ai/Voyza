/**
 * Dinner plans on a trip — the BlueMurr AI chat's add_dinner / change_dinner /
 * remove_dinner tools.
 *
 * There is no restaurant-booking API here, so nothing is booked: a dinner is a
 * PLAN — a restaurant, a night of the stay, a time, the party — shown as "Not
 * booked yet" with a Reserve link the traveller follows to book it themselves.
 *
 * Storage: a dinner is one event on the city's day schedule (cities.schedule,
 * jsonb — no schema change), category 'restaurant', carrying a `dinner`
 * record. Its night is the schedule day it sits on and its time is the
 * event's startTime, so a drag in the day planner can never disagree with it.
 *
 * Every change is a proposal the user Accepts (frontend lib/dinners.ts applies
 * it). Nothing here writes anywhere.
 */
import { addDays } from '../utils/dates';

/** The `dinner` record on a schedule event. Mirrors frontend lib/types.ts DinnerPlan. */
export type DinnerPlan = {
  restaurant: string;
  city: string;
  partySize: number;
  cuisine?: string;
  priceRange?: string;
  /** Always 'not_booked': nothing in BlueMurr books a table. */
  status: 'not_booked';
  reserveUrl: string;
  reserveVia: string;
  /** The night it was on before the stay's dates moved it (frontend scheduleSync). */
  movedFrom?: string;
};

export type DinnerEvent = {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  category: 'restaurant';
  notes?: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  dinner: DinnerPlan;
};

/** A dinner on the trip: the city it is in, its night, its time. */
export type TripDinner = { cityIndex: number; city: string; date: string; time: string; event: DinnerEvent };

export type DinnerProposal = {
  kind: 'dinner';
  action: 'add' | 'change' | 'remove';
  city: string;
  /** The dinner as it is now (change / remove). */
  before: { date: string; event: DinnerEvent } | null;
  /** The dinner as Accept makes it (add / change). */
  after: { date: string; event: DinnerEvent } | null;
  /** A dinner the planner had put on that evening, which this one replaces. */
  replacesPlanned?: string | null;
};

export type DinnerResult = { type: 'answer'; reply: string } | { type: 'proposal'; reply: string; proposal: DinnerProposal };

export const DEFAULT_DINNER_TIME = '19:30';
/** A dinner block's length on the schedule (the planner's own dinner length). */
export const DINNER_MINUTES = 120;
const PRICE = /^\${1,4}$/;

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
const toTime = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const isIso = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "Wed, Dec 16" */
export function nightLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
/** "7:30 PM" */
export function timeLabel(t: string): string {
  const m = toMin(t);
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const arrivalOf = (c: any): string | null => c?.dates?.arrival ?? c?.arrival_date ?? null;
const departureOf = (c: any): string | null => c?.dates?.departure ?? c?.departure_date ?? null;

/** The nights of a stay: arrival up to (not including) departure. */
export function stayNights(city: any): string[] {
  const a = arrivalOf(city);
  const d = departureOf(city);
  if (!isIso(a) || !isIso(d)) return [];
  const out: string[] = [];
  for (let n = a; n < d && out.length < 400; n = addDays(n, 1)) out.push(n);
  return out;
}

/** Every dinner on the trip, in date order. */
export function tripDinners(trip: any): TripDinner[] {
  const out: TripDinner[] = [];
  (trip?.cities ?? []).forEach((c: any, cityIndex: number) => {
    for (const [date, events] of Object.entries(c?.schedule ?? {})) {
      for (const e of (events as any[]) ?? []) {
        if (e && e.dinner && typeof e.dinner === 'object') {
          out.push({ cityIndex, city: c.name, date, time: String(e.startTime ?? ''), event: e as DinnerEvent });
        }
      }
    }
  });
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/**
 * Where "Reserve" goes. Google Maps' search for the restaurant in its city
 * opens that restaurant's own page (address, phone, website and — where
 * Google has a booking partner — "Reserve a table"). Checked live in Chromium
 * for Paris restaurants. OpenTable and TheFork search links would carry the
 * date, time and party, but neither could be verified to load (OpenTable 503,
 * TheFork 403 to automated browsers), so they are not offered.
 */
export function reserveLink(restaurant: string, city: string): { url: string; via: string } {
  return {
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${restaurant}, ${city}`)}`,
    via: 'Google Maps',
  };
}

/** A planned stop's restaurant name: the stay planner writes "Name (Cuisine)". */
const stopName = (title: string) => /^(.*\S)\s+\([^()]+\)$/.exec(title)?.[1] ?? title;

/** The dinner the planner put on an evening (a planned restaurant stop from 17:00), if any. */
function plannedDinnerOn(city: any, date: string): string | null {
  const e = (city?.schedule?.[date] ?? []).find(
    (x: any) => x && !x.dinner && x.category === 'restaurant' && typeof x.plannedDurationMin === 'number' && toMin(String(x.startTime)) >= 17 * 60,
  );
  return e ? stopName(String(e.title)) : null;
}

/**
 * Restaurants the city's schedule already has on days other than `night`:
 * the planner's meals and other dinner plans. A new dinner avoids them —
 * live, "add a dinner for one night in Paris" picked Clown Bar for Saturday
 * while the schedule already had Clown Bar for Friday's dinner.
 */
function restaurantsOnOtherDays(city: any, night: string): Set<string> {
  const out = new Set<string>();
  for (const [date, events] of Object.entries(city?.schedule ?? {})) {
    if (date === night) continue;
    for (const e of (events as any[]) ?? []) {
      if (!e) continue;
      if (e.dinner && typeof e.dinner.restaurant === 'string') out.add(norm(e.dinner.restaurant));
      else if (e.category === 'restaurant' && typeof e.title === 'string') out.add(norm(stopName(e.title)));
    }
  }
  return out;
}

/** When the traveller lands in a city on its arrival day (HH:MM), if known. */
function landingTime(trip: any, cityIndex: number): string | null {
  const city = trip.cities[cityIndex];
  if (cityIndex === 0) {
    const out = trip?.origin?.outboundLeg;
    if (out?.arriveTime && (!out.arriveDate || out.arriveDate === arrivalOf(city))) return out.arriveTime;
    return null;
  }
  return city?.transportIn?.arriveTime ?? trip.cities[cityIndex - 1]?.transportOut?.arriveTime ?? null;
}

/** Why a night can't hold a dinner at `time` (lands too late), or null. */
function nightProblem(trip: any, cityIndex: number, night: string, time: string): string | null {
  const city = trip.cities[cityIndex];
  if (night !== arrivalOf(city)) return null;
  const lands = landingTime(trip, cityIndex);
  if (lands && toMin(lands) > toMin(time) - 60) return `you only land in ${city.name} at ${lands} that day`;
  return null;
}

function readTime(raw: unknown): { ok: true; time: string | null } | { ok: false; reply: string } {
  if (raw == null || raw === '') return { ok: true, time: null };
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, reply: `I couldn't read "${raw}" as a time — tell me something like 19:30 or 8pm.` };
  const t = `${m[1].padStart(2, '0')}:${m[2]}`;
  if (toMin(t) < 16 * 60 || toMin(t) > 23 * 60) {
    return { ok: false, reply: `${timeLabel(t)} isn't a dinner time — pick something between 4 PM and 11 PM.` };
  }
  return { ok: true, time: t };
}

function readParty(raw: unknown, trip: any): number {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 20) return n;
  const t = Number(trip?.travelers);
  return Number.isInteger(t) && t > 0 ? t : 1;
}

/** The trip city a tool names; with none named, the only city. */
function cityFor(trip: any, raw: unknown): { ok: true; index: number } | { ok: false; reply: string } {
  const cities: any[] = trip?.cities ?? [];
  const names = cities.map((c) => c.name).join(', ');
  const want = norm(String(raw ?? '').split(',')[0]);
  if (!want) {
    if (cities.length === 1) return { ok: true, index: 0 };
    return { ok: false, reply: `Which city should the dinner be in — ${names}?` };
  }
  const i = cities.findIndex((c) => norm(c.name) === want);
  if (i >= 0) return { ok: true, index: i };
  const j = cities.findIndex((c) => norm(c.name).includes(want) || want.includes(norm(c.name)));
  if (j >= 0) return { ok: true, index: j };
  return { ok: false, reply: `${String(raw)} isn't on this trip — its cities are ${names}. Which one should the dinner be in?` };
}

const nightsList = (nights: string[]) => nights.map(nightLabel).join(', ');

/** A restaurant pick that matches a cuisine / price hint. */
function matchesHint(r: any, cuisine: string, price: string): boolean {
  if (cuisine) {
    const c = norm(r.cuisine);
    const n = norm(r.name);
    const h = norm(cuisine);
    if (!(c.includes(h) || h.includes(c) || n.includes(h))) return false;
  }
  if (price && PRICE.test(price) && String(r.priceRange ?? '').trim() !== price) return false;
  return true;
}

function describePick(r: { name: string; cuisine?: string; priceRange?: string }): string {
  const bits = [r.cuisine, r.priceRange].filter((x) => x && String(x).trim());
  return bits.length ? `${r.name} (${bits.join(', ')})` : r.name;
}

function buildEvent(id: string, trip: any, cityName: string, time: string, party: number, pick: any): DinnerEvent {
  const link = reserveLink(pick.name, cityName);
  const cuisine = typeof pick.cuisine === 'string' && pick.cuisine.trim() ? pick.cuisine.trim() : undefined;
  const priceRange = typeof pick.priceRange === 'string' && PRICE.test(pick.priceRange.trim()) ? pick.priceRange.trim() : undefined;
  const end = Math.min(toMin(time) + DINNER_MINUTES, 24 * 60 - 1);
  return {
    id,
    title: pick.name,
    startTime: time,
    endTime: toTime(end),
    category: 'restaurant',
    notes: cuisine && priceRange ? `${cuisine} · ${priceRange}` : cuisine ?? priceRange ?? 'Dinner',
    ...(typeof pick.lat === 'number' && typeof pick.lng === 'number' ? { lat: pick.lat, lng: pick.lng } : {}),
    ...(typeof pick.placeId === 'string' ? { placeId: pick.placeId } : {}),
    dinner: {
      restaurant: pick.name,
      city: cityName,
      partySize: party,
      ...(cuisine ? { cuisine } : {}),
      ...(priceRange ? { priceRange } : {}),
      status: 'not_booked',
      reserveUrl: link.url,
      reserveVia: link.via,
    },
  };
}

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const NOT_BOOKED = (via: string) => `It isn't booked — once it's on your trip, use Reserve to book the table yourself (it opens the restaurant on ${via}).`;

let seq = 0;
const newId = () => `dinner-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** add_dinner. */
export function proposeAddDinner(trip: any, input: any): DinnerResult {
  const where = cityFor(trip, input?.city);
  if (!where.ok) return { type: 'answer', reply: where.reply };
  const cityIndex = where.index;
  const city = trip.cities[cityIndex];
  const nights = stayNights(city);
  if (nights.length === 0) return { type: 'answer', reply: `${city.name} has no nights on this trip yet, so there's no evening to put a dinner on.` };
  const t = readTime(input?.time);
  if (!t.ok) return { type: 'answer', reply: `${t.reply} Nothing changed.` };
  const time = t.time ?? DEFAULT_DINNER_TIME;
  const party = readParty(input?.partySize, trip);
  const dinners = tripDinners(trip);
  const taken = new Set(dinners.filter((d) => d.cityIndex === cityIndex).map((d) => d.date));

  // The night.
  let night: string;
  let nightWhy = '';
  if (input?.date != null && input.date !== '') {
    if (!isIso(input.date) || !nights.includes(input.date)) {
      return {
        type: 'answer',
        reply: `${isIso(input.date) ? nightLabel(input.date) : `"${input.date}"`} isn't one of your nights in ${city.name} — those are ${nightsList(nights)}. Which one?`,
      };
    }
    night = input.date;
    const problem = nightProblem(trip, cityIndex, night, time);
    if (problem) return { type: 'answer', reply: `A ${timeLabel(time)} dinner on ${nightLabel(night)} won't work — ${problem}. Want a later time or another night (${nightsList(nights)})?` };
    const already = dinners.find((d) => d.cityIndex === cityIndex && d.date === night);
    if (already) {
      return { type: 'answer', reply: `You already have dinner at ${already.event.dinner.restaurant} on ${nightLabel(night)} at ${timeLabel(already.time)}. Want me to change that one instead?` };
    }
  } else {
    // A full day there first when the stay has one (not the night you arrive),
    // skipping nights that already have a dinner or that you land too late for.
    const ordered = nights.length > 1 ? [...nights.slice(1), nights[0]] : nights;
    const free = ordered.filter((n) => !taken.has(n) && !nightProblem(trip, cityIndex, n, time));
    if (free.length === 0) {
      return {
        type: 'answer',
        reply: taken.size >= nights.length
          ? `Every night in ${city.name} (${nightsList(nights)}) already has a dinner. Want me to change one of them?`
          : `None of your nights in ${city.name} works for a ${timeLabel(time)} dinner. Want a later time?`,
      };
    }
    night = free[0];
    const n = nights.indexOf(night);
    nightWhy = nights.length === 1 ? ' — your one night there' : n === 0 ? ' — the night you arrive' : ` — your ${ORDINAL[n] ?? `${n + 1}th`} night there`;
  }

  // The restaurant.
  const picks: any[] = Array.isArray(city.restaurants) ? city.restaurants.filter((r: any) => r && typeof r.name === 'string' && r.name.trim()) : [];
  const cuisine = typeof input?.cuisine === 'string' ? input.cuisine.trim() : '';
  const price = typeof input?.priceRange === 'string' ? input.priceRange.trim() : '';
  const named = typeof input?.restaurant === 'string' ? input.restaurant.trim().slice(0, 80) : '';
  const planned = plannedDinnerOn(city, night);
  let pick: any;
  let from = '';
  if (named) {
    pick = picks.find((r) => norm(r.name) === norm(named)) ??
      picks.find((r) => norm(r.name).includes(norm(named)) || norm(named).includes(norm(r.name))) ?? {
        name: named,
        ...(cuisine ? { cuisine } : {}),
        ...(PRICE.test(price) ? { priceRange: price } : {}),
      };
  } else {
    if (picks.length === 0) {
      return { type: 'answer', reply: `I don't have dining suggestions for ${city.name} yet. Tell me a restaurant there and I'll add the dinner.` };
    }
    const fits = picks.filter((r) => matchesHint(r, cuisine, price));
    if (fits.length === 0) {
      const want = [cuisine, PRICE.test(price) ? price : ''].filter(Boolean).join(', ');
      return {
        type: 'answer',
        reply: `None of your ${city.name} dining picks is ${want}. They are: ${picks.map(describePick).join('; ')}. Name one of these, or any restaurant you like, and I'll add it.`,
      };
    }
    const used = new Set(dinners.map((d) => norm(d.event.dinner.restaurant)));
    const elsewhere = restaurantsOnOtherDays(city, night);
    pick =
      fits.find((r) => planned && norm(r.name) === norm(planned) && !used.has(norm(r.name)) && !elsewhere.has(norm(r.name))) ??
      fits.find((r) => !used.has(norm(r.name)) && !elsewhere.has(norm(r.name))) ??
      fits.find((r) => !used.has(norm(r.name))) ??
      fits[0];
    from = ` from your ${city.name} dining picks`;
  }

  const event = buildEvent(newId(), trip, city.name, time, party, pick);
  const replaces = planned && norm(planned) !== norm(pick.name) ? planned : null;
  const reply =
    `Here's dinner for ${people(party)} at ${describePick(pick)}${from}, ${nightLabel(night)} at ${timeLabel(time)} in ${city.name}${nightWhy}.` +
    `${replaces ? ` It takes the place of ${replaces}, which was planned for that evening.` : ''} ${NOT_BOOKED(event.dinner.reserveVia)} Accept to add it to your schedule.`;
  return {
    type: 'proposal',
    reply,
    proposal: { kind: 'dinner', action: 'add', city: city.name, before: null, after: { date: night, event }, replacesPlanned: replaces },
  };
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** The dinner a change / remove names: by id, by city, by restaurant, or the only one. */
function dinnerFor(trip: any, input: any): { ok: true; d: TripDinner } | { ok: false; reply: string } {
  const all = tripDinners(trip);
  if (all.length === 0) return { ok: false, reply: "There's no dinner on your trip yet — want me to add one?" };
  let pool = all;
  const id = typeof input?.dinnerId === 'string' ? input.dinnerId.trim() : '';
  if (id) {
    const hit = all.find((d) => d.event.id === id);
    if (hit) return { ok: true, d: hit };
  }
  const name = norm(input?.currentRestaurant);
  if (name) {
    const hit = pool.filter((d) => norm(d.event.dinner.restaurant).includes(name) || name.includes(norm(d.event.dinner.restaurant)));
    if (hit.length) pool = hit;
  }
  const city = norm(String(input?.city ?? '').split(',')[0]);
  if (city) {
    const hit = pool.filter((d) => norm(d.city) === city);
    if (hit.length) pool = hit;
  }
  if (isIso(input?.currentDate)) {
    const hit = pool.filter((d) => d.date === input.currentDate);
    if (hit.length) pool = hit;
  }
  if (pool.length === 1) return { ok: true, d: pool[0] };
  return {
    ok: false,
    reply: `Which dinner — ${pool.map((d) => `${d.event.dinner.restaurant} in ${d.city} on ${nightLabel(d.date)}`).join(', or ')}?`,
  };
}

/** change_dinner: another night, time, restaurant or party size. */
export function proposeChangeDinner(trip: any, input: any): DinnerResult {
  const found = dinnerFor(trip, input);
  if (!found.ok) return { type: 'answer', reply: found.reply };
  const d = found.d;
  const city = trip.cities[d.cityIndex];
  const nights = stayNights(city);
  const t = readTime(input?.time);
  if (!t.ok) return { type: 'answer', reply: `${t.reply} Nothing changed.` };
  const time = t.time ?? d.time;

  let night = d.date;
  const shift = Number(input?.shiftNights);
  if (isIso(input?.date)) night = input.date;
  else if (Number.isInteger(shift) && shift !== 0) night = addDays(d.date, shift);
  if (!nights.includes(night)) {
    return {
      type: 'answer',
      reply: `${nightLabel(night)} isn't one of your nights in ${city.name} — those are ${nightsList(nights)}. Nothing changed; which night should it be?`,
    };
  }
  if (night !== d.date) {
    const clash = tripDinners(trip).find((x) => x.cityIndex === d.cityIndex && x.date === night && x.event.id !== d.event.id);
    if (clash) return { type: 'answer', reply: `${nightLabel(night)} already has dinner at ${clash.event.dinner.restaurant}. Nothing changed.` };
  }
  const problem = nightProblem(trip, d.cityIndex, night, time);
  if (problem) return { type: 'answer', reply: `A ${timeLabel(time)} dinner on ${nightLabel(night)} won't work — ${problem}. Nothing changed.` };

  const named = typeof input?.restaurant === 'string' ? input.restaurant.trim().slice(0, 80) : '';
  const picks: any[] = Array.isArray(city.restaurants) ? city.restaurants.filter((r: any) => r && typeof r.name === 'string' && r.name.trim()) : [];
  const cuisine = typeof input?.cuisine === 'string' ? input.cuisine.trim() : '';
  const price = typeof input?.priceRange === 'string' && PRICE.test(input.priceRange.trim()) ? input.priceRange.trim() : '';
  const current = { name: d.event.dinner.restaurant, cuisine: d.event.dinner.cuisine, priceRange: d.event.dinner.priceRange, lat: d.event.lat, lng: d.event.lng, placeId: d.event.placeId };
  let pick: any = current;
  if (named && norm(named) !== norm(d.event.dinner.restaurant)) {
    pick = picks.find((r) => norm(r.name) === norm(named)) ?? picks.find((r) => norm(r.name).includes(norm(named)) || norm(named).includes(norm(r.name))) ?? { name: named };
  } else if (!named && (cuisine || price)) {
    // "Make it Italian": a different restaurant of that kind from the city's picks.
    const others = picks.filter((r) => norm(r.name) !== norm(d.event.dinner.restaurant));
    const fits = others.filter((r) => matchesHint(r, cuisine, price));
    if (fits.length === 0) {
      const want = [cuisine, price].filter(Boolean).join(', ');
      return {
        type: 'answer',
        reply: `None of your other ${city.name} dining picks is ${want}${others.length ? ` — they are: ${others.map(describePick).join('; ')}` : ''}. Name a restaurant and I'll switch the dinner to it. Nothing changed.`,
      };
    }
    const elsewhere = restaurantsOnOtherDays(city, night);
    pick = fits.find((r) => !elsewhere.has(norm(r.name))) ?? fits[0];
  }
  const party = input?.partySize != null ? readParty(input.partySize, trip) : d.event.dinner.partySize;

  const changes: string[] = [];
  if (night !== d.date) changes.push(`moves from ${nightLabel(d.date)} to ${nightLabel(night)}`);
  if (time !== d.time) changes.push(`${timeLabel(d.time)} → ${timeLabel(time)}`);
  if (norm(pick.name) !== norm(d.event.dinner.restaurant)) changes.push(`${d.event.dinner.restaurant} → ${pick.name}`);
  if (party !== d.event.dinner.partySize) changes.push(`${people(d.event.dinner.partySize)} → ${people(party)}`);
  if (changes.length === 0) {
    return { type: 'answer', reply: `Your dinner at ${d.event.dinner.restaurant} is already ${nightLabel(d.date)} at ${timeLabel(d.time)} for ${people(party)} — nothing to change.` };
  }
  const event = buildEvent(d.event.id, trip, city.name, time, party, pick);
  return {
    type: 'proposal',
    reply: `Your dinner in ${city.name}: ${changes.join(', ')} — now ${describePick(pick)}, ${nightLabel(night)} at ${timeLabel(time)} for ${people(party)}. Still not booked: use Reserve to book it. Accept to apply it.`,
    proposal: { kind: 'dinner', action: 'change', city: city.name, before: { date: d.date, event: d.event }, after: { date: night, event } },
  };
}

/** remove_dinner. */
export function proposeRemoveDinner(trip: any, input: any): DinnerResult {
  const found = dinnerFor(trip, input);
  if (!found.ok) return { type: 'answer', reply: found.reply };
  const d = found.d;
  return {
    type: 'proposal',
    reply: `Remove dinner at ${d.event.dinner.restaurant} on ${nightLabel(d.date)} at ${timeLabel(d.time)} from your ${d.city} schedule? It was never booked through BlueMurr, so if you reserved it yourself, cancel with the restaurant too. Accept to remove it.`,
    proposal: { kind: 'dinner', action: 'remove', city: d.city, before: { date: d.date, event: d.event }, after: null },
  };
}

/**
 * What a city or date edit does to the trip's dinners, as sentences for its
 * reply — the same rule the frontend applies (lib/scheduleSync): a dinner
 * whose night the stay no longer has moves to the nearest night it still
 * has (a later one on a tie), keeping its time; a dinner in a city the edit
 * removes or replaces goes with it.
 */
export function dinnerEditNotes(trip: any, after: Array<{ name: string; arrival: string; departure: string }>): string {
  const out: string[] = [];
  for (const d of tripDinners(trip)) {
    const stop = after.find((s) => norm(s.name) === norm(d.city));
    const what = `Your dinner at ${d.event.dinner.restaurant} (${nightLabel(d.date)})`;
    if (!stop) {
      out.push(`${what} is removed with ${d.city}.`);
      continue;
    }
    const nights = stayNights({ dates: { arrival: stop.arrival, departure: stop.departure } });
    if (nights.length === 0 || nights.includes(d.date)) continue;
    const to = nearestNight(nights, d.date);
    out.push(`${what} moves to ${nightLabel(to)}, the nearest night you're still in ${d.city}.`);
  }
  return out.join(' ');
}

/** The night nearest `day`; a later one on a tie. Same rule as frontend lib/dinners.ts. */
export function nearestNight(nights: string[], day: string): string {
  const t = (s: string) => Date.parse(`${s}T00:00:00Z`);
  return [...nights].sort((a, b) => Math.abs(t(a) - t(day)) - Math.abs(t(b) - t(day)) || (a < b ? 1 : -1))[0];
}

/** The dinners and dining picks, for the model's TRIP CONTEXT. */
export function diningContext(trip: any): any {
  return {
    dinners: tripDinners(trip).map((d) => ({
      dinnerId: d.event.id,
      city: d.city,
      night: d.date,
      time: d.time,
      restaurant: d.event.dinner.restaurant,
      partySize: d.event.dinner.partySize,
      status: 'not booked (a plan with a Reserve link)',
    })),
    diningPicks: (trip?.cities ?? []).map((c: any) => ({
      city: c.name,
      nights: stayNights(c),
      restaurants: (Array.isArray(c.restaurants) ? c.restaurants : []).map((r: any) => describePick(r)),
    })),
  };
}
