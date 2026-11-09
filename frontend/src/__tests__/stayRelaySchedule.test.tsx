/**
 * The Schedule tab itself, on a stay the planner left days empty in (found
 * live: a 6-night Florence stay whose picks ran out after 3 days showed the
 * same stops on Dec 14 and Dec 15), and on a swapped trip.
 */
import './mocks';
import React from 'react';
import { render } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import ScheduleView from '@/components/results/ScheduleView';
import { buildCityScheduleFromSuggestions } from '@/lib/dayScheduleDefaults';
import type { City, ScheduledEvent, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

const none: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };
const cityOf = (name: string, arrival: string, departure: string, extra: Partial<City> = {}): City =>
  ({ name, country: 'Italy', dates: { arrival, departure }, transportIn: none, transportOut: none,
     hotel: { name: '', rating: 0, pricePerNight: 0, area: '' }, hotels: [], selectedHotelIndex: 0,
     activities: [], restaurants: [], vibes: [], ...extra }) as City;
const acts: ActivitySuggestion[] = ['Uffizi', 'Duomo', 'Pitti', 'Boboli'].map((name, i) => ({
  name, category: 'landmark', timeOfDay: i % 2 ? 'afternoon' : 'morning', durationHours: 1.5, reason: '',
  lat: 43.77 + i / 100, lng: 11.25 + i / 100, placeId: 'p' + i,
}));

function onStore(trip: Trip) {
  useTripStore.setState({ currentTrip: trip });
  function Live() {
    const t = useTripStore((s) => s.currentTrip);
    return t ? <ScheduleView trip={t} /> : null;
  }
  return render(<Live />);
}
const stops = (events: ScheduledEvent[] | undefined) => (events ?? []).filter((e) => e.category !== 'transport').map((e) => e.title);

it("days the planner left empty stay empty — the city's stops are not repeated on them", () => {
  const base = cityOf('Florence', '2026-12-10', '2026-12-16', { activities: acts.map((a) => a.name) });
  const trip0: Trip = { ...buildTrip(), cities: [base], origin: undefined };
  const { schedule } = buildCityScheduleFromSuggestions(acts, [], base, 0, trip0);
  // The planner placed 4 stops on the first days and left the rest unkeyed.
  const planned = Object.keys(schedule).filter((d) => stops(schedule[d]).length > 0);
  expect(planned.length).toBeLessThan(6);
  onStore({ ...trip0, cities: [{ ...base, schedule }] });

  const s = useTripStore.getState().currentTrip!.cities[0].schedule!;
  for (let d = 10; d <= 16; d++) expect(s[`2026-12-${d}`]).toBeDefined();
  const all = Object.values(s).flatMap(stops);
  expect(new Set(all).size).toBe(all.length);
  expect(all.sort()).toEqual(acts.map((a) => a.name).sort());
});

it('a swapped city is re-planned on the tab: located, no repeats', () => {
  const rome = cityOf('Rome', '2026-12-08', '2026-12-11', { activities: acts.map((a) => a.name) });
  const pisa = cityOf('Pisa', '2026-12-11', '2026-12-13');
  const before: Trip = { ...buildTrip(), cities: [pisa, { ...rome, dates: { arrival: '2026-12-10', departure: '2026-12-13' } }], origin: undefined };
  const { schedule } = buildCityScheduleFromSuggestions(acts, [], before.cities[1], 1, before);
  // Swapped: Rome first on new dates, carrying the schedule keyed by its old ones.
  onStore({ ...before, cities: [{ ...rome, schedule }, { ...pisa }] });
  const s = useTripStore.getState().currentTrip!.cities[0].schedule!;
  const all = Object.entries(s).filter(([d]) => d < '2026-12-11').flatMap(([, e]) => e.filter((x) => x.category !== 'transport'));
  expect(all.length).toBe(4);
  expect(all.every((e) => typeof e.lat === 'number')).toBe(true);
  expect(new Set(all.map((e) => e.title)).size).toBe(4);
  expect(Object.keys(s).some((d) => d >= '2026-12-12')).toBe(false);
});
