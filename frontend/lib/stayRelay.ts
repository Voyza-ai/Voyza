import type { City, ScheduledEvent, Trip } from './types';
import type { ActivitySuggestion, RestaurantSuggestion } from './api';
import { parseLocal, toIso } from './dateHelpers';
import { buildCityScheduleFromSuggestions, buildDefaultSchedule } from './dayScheduleDefaults';
import { coordsOf } from './geoSchedule';
import { homeDepartureDay } from './tripSpan';

/**
 * Re-plan a city's stay after its dates moved (cities swapped or re-dated in
 * Canvas, a city edit shifting the trip).
 *
 * A city's schedule is keyed by date. When the stay moves, those keys no
 * longer cover it, and the Schedule tab used to fill each uncovered day on its
 * own from the bare `city.activities` strings: no coordinates (so no dashed
 * travel lines between stops) and the same list repeated every day.
 *
 * Instead the stay is laid out again by the planner's own stay-wide,
 * geographic scheduler, from the picks the city already had — taken back off
 * its old schedule, where each planned stop keeps its coordinates, its length
 * and its time of day — plus anything on its curated lists not yet placed.
 *
 * Each stop is placed once. Blocks the traveller added by hand stay on their
 * day when that day is still part of the stay. Days outside the new stay are
 * dropped: no view shows them, and they are what made a moved city "keep its
 * old schedule".
 *
 * A stay that did NOT move but has days the planner left empty only has those
 * days filled (see `fillGaps`).
 *
 * Returns the city's new schedule, or null when nothing needs doing — every
 * day of the stay already has a schedule, or there is nothing to place.
 */
export function relayMovedStay(
  trip: Trip,
  cityIndex: number,
): { schedule: Record<string, ScheduledEvent[]>; unscheduled: City['unscheduled'] } | null {
  const city = trip.cities[cityIndex];
  if (!city || !validIso(city.dates.arrival) || !validIso(city.dates.departure)) return null;

  const stay = stayDays(city.dates.arrival, city.dates.departure);
  if (stay.length === 0) return null;
  const old = city.schedule ?? {};
  // The days this city's schedule has to hold: its nights, plus the fly-home
  // morning when it is the last city.
  const isLast = cityIndex === trip.cities.length - 1;
  const cover = isLast && !stay.includes(city.dates.departure) ? [...stay, city.dates.departure] : stay;
  if (cover.every((d) => old[d] !== undefined)) return null;

  const hasOwn = (d: string) => (old[d] ?? []).some((e) => e.category !== 'transport');
  // Days that legitimately sit outside the nights of the stay: the fly-home
  // morning of the last city and the home-departure day of the first.
  const ownDays = new Set(stay);
  if (isLast) ownDays.add(city.dates.departure);
  const homeDeparture = cityIndex === 0 ? homeDepartureDay(trip) : null;
  if (homeDeparture) ownDays.add(homeDeparture);
  // Moved: the city's planned stops sit on dates that are no longer its own,
  // or none of its stay is planned at all. A stay the planner merely left a
  // day empty in is not re-planned.
  const movedAway = Object.keys(old).some((d) => !ownDays.has(d) && hasOwn(d));
  if (!movedAway && stay.some(hasOwn)) return fillGaps(trip, cityIndex, cover);

  // The traveller's own blocks (added by hand) on days still in the stay
  // stay where they are; every planned stop is re-planned.
  const own = (e: ScheduledEvent) => e.category === 'custom' || e.category === 'free';
  const seen = new Set<string>();

  // Picks taken back off every other day of the old schedule.
  const activities: ActivitySuggestion[] = [];
  const restaurants: RestaurantSuggestion[] = [];
  const days = Object.keys(old).sort();
  for (const d of days) {
    for (const e of [...old[d]].sort((a, b) => a.startTime.localeCompare(b.startTime))) {
      if (e.category !== 'activity' && e.category !== 'restaurant') continue;
      const stop = parseStop(e);
      const key = itemKey(stop.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const start = toMin(e.startTime);
      const length = e.plannedDurationMin ?? Math.max(30, toMin(e.endTime) - start);
      if (stop.meal) {
        restaurants.push({
          name: stop.name,
          cuisine: stop.meal.cuisine,
          priceRange: stop.meal.priceRange,
          mealType: start < 11 * 60 ? 'breakfast' : start < 16 * 60 ? 'lunch' : 'dinner',
          reason: stop.meal.reason,
          ...coordsOf(e),
        });
      } else {
        activities.push({
          name: stop.name,
          // A food / nightlife activity is shown as a restaurant block; keep it so.
          category: e.category === 'restaurant' ? 'food' : 'experience',
          timeOfDay: start < 12 * 60 ? 'morning' : start < 17 * 60 ? 'afternoon' : 'evening',
          durationHours: length / 60,
          reason: e.notes ?? '',
          ...coordsOf(e),
        });
      }
    }
  }

  // Curated items the old schedule never placed (or a city with no schedule).
  for (const name of city.activities) {
    const key = itemKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    activities.push({ name, category: 'experience', timeOfDay: 'afternoon', durationHours: 1.5, reason: '' });
  }
  for (const r of city.restaurants) {
    const key = itemKey(r.name);
    if (seen.has(key)) continue;
    seen.add(key);
    restaurants.push({
      name: r.name,
      cuisine: r.cuisine,
      priceRange: r.priceRange as RestaurantSuggestion['priceRange'],
      mealType: 'any',
      reason: '',
      ...coordsOf(r),
    });
  }

  if (activities.length === 0 && restaurants.length === 0) {
    // Nothing of the city's to place: the per-day transport-only build is
    // already what this stay can have.
    return null;
  }

  const built = buildCityScheduleFromSuggestions(activities, restaurants, city, cityIndex, trip);
  const schedule: Record<string, ScheduledEvent[]> = {};
  for (const [d, events] of Object.entries(built.schedule)) schedule[d] = events;
  for (const d of Array.from(ownDays)) {
    const mine = (old[d] ?? []).filter(own);
    if (mine.length > 0) schedule[d] = [...(schedule[d] ?? []), ...mine].sort((x, y) => x.startTime.localeCompare(y.startTime));
  }
  // Every stay day gets a key, so a day the planner left empty is not
  // re-planned on the next render.
  for (const d of cover) if (schedule[d] === undefined) schedule[d] = [];
  return { schedule, unscheduled: built.unscheduled };
}

/**
 * A stay that did not move but has days the planner left empty (it ran out
 * of picks before it ran out of days). Each such day gets only the city's
 * curated stops that no day of the stay has placed yet — never the whole list
 * again, which is what repeated the same stops on every unplanned day. A day
 * nothing is left for keeps just its transport, or stays empty.
 */
function fillGaps(trip: Trip, cityIndex: number, cover: string[]): ReturnType<typeof relayMovedStay> {
  const city = trip.cities[cityIndex];
  const old = city.schedule ?? {};
  const missing = cover.filter((d) => old[d] === undefined);
  if (missing.length === 0) return null;

  const placed = new Set<string>();
  for (const events of Object.values(old)) for (const e of events) placed.add(itemKey(parseStop(e).name));
  let activities = city.activities.filter((a) => !placed.has(itemKey(a)));
  let restaurants = city.restaurants.filter((r) => !placed.has(itemKey(r.name)));

  const schedule = { ...old };
  for (const d of missing) {
    const events = buildDefaultSchedule({ ...city, activities, restaurants }, d, trip, cityIndex);
    schedule[d] = events;
    // What this day took is not offered to the next empty one.
    const used = new Set(events.map((e) => itemKey(parseStop(e).name)));
    activities = activities.filter((a) => !used.has(itemKey(a)));
    restaurants = restaurants.filter((r) => !used.has(itemKey(r.name)));
  }
  return { schedule, unscheduled: city.unscheduled };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (s: string | undefined): s is string => !!s && ISO_DAY.test(s);
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
const itemKey = (name: string) => name.trim().toLowerCase();

const PRICE = /^\$\$?\$?\$?$/;
type Price = RestaurantSuggestion['priceRange'];

/**
 * What a planned stop was. The stay planner writes a meal as
 * "Name (Cuisine)" with notes "$$ · reason"; the per-day build writes "Name"
 * with notes "Cuisine · $$". A restaurant-coloured block in neither shape is
 * a food or nightlife ACTIVITY (a food tour), not a meal.
 */
function parseStop(e: ScheduledEvent): { name: string; meal?: { cuisine: string; priceRange: Price; reason: string } } {
  if (e.category !== 'restaurant') return { name: e.title };
  const [a = '', ...rest] = (e.notes ?? '').split(' · ');
  const b = rest.join(' · ');
  const titled = /^(.*\S)\s+\(([^()]+)\)$/.exec(e.title);
  if (titled && PRICE.test(a.trim())) {
    return { name: titled[1], meal: { cuisine: titled[2], priceRange: a.trim() as Price, reason: b } };
  }
  if (PRICE.test(b.trim())) {
    return { name: e.title, meal: { cuisine: a.trim() || 'Local', priceRange: b.trim() as Price, reason: '' } };
  }
  return { name: e.title };
}

/** Arrival up to (not including) departure — the nights of the stay. */
function stayDays(arrival: string, departure: string): string[] {
  const start = parseLocal(arrival);
  const end = parseLocal(departure);
  const out: string[] = [];
  for (let d = new Date(start); d < end && out.length < 366; d.setDate(d.getDate() + 1)) out.push(toIso(d));
  return out;
}
