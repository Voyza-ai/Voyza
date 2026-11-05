import type { Trip } from './types';
import type { ActivitySuggestion, RestaurantSuggestion } from './api';

/**
 * Each city's AI picks are asked separately and in parallel, so two nearby
 * stops could both be handed the same landmark (ROADMAP: the Uffizi on Rome's
 * list as well as Florence's). The backend now tells each request about the
 * trip's other stops; this is the backstop for an exact repeat that still
 * gets through: a pick another city already has stays with that city.
 */

/** "The Uffizi Gallery" and "Uffizi gallery" are one place; accents and punctuation don't count. */
export function pickKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

export function dedupeAcrossCities<
  P extends { activities: ActivitySuggestion[]; restaurants: RestaurantSuggestion[] },
>(trip: Pick<Trip, 'cities'>, cityName: string, picks: P): P {
  const taken = new Set<string>();
  for (const c of trip.cities ?? []) {
    if (c.name === cityName) continue;
    for (const a of c.activities ?? []) taken.add(pickKey(a));
    for (const r of c.restaurants ?? []) taken.add(pickKey(r.name));
  }
  if (taken.size === 0) return picks;
  const fresh = (name: string) => {
    const k = pickKey(name);
    if (!k || taken.has(k)) return false;
    taken.add(k); // and no repeat inside this city's own list either
    return true;
  };
  return {
    ...picks,
    activities: picks.activities.filter((a) => fresh(a.name)),
    restaurants: picks.restaurants.filter((r) => fresh(r.name)),
  };
}
