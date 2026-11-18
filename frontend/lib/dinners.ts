import type { DinnerProposal } from './api';
import type { Trip, UnscheduledItem } from './types';
import { syncCitySchedule } from './scheduleSync';
import { insertDinner, stayNights } from './dinnerPlace';
import { parseStop } from './stayRelay';

export { cityDinners, isDinner, nightLabel, timeLabel } from './dinnerPlace';

/**
 * A dinner proposal from the BlueMurr AI chat (backend services/dinner.ts),
 * applied to the trip as it is NOW. Null when it no longer applies: the city
 * is gone, the night is no longer part of the stay, or the dinner a change /
 * removal was made against is no longer on the trip — the caller says so and
 * changes nothing.
 *
 * The dinner lives on the city's day schedule (saved with the trip as
 * cities.schedule), so the Schedule, the Calendar's day planner and the
 * city's guide all read it from there.
 */
export function applyDinnerProposal(trip: Trip, p: DinnerProposal): Trip | null {
  const idx = trip.cities.findIndex((c) => c.name.toLowerCase() === p.city.toLowerCase());
  if (idx < 0) return null;
  let city = trip.cities[idx];
  if (p.after && !stayNights(city).includes(p.after.date)) return null;
  if (p.before) {
    const id = p.before.event.id;
    const there = Object.values(city.schedule ?? {}).some((evs) => evs.some((e) => e.id === id));
    if (!there) return null;
  }

  // A stay nobody has opened yet has no schedule: lay it out first, so the
  // dinner joins a planned day rather than standing alone on it.
  if (!city.schedule) {
    const built = syncCitySchedule(trip, idx);
    city = { ...city, schedule: built?.schedule ?? {}, unscheduled: built?.unscheduled ?? city.unscheduled };
  }

  const schedule = { ...(city.schedule ?? {}) };
  if (p.before) {
    for (const [d, evs] of Object.entries(schedule)) {
      if (evs.some((e) => e.id === p.before!.event.id)) schedule[d] = evs.filter((e) => e.id !== p.before!.event.id);
    }
  }
  let unscheduled: UnscheduledItem[] = [...(city.unscheduled ?? [])];
  if (p.after) {
    const { movedFrom: _old, ...plan } = p.after.event.dinner!;
    const placed = insertDinner(schedule[p.after.date] ?? [], { ...p.after.event, dinner: plan }, p.after.date);
    schedule[p.after.date] = placed.events;
    const names = new Set(placed.dropped.map((u) => u.title.toLowerCase()));
    unscheduled = [...unscheduled.filter((u) => !names.has(u.title.toLowerCase())), ...placed.dropped];
    // The dinner's restaurant is not also a planned meal elsewhere in the
    // stay (a stay laid out just above can have it as another day's lunch).
    // Only the planner's stops go; the traveller's own blocks stay.
    const spot = p.after.event.dinner!.restaurant.trim().toLowerCase();
    for (const [d, evs] of Object.entries(schedule)) {
      const kept = evs.filter(
        (e) => e.dinner || e.category !== 'restaurant' || typeof e.plannedDurationMin !== 'number' || parseStop(e).name.trim().toLowerCase() !== spot,
      );
      if (kept.length !== evs.length) schedule[d] = kept;
    }
  }
  const cities = [...trip.cities];
  cities[idx] = { ...city, schedule, unscheduled };
  return { ...trip, cities };
}
