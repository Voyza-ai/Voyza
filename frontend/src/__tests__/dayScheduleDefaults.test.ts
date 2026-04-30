import {
  buildDayTransportContext,
  buildDefaultSchedule,
} from '@/lib/dayScheduleDefaults';
import type { Trip, City, Transport, HomeLeg } from '@/lib/types';
import { buildTrip } from './fixtures';

/**
 * Tests for the shared day-schedule builder. Covers the two exported
 * functions:
 *   - `buildDayTransportContext` — given a city + date + trip, returns the
 *     transport events that belong on that day plus the window in which
 *     activities/restaurants can be scheduled.
 *   - `buildDefaultSchedule` — calls the above, then layers activities +
 *     restaurants from the city's curated lists into the available window.
 *
 * The fixtures below construct minimally-typed trips for each scenario.
 * `buildTrip` from ./fixtures has the heavy default data (hotels, vibes,
 * etc.); we override only the fields each test cares about.
 */

const emptyTransport: Transport = {
  mode: 'flight',
  operator: '',
  duration: '',
  price: 0,
};

const trenitaliaInbound: Transport = {
  mode: 'train',
  operator: 'Trenitalia',
  duration: '1h 32m',
  price: 35,
  departTime: '08:00',
  arriveTime: '09:32',
  departDate: '2026-06-18',
  fromStation: 'Roma Termini, Platform 12',
  toStation: 'Firenze S.M.N., Platform 5',
};

const ryanairOutbound: Transport = {
  mode: 'flight',
  operator: 'Ryanair',
  duration: '2h 15m',
  price: 89,
  departTime: '09:15',
  arriveTime: '11:30',
  departDate: '2026-06-20',
  fromStation: 'FLR Terminal 1',
  toStation: 'BCN Terminal 2',
};

const homeOutboundSameDay: HomeLeg = {
  originAirport: 'EWR',
  destAirport: 'FCO',
  price: 450,
  currency: 'USD',
  durationMinutes: 480,
  operator: 'United',
  carrierCode: 'UA',
  departTime: '08:00',
  arriveTime: '20:00',
  departDate: '2026-06-15',
  stops: 0,
  bookingUrl: null,
};

const homeOutboundOvernight: HomeLeg = {
  ...homeOutboundSameDay,
  // Departed June 14, arrives June 15 — typical transatlantic red-eye.
  departTime: '21:00',
  arriveTime: '11:00',
  departDate: '2026-06-14',
};

const homeReturn: HomeLeg = {
  originAirport: 'BCN',
  destAirport: 'EWR',
  price: 480,
  currency: 'USD',
  durationMinutes: 540,
  operator: 'United',
  carrierCode: 'UA',
  departTime: '14:00',
  arriveTime: '17:00',
  departDate: '2026-06-20',
  stops: 0,
  bookingUrl: null,
};

/**
 * Build a trip with N cities matching the provided `dates` array. All
 * other fields are minimal placeholders. Each city's transportIn /
 * transportOut defaults to `emptyTransport` so the home-anchor logic
 * is what surfaces in tests — override per case where needed.
 */
function buildMultiCityTrip(
  cities: Array<Partial<City> & { name: string; dates: City['dates'] }>,
  origin?: Trip['origin'],
): Trip {
  const baseTrip = buildTrip();
  return {
    ...baseTrip,
    cities: cities.map((c) => ({
      country: 'Italy',
      transportIn: emptyTransport,
      transportOut: emptyTransport,
      hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
      hotels: [],
      selectedHotelIndex: 0,
      activities: [],
      restaurants: [],
      vibes: [],
      ...c,
    })) as City[],
    origin,
  };
}

/* -------------------------------- buildDayTransportContext -------------------------------- */

describe('buildDayTransportContext', () => {
  it('arrival day for inter-city leg builds 3 blocks and clamps activity window', () => {
    const trip = buildMultiCityTrip([
      { name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' } },
      {
        name: 'Florence',
        dates: { arrival: '2026-06-18', departure: '2026-06-20' },
        transportIn: trenitaliaInbound,
      },
    ]);

    const ctx = buildDayTransportContext(trip.cities[1], '2026-06-18', trip, 1);

    // Three transport blocks: head-to, train, arrive-at — sorted by start.
    expect(ctx.events.map((e) => e.title)).toEqual([
      'Head to Roma Termini',
      'Train Roma Termini → Firenze S.M.N.',
      'Arrive at Firenze S.M.N.',
    ]);
    // 30-min train buffer → head-to runs 07:30 to 08:00.
    expect(ctx.events[0].startTime).toBe('07:30');
    expect(ctx.events[0].endTime).toBe('08:00');
    // Window: arriveTime (09:32) + 60 min cushion = 10:32.
    expect(ctx.windowStart).toBe(10 * 60 + 32);
    // No outbound on this day → window end stays open.
    expect(ctx.windowEnd).toBe(24 * 60);
  });

  it('departure day for inter-city leg builds 2 blocks and clamps activity window', () => {
    const trip = buildMultiCityTrip([
      {
        name: 'Florence',
        dates: { arrival: '2026-06-18', departure: '2026-06-20' },
        transportOut: ryanairOutbound,
      },
      { name: 'Barcelona', dates: { arrival: '2026-06-20', departure: '2026-06-22' } },
    ]);

    const ctx = buildDayTransportContext(trip.cities[0], '2026-06-20', trip, 0);

    expect(ctx.events.map((e) => e.title)).toEqual([
      'Head to FLR Terminal 1',
      'Flight FLR Terminal 1 → BCN Terminal 2',
    ]);
    // 120-min flight buffer → head-to runs 07:15 to 09:15.
    expect(ctx.events[0].startTime).toBe('07:15');
    expect(ctx.events[0].endTime).toBe('09:15');
    // Window end is the head-to start time (07:15) — no activities once
    // the user has left for the airport.
    expect(ctx.windowEnd).toBe(7 * 60 + 15);
    expect(ctx.windowStart).toBe(0);
  });

  it('first city pulls from trip.origin.outboundLeg when transportIn is empty', () => {
    const trip = buildMultiCityTrip(
      [
        { name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' } },
      ],
      {
        city: 'New York',
        airports: ['EWR'],
        outboundLeg: homeOutboundSameDay,
        returnLeg: null,
      },
    );

    const ctx = buildDayTransportContext(trip.cities[0], '2026-06-15', trip, 0);

    // Same-day home outbound → all 3 blocks render (head-to + flight + arrive-at).
    expect(ctx.events).toHaveLength(3);
    expect(ctx.events[0].title).toBe('Head to EWR');
    expect(ctx.events[1].title).toBe('Flight EWR → FCO');
    expect(ctx.events[2].title).toBe('Arrive at FCO');
    // 120-min flight buffer → head-to at 06:00 (08:00 - 2h).
    expect(ctx.events[0].startTime).toBe('06:00');
    // Window: arrive at 20:00 + 60 cushion = 21:00.
    expect(ctx.windowStart).toBe(21 * 60);
  });

  it('first city with overnight home outbound only renders the arrive marker on the arrival day', () => {
    const trip = buildMultiCityTrip(
      [{ name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' } }],
      {
        city: 'New York',
        airports: ['EWR'],
        outboundLeg: homeOutboundOvernight, // departDate 2026-06-14
        returnLeg: null,
      },
    );

    const ctx = buildDayTransportContext(trip.cities[0], '2026-06-15', trip, 0);

    // Head-to + flight belong on June 14 (the home card day, Phase 2).
    // June 15 only sees the "Arrive at" marker.
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0].title).toBe('Arrive at FCO');
    expect(ctx.events[0].startTime).toBe('11:00');
    expect(ctx.windowStart).toBe(12 * 60); // 11:00 + 60.
  });

  it('first city with no home anchor and no transportIn produces no blocks', () => {
    const trip = buildMultiCityTrip([
      { name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' } },
    ]);
    const ctx = buildDayTransportContext(trip.cities[0], '2026-06-15', trip, 0);
    expect(ctx.events).toHaveLength(0);
    expect(ctx.windowStart).toBe(0);
    expect(ctx.windowEnd).toBe(24 * 60);
  });

  it('last city pulls from trip.origin.returnLeg when transportOut is empty', () => {
    const trip = buildMultiCityTrip(
      [
        { name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' } },
        { name: 'Barcelona', dates: { arrival: '2026-06-18', departure: '2026-06-20' } },
      ],
      {
        city: 'New York',
        airports: ['EWR'],
        outboundLeg: null,
        returnLeg: homeReturn,
      },
    );

    const ctx = buildDayTransportContext(trip.cities[1], '2026-06-20', trip, 1);

    expect(ctx.events.map((e) => e.title)).toEqual([
      'Head to BCN',
      'Flight BCN → EWR',
    ]);
    // 120-min flight buffer → head-to runs 12:00 to 14:00.
    expect(ctx.events[0].startTime).toBe('12:00');
    expect(ctx.windowEnd).toBe(12 * 60); // head-to start.
    expect(ctx.windowStart).toBe(0);
  });

  it('pure stay day (neither arrival nor departure) produces no transport blocks', () => {
    const trip = buildMultiCityTrip([
      { name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' } },
    ]);
    const ctx = buildDayTransportContext(trip.cities[0], '2026-06-16', trip, 0);
    expect(ctx.events).toHaveLength(0);
    expect(ctx.windowStart).toBe(0);
    expect(ctx.windowEnd).toBe(24 * 60);
  });

  it('one-city trip whose single day is both arrival and last-city departure renders both directions', () => {
    // Edge: a same-day day-trip where cityIndex === 0 === lastIndex. Both
    // home outbound and home return apply on different dates.
    const trip = buildMultiCityTrip(
      [
        {
          name: 'Reykjavik',
          dates: { arrival: '2026-06-15', departure: '2026-06-20' },
        },
      ],
      {
        city: 'New York',
        airports: ['EWR'],
        outboundLeg: homeOutboundSameDay, // departDate 2026-06-15
        returnLeg: { ...homeReturn, departDate: '2026-06-20' },
      },
    );

    // Arrival day: inbound blocks only.
    const arr = buildDayTransportContext(trip.cities[0], '2026-06-15', trip, 0);
    expect(arr.events.map((e) => e.title)).toEqual([
      'Head to EWR',
      'Flight EWR → FCO',
      'Arrive at FCO',
    ]);

    // Departure day: outbound blocks only.
    const dep = buildDayTransportContext(trip.cities[0], '2026-06-20', trip, 0);
    expect(dep.events.map((e) => e.title)).toEqual([
      'Head to BCN',
      'Flight BCN → EWR',
    ]);
  });
});

/* -------------------------------- buildDefaultSchedule -------------------------------- */

describe('buildDefaultSchedule', () => {
  it('places activities and restaurants on a pure stay day', () => {
    const trip = buildMultiCityTrip([
      {
        name: 'Rome',
        dates: { arrival: '2026-06-15', departure: '2026-06-18' },
        activities: ['Colosseum tour', 'Vatican Museums'],
        restaurants: [
          { name: 'Trattoria Da Enzo', cuisine: 'Roman', priceRange: '$$' },
          { name: 'Roscioli', cuisine: 'Roman', priceRange: '$$$' },
        ],
      },
    ]);

    const events = buildDefaultSchedule(trip.cities[0], '2026-06-16', trip, 0);
    const titles = events.map((e) => e.title);

    expect(titles).toContain('Colosseum tour');
    expect(titles).toContain('Vatican Museums');
    expect(titles).toContain('Trattoria Da Enzo');
    expect(titles).toContain('Roscioli');
    // No transport on a pure stay day.
    expect(events.filter((e) => e.category === 'transport')).toHaveLength(0);
  });

  it('skips activities and restaurants when arrival lands too late for the day', () => {
    // 23:00 arrival → window starts at 24:00 (clamped to end of day) →
    // no room for any activity slot.
    const lateInbound: Transport = {
      ...trenitaliaInbound,
      departTime: '21:30',
      arriveTime: '23:00',
    };
    const trip = buildMultiCityTrip([
      { name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' } },
      {
        name: 'Florence',
        dates: { arrival: '2026-06-18', departure: '2026-06-20' },
        transportIn: lateInbound,
        activities: ['Uffizi Gallery'],
        restaurants: [{ name: 'Mercato Centrale', cuisine: 'Tuscan', priceRange: '$$' }],
      },
    ]);

    const events = buildDefaultSchedule(trip.cities[1], '2026-06-18', trip, 1);
    // Transport blocks render.
    expect(events.filter((e) => e.category === 'transport').length).toBeGreaterThan(0);
    // No activities or restaurants — window is too tight.
    expect(events.filter((e) => e.category === 'activity')).toHaveLength(0);
    expect(events.filter((e) => e.category === 'restaurant')).toHaveLength(0);
  });

  it('skips dinner restaurant when departure is before dinner-time', () => {
    // 17:00 flight → 2h buffer → must leave by 15:00 → dinner at 19:30
    // doesn't fit the activity window.
    const earlyOutbound: Transport = {
      ...ryanairOutbound,
      departTime: '17:00',
      arriveTime: '19:15',
    };
    const trip = buildMultiCityTrip([
      {
        name: 'Florence',
        dates: { arrival: '2026-06-18', departure: '2026-06-20' },
        transportOut: earlyOutbound,
        activities: [],
        restaurants: [
          { name: 'Mercato Lunch', cuisine: 'Tuscan', priceRange: '$' },
          { name: 'Late Dinner Spot', cuisine: 'Tuscan', priceRange: '$$' },
        ],
      },
      { name: 'Barcelona', dates: { arrival: '2026-06-20', departure: '2026-06-22' } },
    ]);

    const events = buildDefaultSchedule(trip.cities[0], '2026-06-20', trip, 0);
    const titles = events.map((e) => e.title);
    // Lunch (12:30) fits before the 15:00 window end. Dinner (19:30) does not.
    expect(titles).toContain('Mercato Lunch');
    expect(titles).not.toContain('Late Dinner Spot');
  });

  it('events are sorted by start time', () => {
    const trip = buildMultiCityTrip([
      {
        name: 'Rome',
        dates: { arrival: '2026-06-15', departure: '2026-06-18' },
        activities: ['Colosseum'],
        restaurants: [
          { name: 'Lunch spot', cuisine: 'Roman', priceRange: '$$' },
        ],
      },
    ]);
    const events = buildDefaultSchedule(trip.cities[0], '2026-06-16', trip, 0);
    const starts = events.map((e) => e.startTime);
    const sorted = [...starts].sort();
    expect(starts).toEqual(sorted);
  });
});
