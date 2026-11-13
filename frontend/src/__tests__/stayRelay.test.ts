/**
 * A city whose dates moved (cities swapped in Canvas) is re-planned with the
 * located, stay-wide scheduler: its stops keep their coordinates (so the
 * Schedule tab's dashed travel lines still draw), are spread across the new
 * days rather than repeated on each, and the old dates are dropped.
 */
import { buildCityScheduleFromSuggestions } from '@/lib/dayScheduleDefaults';
import { relayMovedStay } from '@/lib/stayRelay';
import { dayConnectors } from '@/components/results/TravelConnectors';
import type { City, Transport, Trip } from '@/lib/types';
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

// Real Rome coordinates.
const at = (lat: number, lng: number, id: string) => ({ lat, lng, placeId: id });
const acts: ActivitySuggestion[] = [
  { name: 'Colosseum', category: 'landmark', timeOfDay: 'morning', durationHours: 1.5, reason: '', ...at(41.8902, 12.4922, 'a1') },
  { name: 'Vatican Museums', category: 'museum', timeOfDay: 'morning', durationHours: 1.5, reason: '', ...at(41.9065, 12.4536, 'a2') },
  { name: 'Testaccio food tour', category: 'food', timeOfDay: 'afternoon', durationHours: 1.5, reason: '', ...at(41.8765, 12.4757, 'a3') },
  { name: "St. Peter's dome", category: 'landmark', timeOfDay: 'afternoon', durationHours: 1.5, reason: '', ...at(41.9022, 12.4539, 'a4') },
  { name: 'Trastevere walk', category: 'experience', timeOfDay: 'evening', durationHours: 1.5, reason: '', ...at(41.8897, 12.4697, 'a5') },
  { name: 'Vespa tour', category: 'experience', timeOfDay: 'evening', durationHours: 1.5, reason: '', ...at(41.9009, 12.4833, 'a6') },
];
const meals: RestaurantSuggestion[] = [
  { name: 'Roscioli', cuisine: 'Roman', priceRange: '$$', mealType: 'lunch', reason: '', ...at(41.8938, 12.4733, 'r1') },
  { name: 'Flavio', cuisine: 'Roman', priceRange: '$$', mealType: 'dinner', reason: '', ...at(41.8766, 12.4746, 'r2') },
  { name: 'Pizzarium', cuisine: 'Pizza', priceRange: '$', mealType: 'lunch', reason: '', ...at(41.9073, 12.4473, 'r3') },
  { name: 'Armando', cuisine: 'Roman', priceRange: '$$', mealType: 'dinner', reason: '', ...at(41.8986, 12.4768, 'r4') },
];

/** Florence → Rome, Rome planned on Dec 11–14 with located picks. */
function plannedTrip(): Trip {
  const florence = cityOf('Florence', '2026-12-08', '2026-12-11');
  const rome0 = cityOf('Rome', '2026-12-11', '2026-12-14', {
    activities: acts.map((a) => a.name),
    restaurants: meals.map((m) => ({ name: m.name, cuisine: m.cuisine, priceRange: m.priceRange, lat: m.lat, lng: m.lng, placeId: m.placeId })),
  });
  const base: Trip = { ...buildTrip(), cities: [florence, rome0], origin: undefined };
  const { schedule } = buildCityScheduleFromSuggestions(acts, meals, rome0, 1, base);
  return { ...base, cities: [florence, { ...rome0, schedule }] };
}

/** The Canvas swap: Rome first on Dec 8–11, Florence after; schedules travel with the city. */
function swapped(t: Trip): Trip {
  const [florence, rome] = t.cities;
  return {
    ...t,
    cities: [
      { ...rome, dates: { arrival: '2026-12-08', departure: '2026-12-11' } },
      { ...florence, dates: { arrival: '2026-12-11', departure: '2026-12-14' } },
    ],
  };
}

const located = (e: { lat?: number; lng?: number }) => typeof e.lat === 'number' && typeof e.lng === 'number';

describe('relayMovedStay', () => {
  it('re-plans a swapped city on its new days with coordinates, no repeats, old dates dropped', () => {
    const before = plannedTrip();
    const oldRome = before.cities[1].schedule!;
    expect(Object.keys(oldRome).some((d) => dayConnectors(oldRome[d]).length > 0)).toBe(true);

    const trip = swapped(before);
    const out = relayMovedStay(trip, 0);
    expect(out).not.toBeNull();
    const s = out!.schedule;

    // Every new stay day is keyed; the old Dec 12–14 keys are gone.
    for (const d of ['2026-12-08', '2026-12-09', '2026-12-10']) expect(s[d]).toBeDefined();
    for (const d of ['2026-12-12', '2026-12-13', '2026-12-14']) expect(s[d]).toBeUndefined();

    const stops = Object.values(s).flat().filter((e) => e.category === 'activity' || e.category === 'restaurant');
    // Spread, not repeated: each stop appears once across the stay.
    const titles = stops.map((e) => e.title);
    expect(new Set(titles).size).toBe(titles.length);
    // Every stop placed kept its coordinates…
    expect(stops.length).toBeGreaterThan(4);
    expect(stops.every(located)).toBe(true);
    // …so the dashed travel lines are back on the new days.
    const withLines = Object.values(s).filter((events) => dayConnectors(events).length > 0);
    expect(withLines.length).toBeGreaterThanOrEqual(2);
  });

  it('is a no-op once every stay day has a schedule (no re-plan loop)', () => {
    const trip = swapped(plannedTrip());
    const out = relayMovedStay(trip, 0)!;
    const after: Trip = { ...trip, cities: [{ ...trip.cities[0], ...out }, trip.cities[1]] };
    expect(relayMovedStay(after, 0)).toBeNull();
    // A city that never moved: only the day its planner left empty (Dec 13)
    // is added, and then nothing more.
    const t = plannedTrip();
    const once = relayMovedStay(t, 1)!;
    // (and the fly-home day, Dec 14, which this transport-less fixture never built)
    expect(Object.keys(once.schedule).sort()).toEqual(
      Array.from(new Set([...Object.keys(t.cities[1].schedule!), '2026-12-13', '2026-12-14'])).sort(),
    );
    expect(relayMovedStay({ ...t, cities: [t.cities[0], { ...t.cities[1], ...once }] }, 1)).toBeNull();
  });

  it('re-plans a partly moved stay once, keeping hand-added blocks on days still in it', () => {
    const before = plannedTrip();
    const rome = before.cities[1];
    const mine = { id: 'mine', title: 'Call home', startTime: '07:00', endTime: '07:30', category: 'custom' as const };
    const withMine = { ...rome.schedule!, '2026-12-12': [...rome.schedule!['2026-12-12'], mine] };
    // Rome moves on a day (Dec 12–15): Dec 11's stops are off its stay.
    const shifted: Trip = {
      ...before,
      cities: [
        { ...before.cities[0], dates: { arrival: '2026-12-09', departure: '2026-12-12' } },
        { ...rome, schedule: withMine, dates: { arrival: '2026-12-12', departure: '2026-12-15' } },
      ],
    };
    const out = relayMovedStay(shifted, 1)!;
    expect(out).not.toBeNull();
    expect(out.schedule['2026-12-11']).toBeUndefined();
    expect(out.schedule['2026-12-12'].some((e) => e.id === 'mine')).toBe(true);
    const stops = Object.values(out.schedule).flat().filter((e) => e.category === 'activity' || e.category === 'restaurant');
    const titles = stops.map((e) => e.title);
    expect(new Set(titles).size).toBe(titles.length);
    // Nothing that was planned is lost.
    const planned = Object.values(rome.schedule!).flat().filter((e) => e.category === 'activity' || e.category === 'restaurant');
    expect(titles.length).toBe(planned.length);
    expect(stops.every(located)).toBe(true);
  });

  it('spreads a never-scheduled city across its days instead of repeating the list', () => {
    const c = cityOf('Rome', '2026-12-08', '2026-12-11', { activities: ['A', 'B', 'C', 'D', 'E', 'F'] });
    const trip: Trip = { ...buildTrip(), cities: [c], origin: undefined };
    const out = relayMovedStay(trip, 0)!;
    const titles = Object.values(out.schedule).flat().filter((e) => e.category === 'activity').map((e) => e.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("fills a day the planner left empty with only what isn't placed yet, leaving planned days alone", () => {
    const t = plannedTrip();
    const rome = t.cities[1];
    const gap = { ...rome.schedule! };
    delete gap['2026-12-13'];
    const extra = { ...rome, schedule: gap, activities: [...rome.activities, 'Borghese Gallery'] };
    const trip = { ...t, cities: [t.cities[0], extra] };
    const out = relayMovedStay(trip, 1)!;
    expect(out).not.toBeNull();
    // Planned days are the same objects — not re-planned.
    expect(out.schedule['2026-12-11']).toBe(gap['2026-12-11']);
    expect(out.schedule['2026-12-12']).toBe(gap['2026-12-12']);
    // The empty day gets the one stop nothing placed, not the whole list again.
    const filled = out.schedule['2026-12-13'].filter((e) => e.category !== 'transport').map((e) => e.title);
    expect(filled).toEqual(['Borghese Gallery']);
    // And it doesn't fire again.
    expect(relayMovedStay({ ...trip, cities: [t.cities[0], { ...extra, ...out }] }, 1)).toBeNull();
  });

  it('an empty day with nothing left over stays empty instead of repeating stops', () => {
    const t = plannedTrip();
    const rome = t.cities[1];
    const gap = { ...rome.schedule! };
    delete gap['2026-12-13'];
    const out = relayMovedStay({ ...t, cities: [t.cities[0], { ...rome, schedule: gap }] }, 1)!;
    expect(out.schedule['2026-12-13'].filter((e) => e.category !== 'transport')).toEqual([]);
  });

  it('leaves a city with nothing to place alone', () => {
    const c = cityOf('Rome', '2026-12-08', '2026-12-11');
    expect(relayMovedStay({ ...buildTrip(), cities: [c], origin: undefined }, 0)).toBeNull();
  });
});
