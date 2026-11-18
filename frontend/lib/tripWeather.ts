'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Trip } from './types';
import { fetchTripWeather, type DayWeather, type TripWeather } from './api';

/**
 * The trip's weather for the Calendar and Schedule views: the same data the
 * BlueMurr AI chat's weather answers use (backend services/weather.ts) — a
 * MET Norway forecast where it reaches, and past years' averages for the
 * date beyond it, which are labelled "avg" and never shown as a forecast.
 * Fetched once per trip shape (cities and dates) and shared by both views.
 */

const cache = new Map<string, Promise<TripWeather | null>>();

/** What the weather depends on: home (for °F) and each city's dates. */
export function tripWeatherKey(trip: Pick<Trip, 'cities' | 'origin'> | null | undefined): string | null {
  const cities = (trip?.cities ?? []).filter((c) => c?.name && c.dates?.arrival && c.dates?.departure);
  if (cities.length === 0) return null;
  return [trip?.origin?.city ?? '', ...cities.map((c) => `${c.name}|${c.dates.arrival}|${c.dates.departure}`)].join('§');
}

function load(trip: Pick<Trip, 'cities' | 'origin'>, key: string): Promise<TripWeather | null> {
  const held = cache.get(key);
  if (held) return held;
  const p = Promise.resolve()
    .then(() => (typeof fetchTripWeather === 'function' ? fetchTripWeather(trip as any) : null))
    .then((w) => w ?? null)
    .catch(() => {
      // Not kept: a later render may try again.
      cache.delete(key);
      return null;
    });
  cache.set(key, p);
  return p;
}

export type TripWeatherLookup = {
  /** The day's weather in `city` (or, without one, in whichever trip city has that day). */
  at: (city: string | null | undefined, iso: string) => DayWeather | null;
  fahrenheit: boolean;
  typicalYears: string | null;
};

export function useTripWeather(trip: Pick<Trip, 'cities' | 'origin'> | null | undefined): TripWeatherLookup {
  const key = tripWeatherKey(trip);
  const [data, setData] = useState<{ key: string; w: TripWeather } | null>(null);
  useEffect(() => {
    if (!key || !trip) return;
    let live = true;
    load(trip, key).then((w) => {
      if (live && w) setData({ key, w });
    });
    return () => {
      live = false;
    };
    // The key holds everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => {
    const w = data && data.key === key ? data.w : null;
    const byCity = new Map<string, Map<string, DayWeather>>();
    for (const c of w?.cities ?? []) byCity.set(c.city.toLowerCase(), new Map(c.days.map((d) => [d.date, d])));
    return {
      at: (city, iso) => {
        if (city) return byCity.get(city.toLowerCase())?.get(iso) ?? null;
        let found: DayWeather | null = null;
        byCity.forEach((days) => {
          if (!found && days.has(iso)) found = days.get(iso)!;
        });
        return found;
      },
      fahrenheit: !!w?.fahrenheit,
      typicalYears: w?.cities.find((c) => c.typicalYears)?.typicalYears ?? null,
    };
  }, [data, key]);
}

/** For tests: forget fetched weather. */
export function __resetTripWeather(): void {
  cache.clear();
}

// ─── How a day reads ──────────────────────────────────────────────────

const SUMMARY_EMOJI: Array<[RegExp, string]> = [
  [/thunder/, '⛈️'],
  [/snow|sleet/, '🌨️'],
  [/rain/, '🌧️'],
  [/showers/, '🌦️'],
  [/fog/, '🌫️'],
  [/^cloudy/, '☁️'],
  [/partly cloudy/, '⛅'],
  [/mostly sunny/, '🌤️'],
  [/sunny/, '☀️'],
];

/**
 * The day as one emoji. A forecast by its own words; a typical day by how
 * often the date was wet in past years (it says nothing about this year).
 */
export function weatherEmoji(d: DayWeather): string {
  if (d.kind === 'forecast') {
    const words = (d.summary ?? '').toLowerCase();
    for (const [re, e] of SUMMARY_EMOJI) if (re.test(words)) return e;
    return (d.precipMm ?? 0) >= 1 ? '🌧️' : '⛅';
  }
  const wet = d.wetDayShare ?? 0;
  if (wet >= 0.25 && d.highC <= 1) return '🌨️';
  if (wet >= 0.5) return '🌧️';
  if (wet >= 0.25) return '🌦️';
  return '🌤️';
}

const deg = (c: number, f: boolean) => Math.round(f ? (c * 9) / 5 + 32 : c);

/** "49°/40°" */
export function weatherTemps(d: DayWeather, fahrenheit: boolean): string {
  return `${deg(d.highC, fahrenheit)}°/${deg(d.lowC, fahrenheit)}°`;
}

/** The hover text: what the chip means and where it comes from. */
export function weatherTitle(d: DayWeather, fahrenheit: boolean, typicalYears?: string | null): string {
  const u = fahrenheit ? '°F' : '°C';
  const hi = `${deg(d.highC, fahrenheit)}${u}`;
  const lo = `${deg(d.lowC, fahrenheit)}${u}`;
  if (d.kind === 'forecast') {
    const rain = (d.precipMm ?? 0) >= 0.1 ? `, ${d.precipMm} mm rain` : '';
    return `Forecast: ${d.summary ?? 'mixed'}, high ${hi}, low ${lo}${rain} (MET Norway)`;
  }
  const pct = Math.round((d.wetDayShare ?? 0) * 100);
  return `Typical for this date${typicalYears ? ` (${typicalYears} average)` : ''}, not a forecast: high ${hi}, low ${lo}, rain on ${pct}% of past years`;
}
