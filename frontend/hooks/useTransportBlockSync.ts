'use client';

import { useEffect } from 'react';
import { useTripStore } from '@/store/tripStore';
import { reconcileDayTransport } from '@/lib/dayScheduleDefaults';

/**
 * Keep every day's travel blocks in step with the trip's transport.
 *
 * Mounted once on the results page, so it covers every view at the same
 * time — Calendar, Schedule, and a Day Planner that is open while the user
 * swaps a flight on the Flowchart (the planner reads the same store, so the
 * blocks move under it live). Only days that already have a schedule are
 * visited; days nobody has opened are built fresh, from the current
 * transport, whenever a view first needs them.
 *
 * Each pass writes only the days whose fingerprint changed, and a write
 * leaves every fingerprint current, so the effect settles after one round.
 */
export function useTransportBlockSync() {
  const trip = useTripStore((s) => s.currentTrip);
  const setDaySchedule = useTripStore((s) => s.setDaySchedule);

  useEffect(() => {
    if (!trip) return;
    trip.cities.forEach((city, cityIndex) => {
      for (const [date, events] of Object.entries(city.schedule ?? {})) {
        if (!Array.isArray(events) || events.length === 0) continue;
        const next = reconcileDayTransport(events, city, date, trip, cityIndex);
        if (next) setDaySchedule(cityIndex, date, next);
      }
    });
  }, [trip, setDaySchedule]);
}
