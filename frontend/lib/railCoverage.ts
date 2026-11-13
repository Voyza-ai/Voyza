import type { Trip, Transport } from './types';

/**
 * Where we have no train data at all, so a leg there is flights-only by
 * construction rather than because no train exists.
 *
 * Our rail providers are European (AllAboard, DB REST) plus static tables
 * for Japan, Korea, China, Taiwan and India. Everywhere below, the train
 * search returns nothing for every route, and the trip used to show flights
 * with no word about why (ROADMAP: "Train unavailable regions … show
 * flights-only silently"). The label is what the notice says.
 */
const US = 'the US';
const CANADA = 'Canada';
const AUSTRALIA = 'Australia';
const AFRICA = 'Africa';
const SOUTH_AMERICA = 'South America';

const REGION_BY_COUNTRY: Record<string, string> = {
  'united states': US,
  'united states of america': US,
  usa: US,
  us: US,
  'u.s.': US,
  'u.s.a.': US,
  america: US,
  canada: CANADA,
  australia: AUSTRALIA,
};

const AFRICAN = [
  'algeria', 'angola', 'benin', 'botswana', 'burkina faso', 'burundi', 'cabo verde', 'cape verde',
  'cameroon', 'central african republic', 'chad', 'comoros', 'congo', 'republic of the congo',
  'democratic republic of the congo', 'dr congo', 'drc', "cote d'ivoire", "côte d'ivoire", 'ivory coast',
  'djibouti', 'egypt', 'equatorial guinea', 'eritrea', 'eswatini', 'swaziland', 'ethiopia', 'gabon',
  'gambia', 'the gambia', 'ghana', 'guinea', 'guinea-bissau', 'kenya', 'lesotho', 'liberia', 'libya',
  'madagascar', 'malawi', 'mali', 'mauritania', 'mauritius', 'morocco', 'mozambique', 'namibia',
  'niger', 'nigeria', 'rwanda', 'sao tome and principe', 'são tomé and príncipe', 'senegal',
  'seychelles', 'sierra leone', 'somalia', 'south africa', 'south sudan', 'sudan', 'tanzania',
  'togo', 'tunisia', 'uganda', 'zambia', 'zimbabwe', 'reunion', 'réunion', 'zanzibar',
];
const SOUTH_AMERICAN = [
  'argentina', 'bolivia', 'brazil', 'chile', 'colombia', 'ecuador', 'guyana', 'paraguay', 'peru',
  'suriname', 'uruguay', 'venezuela', 'french guiana', 'falkland islands',
];
for (const c of AFRICAN) REGION_BY_COUNTRY[c] = AFRICA;
for (const c of SOUTH_AMERICAN) REGION_BY_COUNTRY[c] = SOUTH_AMERICA;

/** The no-train-data region a country belongs to, or null when we cover it (or can't tell). */
export function noRailRegion(country: string | null | undefined): string | null {
  if (!country) return null;
  const key = country.trim().toLowerCase().replace(/\s+/g, ' ');
  return REGION_BY_COUNTRY[key] ?? null;
}

/**
 * The region to name on one inter-city leg, or null. A leg with either end
 * in an uncovered country can't have come back with a train from us, so it
 * is flagged unless a train was in fact found (then there is nothing to say).
 */
export function legNoRailRegion(
  fromCountry: string | null | undefined,
  toCountry: string | null | undefined,
  transport?: Pick<Transport, 'mode' | 'alternatives'> | null,
): string | null {
  if (transport?.mode === 'train') return null;
  if (transport?.alternatives?.some((a) => a.mode === 'train')) return null;
  return noRailRegion(fromCountry) ?? noRailRegion(toCountry);
}

/** Every no-train-data region the trip's inter-city legs pass through, in route order. */
export function tripNoRailRegions(trip: Pick<Trip, 'cities'>): string[] {
  const out: string[] = [];
  const cities = trip.cities ?? [];
  for (let i = 0; i < cities.length - 1; i++) {
    const r = legNoRailRegion(cities[i].country, cities[i + 1].country, cities[i].transportOut);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** "the US", "the US and Canada", "the US, Canada and Australia". */
export function joinRegions(regions: string[]): string {
  if (regions.length <= 1) return regions[0] ?? '';
  return `${regions.slice(0, -1).join(', ')} and ${regions[regions.length - 1]}`;
}
