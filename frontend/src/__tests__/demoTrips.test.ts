import {
  DEMO_TRIPS,
  demoShiftDays,
  demoTripFor,
  demoTripForToday,
  earliestDate,
  shiftDatesDeep,
  type DemoTrip,
} from '@/lib/demoTrips';
import type { Trip } from '@/lib/types';

const trip = {
  title: 'Demo',
  status: 'planning',
  totalCost: 100,
  savings: 0,
  travelers: 2,
  savingsTips: [],
  picksRun: 'picks-1',
  id: 'should-not-survive',
  origin: {
    city: 'New York',
    airports: ['JFK'],
    outboundLeg: {
      departDate: '2026-12-20',
      arriveDate: '2026-12-21',
      bookingUrl: 'https://example.test/?q=Flights%20on%202026-12-20',
    },
  },
  cities: [
    {
      name: 'Prague',
      dates: { arrival: '2026-12-21', departure: '2026-12-23' },
      schedule: { '2026-12-21': [{ id: 'e1', title: 'Arrive', start: '09:00' }] },
      hotels: [{ name: 'Hotel 2026', bookingUrl: 'https://b.test/?checkin=2026-12-21&checkout=2026-12-23' }],
    },
  ],
} as unknown as Trip;

const demo: DemoTrip = {
  slug: 'x',
  title: 'X',
  cities: ['Prague'],
  capturedAt: '2026-11-15',
  trip,
};

describe('demoShiftDays', () => {
  it('keeps dates that are still at least two weeks out', () => {
    expect(demoShiftDays('2026-12-20', '2026-11-15')).toBe(0);
    expect(demoShiftDays('2026-12-20', '2026-12-06')).toBe(0); // exactly 14 days
  });

  it('moves a stale trip by whole weeks, to four or more weeks out', () => {
    // 13 days out → +21 → 34 days out (first whole week count reaching 28).
    expect(demoShiftDays('2026-12-20', '2026-12-07')).toBe(21);
    // Already past → still whole weeks, lands 28+ days ahead.
    const shift = demoShiftDays('2026-12-20', '2027-02-01');
    expect(shift % 7).toBe(0);
    const lead = (Date.parse('2026-12-20') + shift * 86_400_000 - Date.parse('2027-02-01')) / 86_400_000;
    expect(lead).toBeGreaterThanOrEqual(28);
    expect(lead).toBeLessThan(35);
  });
});

describe('shiftDatesDeep', () => {
  it('moves every date — values, keys and dates inside links — and leaves the rest', () => {
    const out = shiftDatesDeep(trip, 7) as any;
    expect(out.cities[0].dates).toEqual({ arrival: '2026-12-28', departure: '2026-12-30' });
    expect(Object.keys(out.cities[0].schedule)).toEqual(['2026-12-28']);
    expect(out.cities[0].schedule['2026-12-28'][0].start).toBe('09:00');
    expect(out.cities[0].hotels[0].bookingUrl).toBe('https://b.test/?checkin=2026-12-28&checkout=2026-12-30');
    expect(out.cities[0].hotels[0].name).toBe('Hotel 2026');
    expect(out.origin.outboundLeg).toMatchObject({ departDate: '2026-12-27', arriveDate: '2026-12-28' });
    expect(out.origin.outboundLeg.bookingUrl).toContain('2026-12-27');
    // A copy: the stored trip is untouched.
    expect((trip as any).cities[0].dates.arrival).toBe('2026-12-21');
  });

  it('crosses month and year ends', () => {
    expect(shiftDatesDeep({ d: '2026-12-30' }, 3)).toEqual({ d: '2027-01-02' });
  });
});

describe('demoTripForToday', () => {
  it('finds the first travel day', () => {
    expect(earliestDate(trip)).toBe('2026-12-20');
  });

  it('opens as an unsaved trip with no AI-picks run to wait on', () => {
    const t = demoTripForToday(demo, '2026-11-15') as any;
    expect(t.id).toBeUndefined();
    expect(t.picksRun).toBeUndefined();
    expect(t.cities[0].dates.arrival).toBe('2026-12-21');
  });

  it('shifts a demo opened too close to (or after) its dates', () => {
    const t = demoTripForToday(demo, '2026-12-19');
    expect(earliestDate(t)! >= '2027-01-16').toBe(true);
  });
});

describe('the committed demo trips', () => {
  it('are complete enough to open with no live search', () => {
    expect(DEMO_TRIPS.length).toBeGreaterThanOrEqual(2);
    for (const d of DEMO_TRIPS) {
      expect(d.trip.cities.map((c) => c.name).sort()).toEqual([...d.cities].sort());
      // /results searches hotels for a city with one or none, and home
      // flights for a trip missing either: neither may be needed.
      for (const c of d.trip.cities) expect(c.hotels.length).toBeGreaterThan(1);
      expect(d.trip.origin?.outboundLeg?.price).toBeGreaterThan(0);
      expect(d.trip.origin?.returnLeg?.price).toBeGreaterThan(0);
      expect(d.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('lead with a trip whose best route takes a train', () => {
    expect(DEMO_TRIPS[0].trip.cities.some((c) => c.transportOut?.mode === 'train')).toBe(true);
  });

  it('match a live search for the same cities in any order', () => {
    const d = DEMO_TRIPS[0];
    expect(demoTripFor([...d.cities].reverse())?.slug).toBe(d.slug);
    expect(demoTripFor(['Atlantis'])).toBeNull();
  });
});
