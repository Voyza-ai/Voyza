'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Trip, City, TransportMode } from '@/lib/types';
import { parseLocal, toIso, daysBetween } from '@/lib/dateHelpers';
import { buildDefaultSchedule } from '@/lib/dayScheduleDefaults';
import { useTripStore } from '@/store/tripStore';
import DayCard from './DayCard';
import DayPlanner from './DayPlanner';

/**
 * Horizontal-scrolling sibling to `CalendarView`. Where the calendar is
 * a month grid where each day is a tiny cell, this view renders one
 * tall card per day in trip order, side-by-side, so the user can compare
 * "Tuesday vs Wednesday" without opening the modal twice.
 *
 * Sizing model: the wrapping flex column is `h-full min-h-0` so it
 * inherits the viewport-fit height set by `app/results/page.tsx`. The
 * horizontal-scroll rail is `flex-1 min-h-0`, which makes each card
 * fill the available vertical space without ever exceeding the window —
 * the user never has to page-scroll to see the bottom of a card.
 *
 * Click handling is single-step: clicking anywhere on a card opens the
 * existing `DayPlanner` modal for that day. No focus / two-step.
 *
 * Days are derived from the trip's date span (first city arrival →
 * last city departure). `dateToCity` maps each ISO date to the city
 * occupying it, mirroring `CalendarView`'s logic so a city occupies
 * arrival up to (but not including) departure — the departure day
 * belongs to the outbound flight, not the city you're leaving.
 */
type ScheduleViewProps = {
  trip: Trip;
};

export default function ScheduleView({ trip }: ScheduleViewProps) {
  // ISO date of the day whose DayPlanner modal is currently open. Null = no
  // modal. Single click on any card sets it.
  const [editorDate, setEditorDate] = useState<string | null>(null);

  // Filter out cities with bad/missing dates so a half-built trip doesn't
  // crash the render. Same defensive pattern as CalendarView.
  const datedCities = trip.cities.filter(
    (c) =>
      c.dates.arrival &&
      c.dates.departure &&
      c.dates.arrival.includes('-') &&
      c.dates.departure.includes('-'),
  );

  // Memoised because the card list is keyed off this; recomputing on
  // every editor open/close would re-mount each card and reset its
  // internal scroll position.
  //
  // `travelByDate` flags days the user is actively on the move so the
  // card header can render a flight/train icon. Departure takes
  // precedence over arrival when both fall on the same day (transit
  // days where you fly out of city A and into city B) — the outbound
  // mode is the more salient travel event for that morning.
  const { isoDates, dateToCity, travelByDate } = useMemo(() => {
    if (datedCities.length === 0) {
      return {
        isoDates: [] as string[],
        dateToCity: new Map<string, { city: City; index: number }>(),
        travelByDate: new Map<string, TransportMode>(),
      };
    }
    const start = parseLocal(datedCities[0].dates.arrival);
    const end = parseLocal(datedCities[datedCities.length - 1].dates.departure);
    const map = new Map<string, { city: City; index: number }>();
    trip.cities.forEach((city, index) => {
      if (
        !city.dates.arrival ||
        !city.dates.departure ||
        !city.dates.arrival.includes('-') ||
        !city.dates.departure.includes('-')
      ) {
        return;
      }
      const arr = parseLocal(city.dates.arrival);
      const dep = parseLocal(city.dates.departure);
      const days = daysBetween(arr, dep);
      if (days <= 0 || isNaN(days)) return;
      for (let i = 0; i < days; i++) {
        const d = new Date(arr);
        d.setDate(arr.getDate() + i);
        map.set(toIso(d), { city, index });
      }
    });

    // The fly-home day (last city's departure) is intentionally not
    // mapped above — a city occupies arrival up to (but not including)
    // departure. For the schedule view we want that day's card to render
    // events under the last city's banner (the user starts the morning
    // in that city before flying home), so attribute it explicitly.
    const lastIdx = trip.cities.length - 1;
    const lastCity = trip.cities[lastIdx];
    if (
      lastCity?.dates?.departure &&
      lastCity.dates.departure.includes('-') &&
      !map.has(lastCity.dates.departure)
    ) {
      map.set(lastCity.dates.departure, { city: lastCity, index: lastIdx });
    }

    // Walk the span inclusive of both ends — the final departure day is
    // a "travel day" with no city mapping, but the user still wants to
    // see it as a card (their fly-home is on it).
    const totalDays = daysBetween(start, end) + 1;
    const dates: string[] = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      dates.push(toIso(d));
    }

    // Build the travel-mode map. Pass once over cities, marking each
    // arrival and departure date with the relevant transport mode.
    // Departure overwrites arrival on transit days.
    const travel = new Map<string, TransportMode>();
    trip.cities.forEach((city) => {
      if (city.dates.arrival && city.transportIn?.mode) {
        travel.set(city.dates.arrival, city.transportIn.mode);
      }
    });
    trip.cities.forEach((city) => {
      if (city.dates.departure && city.transportOut?.mode) {
        travel.set(city.dates.departure, city.transportOut.mode);
      }
    });

    return { isoDates: dates, dateToCity: map, travelByDate: travel };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip]);

  // Eager-build the default schedule for every trip day on mount. Without
  // this, cards for days the user has never opened in the modal render
  // empty — the existing DayPlanner-only build runs lazily per-day on
  // modal open. Pure compute (no API), so populating the whole trip up
  // front costs ~ms and leaves all cards immediately useful.
  //
  // The dependency on `trip` (rather than just `isoDates`) means swapping
  // to a different trip object will re-trigger the build for the new
  // trip's days. The skip-if-already-populated check inside the loop
  // makes re-runs idempotent.
  const setDaySchedule = useTripStore((s) => s.setDaySchedule);
  useEffect(() => {
    isoDates.forEach((iso) => {
      const match = dateToCity.get(iso);
      if (!match) return; // travel-only day with no city mapping
      const existing = match.city.schedule?.[iso];
      if (existing && existing.length > 0) return; // user already has events here
      const events = buildDefaultSchedule(match.city, iso, trip, match.index);
      if (events.length > 0) {
        setDaySchedule(match.index, iso, events);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, isoDates]);

  if (isoDates.length === 0) {
    return (
      <div className="px-8 py-20 text-center text-gray-400 text-sm">
        No dates available yet — add dates to your cities to see the schedule view.
      </div>
    );
  }

  // Resolve the city + cityIndex for the open modal. Travel-only days
  // (no city mapping) can't open the editor because DayPlanner needs a
  // city for its header / colour theme.
  const editorCity =
    editorDate && dateToCity.get(editorDate)
      ? dateToCity.get(editorDate)!
      : null;

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* Horizontal scroll rail. flex-1 + min-h-0 is the chain that lets
          each card fill the remaining vertical space without exceeding
          the viewport. scroll-snap so cards snap into view rather than
          stranding the user mid-card on a flick scroll. */}
      <div
        className="flex-1 min-h-0 flex gap-4 overflow-x-auto no-scrollbar px-8 py-4"
        style={{ scrollSnapType: 'x mandatory' }}
      >
        {isoDates.map((iso) => {
          const match = dateToCity.get(iso);
          const city = match?.city ?? null;
          const cityIndex = match?.index ?? null;
          // Pull the day's events live from the trip object — focusing on
          // a card mustn't read stale data, and the parent re-renders any
          // time the trip mutates (Zustand subscription up the tree).
          const events = city?.schedule?.[iso] ?? [];
          return (
            <DayCard
              key={iso}
              date={iso}
              city={city}
              cityIndex={cityIndex}
              events={events}
              travelMode={travelByDate.get(iso) ?? null}
              onOpenEditor={() => setEditorDate(iso)}
            />
          );
        })}
      </div>

      <div className="flex-shrink-0 px-8 pb-2 text-gray-400 text-[12px] text-center">
        {isoDates.length} {isoDates.length === 1 ? 'day' : 'days'} · scroll horizontally to walk the trip · click a day to edit
      </div>

      {/* DayPlanner modal — same component the month grid view uses, so
          editing semantics are identical regardless of how the user got
          here. */}
      <AnimatePresence>
        {editorDate && editorCity && (
          <DayPlanner
            trip={trip}
            date={editorDate}
            city={editorCity.city}
            cityIndex={editorCity.index}
            onClose={() => setEditorDate(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
