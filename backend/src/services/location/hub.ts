/**
 * Where a traveller lands or leaves from in a city — so the day schedule can
 * draw "Arrive at Rome → first stop" and "last stop → Head to the airport"
 * like any other leg. Offline: airport positions from OurAirports
 * (generated/airportCoords.json), city centres from the location artifact.
 *
 *   flight  the leg's own airport when its code is known (home legs carry
 *           one), else the city's primary airport.
 *   train   the city centre — main stations are central, and no open dataset
 *           here names them. Marked `approximate`.
 */
import airportCoordsJson from '../../data/generated/airportCoords.json';
import { airportDisplayName } from '../../data/locationArtifact';
import { originIndex } from './originAirports';
import { resolve } from './resolve';
import type { Place } from './types';

type AirportCoords = { coords: Record<string, number[]> };
const COORDS = (airportCoordsJson as AirportCoords).coords;

export type Hub = {
  kind: 'airport' | 'station';
  name: string;
  code?: string;
  lat: number;
  lng: number;
  /** True when this is a stand-in (city centre for a station), not the exact spot. */
  approximate: boolean;
};

function placeFor(city: string, country?: string): Place | null {
  for (const q of country ? [`${city}, ${country}`, city] : [city]) {
    try {
      const r = resolve(q, {}, originIndex());
      if (r.status === 'resolved') return r.place;
      // "Rome" alone is ambiguous (Rome, GA); the resolver ranks the
      // prominent reading first, and a trip city is that one.
      if (r.status === 'ambiguous' && r.candidates[0]) return r.candidates[0].place;
    } catch {
      /* fall through */
    }
  }
  return null;
}

export function airportCoords(iata: string): { lat: number; lng: number } | null {
  const c = COORDS[iata.toUpperCase()];
  return c ? { lat: c[0], lng: c[1] } : null;
}

export function hubFor(input: { city: string; country?: string; mode: 'flight' | 'train'; code?: string }): Hub | null {
  const code = input.code?.trim().toUpperCase();
  if (input.mode === 'flight') {
    if (code && /^[A-Z]{3}$/.test(code)) {
      const at = airportCoords(code);
      if (at) return { kind: 'airport', code, name: airportDisplayName(code) ?? code, ...at, approximate: false };
    }
    const place = placeFor(input.city, input.country);
    const iata = place?.airports.find((a) => a.servesPlace && COORDS[a.iata])?.iata;
    const at = iata ? airportCoords(iata) : null;
    if (!iata || !at) return null;
    return { kind: 'airport', code: iata, name: airportDisplayName(iata) ?? iata, ...at, approximate: false };
  }
  const place = placeFor(input.city, input.country);
  if (!place) return null;
  return { kind: 'station', name: `${place.name} station`, lat: place.lat, lng: place.lon, approximate: true };
}
