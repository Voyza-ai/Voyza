/**
 * Overnight flights in the day planner (B1).
 *
 * Production, 2026-10-29: JFK 19:25 Dec 8 → Paris 12:00 Dec 9. The flight
 * block renders as "19:25–12:00", and `mergeRanges` dropped any block whose
 * end is before its start — so the planner treated the flight as free time
 * and put a 3-hour "evening" activity at 19:40, after the traveller had
 * boarded. A block that wraps midnight occupies the rest of THIS day.
 *
 * The other half of B1 is the backend: the first stay now starts on the
 * landing date (HomeLeg.arriveDate), so a correct trip has no Paris day on
 * Dec 8 at all. The last test pins what this scheduler does with that.
 */

import { buildCityScheduleFromSuggestions, planDay } from '@/lib/dayScheduleDefaults';
import type { City, HomeLeg, ScheduledEvent, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

/** The outbound from the production response (prod_res1.json), as the backend returns it. */
const outbound = (arriveDate?: string): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'PAR',
  price: 445.8,
  currency: 'USD',
  durationMinutes: 635,
  operator: 'Icelandair',
  carrierCode: 'FI',
  departTime: '19:25',
  arriveTime: '12:00',
  departDate: '2026-12-08',
  ...(arriveDate ? { arriveDate } : {}),
  stops: 1,
  bookingUrl: null,
});

function paris(arrival: string): City {
  return {
    name: 'Paris',
    country: 'France',
    dates: { arrival, departure: '2026-12-12' },
    transportIn: emptyTransport,
    transportOut: emptyTransport,
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    hotels: [],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
  } as City;
}

function tripWith(city: City, leg: HomeLeg): Trip {
  // Two cities, so Paris is NOT the last one (no return-leg day of its own).
  const rome = { ...city, name: 'Rome', dates: { arrival: '2026-12-12', departure: '2026-12-15' } };
  return {
    ...buildTrip(),
    cities: [city, rome],
    origin: { city: 'New York', airports: ['JFK'], outboundLeg: leg, returnLeg: null },
  };
}

// The same suggestions the audit harness fed the real scheduler.
const acts: ActivitySuggestion[] = [
  { name: 'Louvre', timeOfDay: 'morning', durationHours: 3, category: 'museum', reason: '' } as ActivitySuggestion,
  { name: 'Marais walk', timeOfDay: 'afternoon', durationHours: 2, category: 'experience', reason: '' } as ActivitySuggestion,
  { name: 'Seine cruise', timeOfDay: 'evening', durationHours: 2, category: 'nightlife', reason: '' } as ActivitySuggestion,
];
const rests: RestaurantSuggestion[] = [
  { name: 'Cafe A', cuisine: 'French', priceRange: '$$', mealType: 'breakfast', reason: '' } as RestaurantSuggestion,
  { name: 'Bistro B', cuisine: 'French', priceRange: '$$', mealType: 'lunch', reason: '' } as RestaurantSuggestion,
  { name: 'Brasserie C', cuisine: 'French', priceRange: '$$', mealType: 'dinner', reason: '' } as RestaurantSuggestion,
];

const nonTransport = (events: ScheduledEvent[] = []) => events.filter((e) => e.category !== 'transport');

describe('planDay — a block that wraps midnight', () => {
  it('occupies the rest of the day instead of vanishing', () => {
    const plan = planDay({
      dayStart: 8 * 60,
      dayEnd: 23 * 60 + 30,
      // Flight 19:25 → 12:00 (next day).
      busyRanges: [[19 * 60 + 25, 12 * 60]],
      sequence: [{ key: 'evening', durationMin: 120, earliestStart: 19 * 60 + 30, latestEnd: 23 * 60 + 30 }],
      flexible: [],
    });

    // Before: placed 19:40–21:40, on the plane.
    expect(plan.placements).toEqual([]);
    expect(plan.dropped.map((d) => d.key)).toEqual(['evening']);
  });

  it('still lets the day before departure be used', () => {
    const plan = planDay({
      dayStart: 8 * 60,
      dayEnd: 23 * 60 + 30,
      busyRanges: [[19 * 60 + 25, 12 * 60]],
      sequence: [{ key: 'morning', durationMin: 120, earliestStart: 9 * 60, latestEnd: 23 * 60 + 30 }],
      flexible: [],
    });
    expect(plan.placements).toEqual([
      { key: 'morning', startMin: 9 * 60, endMin: 11 * 60, durationMin: 120 },
    ]);
  });
});

describe('overnight outbound — the schedule the traveller actually gets', () => {
  it('legacy trip (arrival = departure day): nothing is planned after boarding', () => {
    // What production returned before the backend fix: Paris arrival Dec 8.
    const city = paris('2026-12-08');
    const { schedule } = buildCityScheduleFromSuggestions(acts, rests, city, 0, tripWith(city, outbound()));

    const dec8 = schedule['2026-12-08'] ?? [];
    for (const e of nonTransport(dec8)) {
      // Before: "Seine cruise 19:40–21:40" (and similar) on Dec 8.
      expect(toMin(e.startTime)).toBeLessThan(19 * 60 + 25);
    }
  });

  it('fixed trip (arrival = landing date): no Paris plans on Dec 8, arrival at 12:00 on Dec 9', () => {
    const city = paris('2026-12-09');
    const { schedule } = buildCityScheduleFromSuggestions(
      acts,
      rests,
      city,
      0,
      tripWith(city, outbound('2026-12-09')),
    );

    // Dec 8 is the home departure day (F2): the head-to and the flight, and
    // nothing in Paris. (B1 had no Dec 8 at all, which lost the departure.)
    expect(schedule['2026-12-08'].map((e) => e.title)).toEqual(['Head to JFK', 'Flight JFK → PAR']);
    expect(nonTransport(schedule['2026-12-08'])).toEqual([]);

    const dec9 = schedule['2026-12-09'];
    expect(dec9.map((e) => e.title)).toContain('Arrive at PAR');
    // The flight itself and "Head to JFK" belong to Dec 8, not here.
    expect(dec9.some((e) => e.title.startsWith('Head to'))).toBe(false);
    for (const e of nonTransport(dec9)) {
      expect(toMin(e.startTime)).toBeGreaterThanOrEqual(13 * 60); // landed + cushion
    }
  });
});
