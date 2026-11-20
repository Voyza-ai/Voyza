/**
 * A stay whose dates moved (cities swapped in Canvas) is re-planned by the
 * stay relay, and the traveller's own blocks on the lost days are moved onto
 * the new ones. A stop the traveller had resized counted as both: re-planned
 * by the relay AND moved as their own block, so it came out twice (the
 * Colosseum at 09:00 in the new plan and at 06:45 the next morning).
 * The same happened to every stop of a trip saved before stops kept their
 * planned length, piled onto one day from 00:15.
 */
import { buildCityScheduleFromSuggestions } from '@/lib/dayScheduleDefaults';
import { syncCitySchedule } from '@/lib/scheduleSync';
import type { City, ScheduledEvent, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

const none: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };
const cityOf = (name: string, arrival: string, departure: string, extra: Partial<City> = {}): City =>
  ({
    name,
    country: 'Italy',
    dates: { arrival, departure },
    transportIn: none,
    transportOut: none,
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    hotels: [],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
    ...extra,
  }) as City;

const acts: ActivitySuggestion[] = [
  { name: 'Colosseum', category: 'landmark', timeOfDay: 'morning', durationHours: 2, reason: '' },
  { name: 'Vatican Museums', category: 'museum', timeOfDay: 'morning', durationHours: 2, reason: '' },
  { name: "St. Peter's dome", category: 'landmark', timeOfDay: 'afternoon', durationHours: 2, reason: '' },
  { name: 'Trastevere walk', category: 'experience', timeOfDay: 'evening', durationHours: 1.5, reason: '' },
];
const meals: RestaurantSuggestion[] = [
  { name: 'Roscioli', cuisine: 'Roman', priceRange: '$$', mealType: 'lunch', reason: '' },
  { name: 'Flavio', cuisine: 'Roman', priceRange: '$$', mealType: 'dinner', reason: '' },
];
const ALL = [...acts.map((a) => a.name), ...meals.map((m) => m.name)].sort();

/** Florence (Dec 8–11) → Rome (Dec 11–13), Rome planned by the real scheduler. */
function planned(): { trip: Trip; rome: City } {
  const florence = cityOf('Florence', '2026-12-08', '2026-12-11');
  const rome = cityOf('Rome', '2026-12-11', '2026-12-13', {
    activities: acts.map((a) => a.name),
    restaurants: meals.map((m) => ({ name: m.name, cuisine: m.cuisine, priceRange: m.priceRange })),
  });
  const trip: Trip = { ...buildTrip(), cities: [florence, rome], origin: undefined };
  const { schedule } = buildCityScheduleFromSuggestions(acts, meals, rome, 1, trip);
  return { trip, rome: { ...rome, schedule } };
}

/** The Canvas swap: Rome first on Dec 8–10, Florence after. */
function swapped(trip: Trip, rome: City): Trip {
  return {
    ...trip,
    cities: [
      { ...rome, dates: { arrival: '2026-12-08', departure: '2026-12-10' } },
      { ...trip.cities[0], dates: { arrival: '2026-12-10', departure: '2026-12-13' } },
    ],
  };
}

const stops = (schedule: Record<string, ScheduledEvent[]>) =>
  Object.values(schedule)
    .flat()
    .filter((e) => e.category === 'activity' || e.category === 'restaurant')
    .map((e) => e.title.replace(/ \(.*\)$/, ''));

const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3);

describe('a moved stay places each stop once', () => {
  it('a stop the traveller resized is not also moved as their own block', () => {
    const { trip, rome } = planned();
    const day = rome.schedule!['2026-12-11'];
    const colosseum = day.find((e) => e.title === 'Colosseum')!;
    // Stretched by half an hour: no longer the planner's placement, so the
    // sync counts it as the traveller's own block.
    const resized = { ...colosseum, endTime: '11:30' };
    expect(colosseum.endTime).toBe('11:00');
    const schedule = { ...rome.schedule!, '2026-12-11': day.map((e) => (e === colosseum ? resized : e)) };
    const out = syncCitySchedule(swapped(trip, { ...rome, schedule }), 0)!;
    expect(stops(out.schedule).sort()).toEqual(ALL);
    // Re-planned at the length the traveller gave it.
    const moved = Object.values(out.schedule).flat().find((e) => e.title === 'Colosseum')!;
    expect(toMin(moved.endTime) - toMin(moved.startTime)).toBe(150);
  });

  it('a trip saved before stops kept their planned length is re-planned once, in waking hours', () => {
    const { trip, rome } = planned();
    const legacy: Record<string, ScheduledEvent[]> = {};
    for (const [d, events] of Object.entries(rome.schedule!)) {
      legacy[d] = events.map(({ plannedDurationMin: _drop, ...e }) => e as ScheduledEvent);
    }
    const out = syncCitySchedule(swapped(trip, { ...rome, schedule: legacy }), 0)!;
    expect(stops(out.schedule).sort()).toEqual(ALL);
    for (const e of Object.values(out.schedule).flat()) {
      if (e.category !== 'transport') expect(toMin(e.startTime)).toBeGreaterThanOrEqual(6 * 60);
    }
  });

  it('a block the traveller added by hand still moves onto the stay', () => {
    const { trip, rome } = planned();
    const mine: ScheduledEvent = { id: 'mine', title: 'Call home', startTime: '07:00', endTime: '07:30', category: 'custom' };
    const schedule = { ...rome.schedule!, '2026-12-12': [...rome.schedule!['2026-12-12'], mine] };
    const out = syncCitySchedule(swapped(trip, { ...rome, schedule }), 0)!;
    const found = Object.values(out.schedule).flat().filter((e) => e.title === 'Call home');
    expect(found).toHaveLength(1);
    expect(stops(out.schedule).sort()).toEqual(ALL);
  });
});
