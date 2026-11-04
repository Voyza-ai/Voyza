'use client';

/**
 * The airport / station at each end of the travel on a given day, located
 * (backend GET /api/locations/hub — offline OurAirports + city centres), so
 * the schedule can draw "Arrive at Rome → first stop" and "last stop → Head to
 * the airport" like every other leg.
 *
 * Mirrors `buildDayTransportContext`'s choice of legs: the home outbound leg
 * brings the traveller to cities[0], the home return leg takes them from the
 * last city, and inter-city legs are `transportIn` / `transportOut`.
 */
import { useEffect, useState } from 'react';
import { getHub, type Hub } from './api';
import type { Trip } from './types';

type HubQuery = { city: string; country?: string; mode: 'flight' | 'train'; code?: string };

/** One leg touching this day: where it leaves from, where it lands. */
export type DayLeg = { departTime?: string; from: HubQuery | null; to: HubQuery | null };

export function legsForDay(
  trip: Pick<Trip, 'cities' | 'origin'>,
  cityIndex: number,
  date: string,
): { inbound: DayLeg | null; outbound: DayLeg | null } {
  const city = trip.cities[cityIndex];
  if (!city) return { inbound: null, outbound: null };
  const last = trip.cities.length - 1;
  const prev = trip.cities[cityIndex - 1];
  const next = trip.cities[cityIndex + 1];
  const home = trip.origin;
  let inbound: DayLeg | null = null;
  let outbound: DayLeg | null = null;

  if (city.dates.arrival === date) {
    const homeLeg = cityIndex === 0 ? home?.outboundLeg : null;
    if (homeLeg?.arriveTime) {
      inbound = {
        departTime: homeLeg.departTime ?? undefined,
        from: home ? { city: home.city, mode: 'flight', code: homeLeg.originAirport } : null,
        to: { city: city.name, country: city.country, mode: 'flight', code: homeLeg.destAirport },
      };
    } else if (city.transportIn?.arriveTime && !city.transportIn.unavailable) {
      const mode = city.transportIn.mode;
      inbound = {
        departTime: city.transportIn.departTime,
        from: prev ? { city: prev.name, country: prev.country, mode } : null,
        to: { city: city.name, country: city.country, mode },
      };
    }
  }

  if (city.dates.departure === date) {
    const homeLeg = cityIndex === last ? home?.returnLeg : null;
    if (homeLeg?.departTime) {
      outbound = {
        departTime: homeLeg.departTime,
        from: { city: city.name, country: city.country, mode: 'flight', code: homeLeg.originAirport },
        to: home ? { city: home.city, mode: 'flight', code: homeLeg.destAirport } : null,
      };
    } else if (city.transportOut?.departTime && !city.transportOut.unavailable) {
      const mode = city.transportOut.mode;
      outbound = {
        departTime: city.transportOut.departTime,
        from: { city: city.name, country: city.country, mode },
        to: next ? { city: next.name, country: next.country, mode } : null,
      };
    }
  }
  return { inbound, outbound };
}

/** Located hubs for a day's connectors. */
export type DayHubs = {
  /** Where "Arrive at …" happens. */
  arrive: Hub | null;
  /** Where each "Head to …" goes, keyed by the departure time it leads up to. */
  departs: Array<{ departTime?: string; hub: Hub }>;
};

export const NO_HUBS: DayHubs = { arrive: null, departs: [] };

const cache = new Map<string, Promise<Hub | null>>();
const keyOf = (q: HubQuery) => `${q.city}|${q.country ?? ''}|${q.mode}|${q.code ?? ''}`.toLowerCase();

function locate(q: HubQuery | null): Promise<Hub | null> {
  if (!q) return Promise.resolve(null);
  const key = keyOf(q);
  let p = cache.get(key);
  if (!p) {
    p = Promise.resolve()
      .then(() => getHub(q))
      .catch(() => {
        cache.delete(key); // a network blip is retried next render, not remembered
        return null;
      });
    cache.set(key, p);
  }
  return p;
}

export function useDayHubs(
  trip: Pick<Trip, 'cities' | 'origin'> | null | undefined,
  cityIndex: number | null,
  date: string,
): DayHubs {
  const [hubs, setHubs] = useState<DayHubs>(NO_HUBS);
  const legs = trip && cityIndex !== null ? legsForDay(trip, cityIndex, date) : { inbound: null, outbound: null };
  const sig = JSON.stringify(legs);

  useEffect(() => {
    let live = true;
    const { inbound, outbound } = JSON.parse(sig) as ReturnType<typeof legsForDay>;
    Promise.all([
      locate(inbound?.to ?? null),
      locate(inbound?.from ?? null),
      locate(outbound?.from ?? null),
    ]).then(([arrive, inboundFrom, outboundFrom]) => {
      if (!live) return;
      const departs: DayHubs['departs'] = [];
      if (inboundFrom) departs.push({ departTime: inbound?.departTime, hub: inboundFrom });
      if (outboundFrom) departs.push({ departTime: outbound?.departTime, hub: outboundFrom });
      setHubs({ arrive, departs });
    });
    return () => {
      live = false;
    };
  }, [sig]);

  return hubs;
}
