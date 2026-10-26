/**
 * Prominence, scaled at query time from RAW artifact fields.
 *
 * The artifact stores raw population and raw airport size on purpose (see the
 * comment on `Place.population`): normalising at build time anchors the scale
 * to the dataset's extremes, so adding one city rescales every weight and
 * silently invalidates any tuned constant on the next rebuild. The constants
 * below are therefore FIXED — they are properties of the world (a 20 million
 * person city, a 100 million passenger airport are both roughly the ceiling),
 * not of the dataset, so the scale survives a rebuild.
 *
 * Log scaling, because both inputs are heavy-tailed: linear scaling puts Tokyo
 * at 1.0 and every other city at approximately 0, which collapses every
 * comparison that matters.
 *
 * Airport size outweighs population because it was measured to: Spearman
 * 0.578 against real route traffic versus 0.451 for population at best. This
 * is an ORIGIN scorer — it ranks how likely a traveller is to fly from a
 * place, not how many people live there.
 */

import type { Place } from './types';

/** Population that scores 1.0. Roughly the largest city proper on earth. */
const POPULATION_CEILING = 20_000_000;
/** Airport prominence that scores 1.0, in the artifact's raw units. */
const AIRPORT_CEILING = 100_000_000;

const AIRPORT_WEIGHT = 0.65;
const POPULATION_WEIGHT = 0.35;

function logScale(value: number | null, ceiling: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  const scaled = Math.log1p(value) / Math.log1p(ceiling);
  return Math.max(0, Math.min(1, scaled));
}

/**
 * 0..1. Used for ranking, and for the same-country near-tie gate — never as
 * the deciding signal across countries, where it was measured to resolve only
 * 14% of 698 contested names.
 */
export function prominenceOf(place: Place): number {
  return (
    AIRPORT_WEIGHT * logScale(place.airportRank, AIRPORT_CEILING) +
    POPULATION_WEIGHT * logScale(place.population, POPULATION_CEILING)
  );
}
