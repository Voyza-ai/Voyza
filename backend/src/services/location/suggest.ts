/**
 * Type-ahead suggestions for the Settings "Home city" and "Home airport"
 * fields. Offline: built once from the same GeoNames / OurAirports artifact
 * the resolver uses, so a keystroke costs a few array scans and no API call.
 */
import { airportDisplayName, allPlaces, locationAirportRanks } from '../../data/locationArtifact';
import type { Place } from './types';

export type CitySuggestion = {
  label: string;
  name: string;
  country: string;
  /** The airport a home leg would usually fly from (metro code if it has one). */
  airport: string | null;
};

export type AirportSuggestion = {
  iata: string;
  name: string;
  city: string | null;
  country: string | null;
  label: string;
};

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

let countryNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  try {
    countryNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

type CityRow = { place: Place; keys: string[]; pop: number };
type AirportRow = { iata: string; name: string; city: Place | null; keys: string[]; pop: number };

let cities: CityRow[] | null = null;
let airports: AirportRow[] | null = null;

function cityRows(): CityRow[] {
  if (cities) return cities;
  cities = allPlaces()
    .filter((p) => p.kind === 'city' || p.kind === 'metro')
    .map((place) => ({
      place,
      keys: [place.name, ...place.curatedAliases].map(fold).filter(Boolean),
      pop: place.population ?? 0,
    }))
    .sort((a, b) => b.pop - a.pop);
  return cities;
}

function airportRows(): AirportRow[] {
  if (airports) return airports;
  // Each airport belongs to the BIGGEST city within 40 km of it (SFO → San
  // Francisco, not suburban San Mateo nor bigger-but-farther San Jose); if no
  // city is that close, the nearest one within 60 km.
  const best = new Map<string, { place: Place; score: number }>();
  for (const { place, pop } of cityRows()) {
    for (const a of place.airports) {
      if (!a.servesPlace || a.km > 60) continue;
      const score = a.km <= 40 ? -pop : a.km;
      const cur = best.get(a.iata);
      if (!cur || score < cur.score) best.set(a.iata, { place, score });
    }
  }
  const owner = new Map<string, Place>([...best].map(([k, v]) => [k, v.place]));
  const codes = new Set<string>(owner.keys());
  airports = [...codes]
    .map((iata) => {
      const name = airportDisplayName(iata) ?? iata;
      const city = owner.get(iata) ?? null;
      // Every word of the airport name is a key ("heath" → London Heathrow).
      const nameWords = fold(name).split(' ');
      return {
        iata,
        name,
        city,
        keys: [...nameWords.map((_, i) => nameWords.slice(i).join(' ')), fold(city?.name ?? '')].filter(Boolean),
        pop: city?.population ?? 0,
      };
    })
    // Big airports first (OurAirports type: 3 = large), then by city size.
    .sort((a, b) => (locationAirportRanks.ranks[b.iata] ?? 0) - (locationAirportRanks.ranks[a.iata] ?? 0) || b.pop - a.pop);
  return airports;
}

function cityLabel(p: Place): string {
  const region = p.country === 'US' && p.admin && /^[A-Z]{2}$/.test(p.admin) ? `, ${p.admin}` : '';
  return `${p.name}${region}, ${countryName(p.country)}`;
}

function primaryAirport(p: Place): string | null {
  if (p.metro) return p.metro;
  return p.airports.find((a) => a.servesPlace)?.iata ?? null;
}

/** Word-prefix match: "york" does not match "New York", "new y" does. */
const matches = (keys: string[], q: string) => keys.some((k) => k.startsWith(q));

export function suggestCities(query: string, limit = 6): CitySuggestion[] {
  const q = fold(query);
  if (!q) return [];
  const out: CitySuggestion[] = [];
  const seen = new Set<string>();
  for (const row of cityRows()) {
    if (!matches(row.keys, q)) continue;
    const label = cityLabel(row.place);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, name: row.place.name, country: row.place.country, airport: primaryAirport(row.place) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Matches whose airport or city name STARTS with the query come first; among
 * those, bigger airports, then bigger cities; a name-start breaks the last tie
 * (SFO over OAK).
 */
const nameHead = (r: AirportRow, q: string) => (fold(r.name).startsWith(q) ? 0 : 1);
const head = (r: AirportRow, q: string) =>
  nameHead(r, q) === 0 || fold(r.city?.name ?? '').startsWith(q) ? 0 : 1;
const rank = (r: AirportRow) => locationAirportRanks.ranks[r.iata] ?? 0;
const byRelevance = (q: string) => (a: AirportRow, b: AirportRow) =>
  head(a, q) - head(b, q) || rank(b) - rank(a) || b.pop - a.pop || nameHead(a, q) - nameHead(b, q);

export function suggestAirports(query: string, limit = 6): AirportSuggestion[] {
  const q = fold(query);
  if (!q) return [];
  const code = q.toUpperCase().replace(/\s/g, '');
  const rows = airportRows();
  const exact = code.length === 3 ? rows.filter((r) => r.iata === code) : [];
  const codePrefix = code.length <= 3 ? rows.filter((r) => r.iata !== code && r.iata.startsWith(code)) : [];
  const named = rows
    .filter((r) => !r.iata.startsWith(code) && matches(r.keys, q))
    .sort(byRelevance(q));
  const out: AirportSuggestion[] = [];
  for (const r of [...exact, ...named.slice(0, limit), ...codePrefix]) {
    if (out.some((o) => o.iata === r.iata)) continue;
    const city = r.city?.name ?? null;
    out.push({
      iata: r.iata,
      name: r.name,
      city,
      country: r.city ? countryName(r.city.country) : null,
      label: `${r.iata} · ${r.name}${city && !r.name.includes(city) ? `, ${city}` : ''}`,
    });
    if (out.length >= limit) break;
  }
  return out;
}
