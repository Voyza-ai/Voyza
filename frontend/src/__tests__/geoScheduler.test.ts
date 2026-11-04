/**
 * Geo-aware day planning: morning activity → nearest lunch → nearest
 * afternoon activity, travel time honoured between located slots, the
 * no-overlap guarantee kept, and the old queue-order behaviour for anything
 * without coordinates.
 */
import {
  annotateTravel,
  buildCityScheduleFromSuggestions,
  planDay,
  SLOT_BUFFER_MIN,
} from '@/lib/dayScheduleDefaults';
import {
  estimateTravel,
  haversineKm,
  legBetweenEvents,
  nearestIndex,
  travelBetween,
  WALK_MAX_MIN,
} from '@/lib/geoSchedule';
import { dayConnectors } from '@/components/results/TravelConnectors';
import { mergePlaces, withCityGeo } from '@/store/tripStore';
import { buildCitySpots, geocodeSpots } from '@/lib/citySpots';
import type { City, ScheduledEvent, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

jest.mock('@/lib/geocode', () => ({
  geocodeCities: jest.fn(async (qs: string[]) => qs.map(() => null)),
}));
import { geocodeCities } from '@/lib/geocode';

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

// Real Paris coordinates.
const LOUVRE = { lat: 48.8611, lng: 2.338, placeId: 'osm:R1' };
const NEAR_LOUVRE = { lat: 48.8625, lng: 2.336, placeId: 'osm:N2' }; // ~0.2 km
const MONTMARTRE = { lat: 48.8867, lng: 2.3431, placeId: 'osm:N3' }; // ~2.9 km north
const EIFFEL = { lat: 48.8584, lng: 2.2945, placeId: 'osm:W4' }; // ~3.2 km west
const PALAIS_ROYAL = { lat: 48.8638, lng: 2.337, placeId: 'osm:W5' }; // ~0.2 km
const BASTILLE = { lat: 48.8532, lng: 2.3692, placeId: 'osm:N6' };

const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

const cityOf = (overrides: Partial<City> = {}): City =>
  ({
    name: 'Paris',
    country: 'France',
    dates: { arrival: '2026-06-15', departure: '2026-06-16' },
    transportIn: emptyTransport,
    transportOut: emptyTransport,
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    hotels: [],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
    ...overrides,
  }) as City;

const tripOf = (city: City): Trip => ({ ...buildTrip(), cities: [city], origin: undefined });

const act = (name: string, timeOfDay: ActivitySuggestion['timeOfDay'], where?: object, hours = 2): ActivitySuggestion => ({
  name,
  category: 'landmark',
  timeOfDay,
  durationHours: hours,
  reason: 'r',
  ...(where ?? {}),
});
const meal = (name: string, mealType: RestaurantSuggestion['mealType'], where?: object): RestaurantSuggestion => ({
  name,
  cuisine: 'French',
  priceRange: '$$',
  mealType,
  reason: 'r',
  ...(where ?? {}),
});

const run = (a: ActivitySuggestion[], r: RestaurantSuggestion[], legs?: any) => {
  const city = cityOf();
  return buildCityScheduleFromSuggestions(a, r, city, 0, tripOf(city), { legs });
};

const day = (res: { schedule: Record<string, ScheduledEvent[]> }) => res.schedule['2026-06-15'];
const titles = (es: ScheduledEvent[]) => es.map((e) => e.title.replace(/ \(.*\)$/, ''));

const expectNoOverlap = (events: ScheduledEvent[]) => {
  const sorted = [...events].sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  for (let i = 1; i < sorted.length; i++) {
    expect(toMin(sorted[i].startTime) - toMin(sorted[i - 1].endTime)).toBeGreaterThanOrEqual(SLOT_BUFFER_MIN);
  }
};

/* ─────────────────────────── geometry helpers ─────────────────────────── */

describe('geoSchedule helpers', () => {
  it('haversine is right for a known pair (Louvre → Eiffel ≈ 3.2 km)', () => {
    expect(haversineKm(LOUVRE, EIFFEL)).toBeGreaterThan(3.0);
    expect(haversineKm(LOUVRE, EIFFEL)).toBeLessThan(3.5);
  });

  it('estimates a short hop as a walk and a long one as transit, in 5-minute steps', () => {
    const short = estimateTravel(LOUVRE, NEAR_LOUVRE);
    expect(short).toMatchObject({ mode: 'walk', minutes: 5, source: 'estimate' });
    const long = estimateTravel(LOUVRE, { lat: 48.8049, lng: 2.1204 }); // Versailles, ~17 km
    expect(long.mode).toBe('transit');
    expect(long.minutes % 5).toBe(0);
    expect(long.minutes).toBeGreaterThan(WALK_MAX_MIN);
  });

  it('prefers a measured Google leg for the exact pair', () => {
    const legs = { 'osm:R1>osm:W4': { minutes: 22, distanceKm: 3.4, mode: 'transit' as const } };
    expect(travelBetween(LOUVRE, EIFFEL, legs)).toEqual({ minutes: 22, distanceKm: 3.4, mode: 'transit', source: 'google', fromPlaceId: 'osm:R1' });
    expect(travelBetween(EIFFEL, LOUVRE, legs)!.source).toBe('estimate');
    expect(travelBetween(LOUVRE, { lat: undefined } as any)).toBeNull();
  });

  it('nearestIndex picks the closest located candidate, -1 when nothing is located', () => {
    expect(nearestIndex(LOUVRE, [MONTMARTRE, { name: 'x' } as any, NEAR_LOUVRE])).toBe(2);
    expect(nearestIndex(null, [NEAR_LOUVRE])).toBe(-1);
    expect(nearestIndex(LOUVRE, [{} as any])).toBe(-1);
  });
});

/* ─────────────────────────── the scheduler ─────────────────────────── */

describe('geo-aware day scheduling', () => {
  it('morning activity → NEAREST lunch → NEAREST afternoon activity, over queue order', () => {
    const res = run(
      [act('Louvre', 'morning', LOUVRE), act('Eiffel Tower', 'afternoon', EIFFEL), act('Palais-Royal gardens', 'afternoon', PALAIS_ROYAL)],
      [meal('Montmartre bistro', 'lunch', MONTMARTRE), meal('Café near Louvre', 'lunch', NEAR_LOUVRE)],
    );
    const events = day(res);
    expect(titles(events)).toEqual(['Louvre', 'Café near Louvre', 'Palais-Royal gardens']);
    expectNoOverlap(events);
    // Every placed event keeps its real coordinates.
    expect(events[1]).toMatchObject({ lat: NEAR_LOUVRE.lat, lng: NEAR_LOUVRE.lng, placeId: NEAR_LOUVRE.placeId });
    // The far picks are not lost — they go to the next day of the stay.
    const next = res.schedule['2026-06-16'] ?? [];
    expect(titles(next)).toEqual(expect.arrayContaining(['Eiffel Tower', 'Montmartre bistro']));
  });

  it('records the leg from the previous located slot on each event', () => {
    const events = day(run([act('Louvre', 'morning', LOUVRE), act('Palais-Royal', 'afternoon', PALAIS_ROYAL)], [meal('Café', 'lunch', NEAR_LOUVRE)]));
    const lunch = events.find((e) => e.title.startsWith('Café'))!;
    expect(lunch.travelFromPrev).toMatchObject({ mode: 'walk', fromPlaceId: LOUVRE.placeId, source: 'estimate' });
    expect(events[0].travelFromPrev).toBeUndefined();
  });

  it('dinner goes to the restaurant nearest the last activity', () => {
    const events = day(
      run(
        [act('Louvre', 'morning', LOUVRE), act('Bastille market', 'afternoon', BASTILLE)],
        [meal('Far dinner', 'dinner', MONTMARTRE), meal('Bastille dinner', 'dinner', { lat: 48.854, lng: 2.37, placeId: 'osm:D' })],
      ),
    );
    expect(titles(events)).toContain('Bastille dinner');
    expect(titles(events)).not.toContain('Far dinner');
  });

  it('a long travel time widens the gap beyond the 15-minute buffer — never an overlap', () => {
    // Google says Louvre → lunch takes 50 min (strike day).
    const legs = { 'osm:R1>osm:N3': { minutes: 50, distanceKm: 3, mode: 'transit' as const } };
    const events = day(run([act('Louvre', 'morning', LOUVRE, 2)], [meal('Montmartre bistro', 'lunch', MONTMARTRE)], legs));
    const louvre = events.find((e) => e.title === 'Louvre')!;
    const lunch = events.find((e) => e.title.startsWith('Montmartre'))!;
    expect(toMin(lunch.startTime) - toMin(louvre.endTime)).toBeGreaterThanOrEqual(50);
    expect(lunch.travelFromPrev).toMatchObject({ minutes: 50, source: 'google' });
    expectNoOverlap(events);
  });

  it('falls back to EXACTLY the pre-geo schedule when nothing has coordinates', () => {
    // Golden output captured from the scheduler on origin/dev before this
    // change, for the same picks over a three-night stay.
    const acts = [act('A', 'morning', undefined, 3), act('B', 'afternoon', undefined, 4), act('C', 'afternoon', undefined, 2), act('D', 'evening', undefined, 2), act('E', 'morning', undefined, 4), act('F', 'evening', undefined, 1)];
    const rests = [meal('L1', 'lunch'), meal('L2', 'lunch'), meal('D1', 'dinner'), meal('X', 'any'), meal('B1', 'breakfast')];
    const city = cityOf({ dates: { arrival: '2026-06-15', departure: '2026-06-18' } });
    const res = buildCityScheduleFromSuggestions(acts, rests, city, 0, tripOf(city));
    const shape = Object.entries(res.schedule).map(([d, es]) => [d, es.map((e) => [titles([e])[0], e.startTime, e.endTime])]);
    expect(shape).toEqual([
      ['2026-06-15', [['B1', '08:00', '08:45'], ['A', '09:00', '12:00'], ['L1', '12:15', '13:45'], ['B', '14:00', '18:00'], ['D1', '18:15', '20:15'], ['D', '20:30', '22:30']]],
      ['2026-06-16', [['X', '08:00', '08:45'], ['L2', '11:30', '13:00'], ['E', '13:15', '17:15'], ['C', '17:30', '19:30'], ['F', '19:45', '20:45']]],
    ]);
    const all = Object.values(res.schedule).flat();
    expect(all.every((e) => e.lat === undefined && e.travelFromPrev === undefined)).toBe(true);
  });

  it('mixes: an unlocated morning keeps queue order for lunch; located items still carry coords', () => {
    const events = day(
      run([act('Walking tour', 'morning'), act('Eiffel', 'afternoon', EIFFEL)], [meal('First lunch', 'lunch', MONTMARTRE), meal('Second lunch', 'lunch', NEAR_LOUVRE)]),
    );
    expect(titles(events)).toEqual(['Walking tour', 'First lunch', 'Eiffel']);
    expect(events.find((e) => e.title === 'Eiffel')!.travelFromPrev).toMatchObject({ fromPlaceId: MONTMARTRE.placeId });
  });

  it('never overlaps across a multi-day located stay', () => {
    const pts = [LOUVRE, NEAR_LOUVRE, MONTMARTRE, EIFFEL, PALAIS_ROYAL, BASTILLE];
    const acts = pts.flatMap((p, i) => [act(`M${i}`, 'morning', p, 3), act(`A${i}`, 'afternoon', p, 4), act(`E${i}`, 'evening', p, 2)]);
    const rests = pts.flatMap((p, i) => [meal(`L${i}`, 'lunch', p), meal(`D${i}`, 'dinner', p), meal(`B${i}`, 'breakfast', p)]);
    const city = cityOf({ dates: { arrival: '2026-06-15', departure: '2026-06-19' } });
    const res = buildCityScheduleFromSuggestions(acts, rests, city, 0, tripOf(city));
    for (const events of Object.values(res.schedule)) {
      expectNoOverlap(events);
      for (const e of events) {
        if (e.plannedDurationMin !== undefined) expect(toMin(e.endTime) - toMin(e.startTime)).toBe(e.plannedDurationMin);
      }
    }
  });
});

describe('planDay travelMin', () => {
  const base = { dayStart: 8 * 60, dayEnd: 23 * 60, busyRanges: [] as [number, number][] };
  const item = (key: string, durationMin: number) => ({ key, durationMin, earliestStart: 9 * 60, latestEnd: 23 * 60 });

  it('pads between two keyed items by their travel time, at least the buffer', () => {
    const plan = planDay({ ...base, sequence: [item('a', 60), item('b', 60)], flexible: [], travelMin: () => 40 });
    expect(plan.placements[1].startMin - plan.placements[0].endMin).toBe(40);
    const short = planDay({ ...base, sequence: [item('a', 60), item('b', 60)], flexible: [], travelMin: () => 5 });
    expect(short.placements[1].startMin - short.placements[0].endMin).toBe(SLOT_BUFFER_MIN);
  });

  it('transport blocks keep the plain buffer (no key, no travel lookup)', () => {
    const travelMin = jest.fn(() => 90);
    const plan = planDay({ ...base, busyRanges: [[9 * 60, 10 * 60]], sequence: [item('a', 60)], flexible: [], travelMin });
    expect(plan.placements[0].startMin).toBe(10 * 60 + SLOT_BUFFER_MIN);
  });
});

describe('connectors and annotation', () => {
  const ev = (id: string, s: string, e: string, where?: object, category: ScheduledEvent['category'] = 'activity'): ScheduledEvent => ({
    id,
    title: id,
    startTime: s,
    endTime: e,
    category,
    ...(where ?? {}),
  });

  it('draws one connector per consecutive located pair, none around transport or unlocated events', () => {
    const events = [
      ev('t', '08:00', '09:00', LOUVRE, 'transport'),
      ev('a', '09:30', '11:30', LOUVRE),
      ev('b', '12:00', '13:00', NEAR_LOUVRE),
      ev('c', '14:00', '15:00'),
      ev('d', '16:00', '17:00', EIFFEL),
    ];
    const cs = dayConnectors(events);
    expect(cs.map((c) => c.key)).toEqual(['a>b']);
    expect(cs[0]).toMatchObject({ startMin: 11 * 60 + 30, endMin: 12 * 60 });
  });

  it('uses the stored leg only while it still starts from the previous event', () => {
    const stored = { minutes: 33, distanceKm: 2, mode: 'transit' as const, source: 'google' as const, fromPlaceId: LOUVRE.placeId };
    const b = { ...ev('b', '12:00', '13:00', NEAR_LOUVRE), travelFromPrev: stored };
    expect(legBetweenEvents(ev('a', '9:00', '11:00', LOUVRE), b)!.minutes).toBe(33);
    // Re-ordered by hand: now preceded by the Eiffel Tower — re-estimated.
    expect(legBetweenEvents(ev('x', '9:00', '11:00', EIFFEL), b)!.source).toBe('estimate');
  });

  it('annotateTravel replaces stale legs', () => {
    const events = [ev('a', '09:00', '10:00', LOUVRE), { ...ev('b', '10:30', '11:00', EIFFEL), travelFromPrev: { minutes: 1, distanceKm: 0, mode: 'walk' as const, source: 'estimate' as const } }];
    annotateTravel(events);
    expect(events[1].travelFromPrev!.minutes).toBeGreaterThan(1);
  });
});

/* ─────────────────────────── store: landing coordinates ─────────────────────────── */

describe('withCityGeo', () => {
  const acts = [act('Louvre', 'morning'), act('Eiffel Tower', 'afternoon'), act('Palais-Royal', 'afternoon')];
  const rests = [meal('Montmartre bistro', 'lunch'), meal('Café near Louvre', 'lunch')];
  const located = mergePlaces({ activities: acts, restaurants: rests }, [
    { name: 'Louvre', ...LOUVRE },
    { name: 'Eiffel Tower', ...EIFFEL },
    { name: 'Palais-Royal', ...PALAIS_ROYAL },
    { name: 'Montmartre bistro', ...MONTMARTRE },
    { name: 'Café near Louvre', ...NEAR_LOUVRE },
  ]);

  const tripWithBuilt = () => {
    const city = cityOf({ activities: acts.map((a) => a.name), restaurants: rests.map(({ name, cuisine, priceRange }) => ({ name, cuisine, priceRange })) });
    const trip = tripOf(city);
    const built = buildCityScheduleFromSuggestions(acts, rests, city, 0, trip);
    trip.cities[0] = { ...city, schedule: built.schedule };
    return trip;
  };

  it('re-plans an untouched day geographically and stores coordinates on restaurants', () => {
    const trip = tripWithBuilt();
    expect(titles(trip.cities[0].schedule!['2026-06-15'])).toEqual(['Louvre', 'Montmartre bistro', 'Eiffel Tower']);
    const next = withCityGeo(trip, 'Paris', { activities: acts, restaurants: rests }, located);
    expect(titles(next.cities[0].schedule!['2026-06-15'])).toEqual(['Louvre', 'Café near Louvre', 'Palais-Royal']);
    expect(next.cities[0].restaurants.find((r) => r.name === 'Café near Louvre')).toMatchObject({ lat: NEAR_LOUVRE.lat, placeId: NEAR_LOUVRE.placeId });
  });

  it('leaves a day the traveller edited alone', () => {
    const trip = tripWithBuilt();
    const edited = trip.cities[0].schedule!['2026-06-15'].map((e, i) => (i === 0 ? { ...e, startTime: '10:00' } : e));
    trip.cities[0] = { ...trip.cities[0], schedule: { ...trip.cities[0].schedule, '2026-06-15': edited } };
    const next = withCityGeo(trip, 'Paris', { activities: acts, restaurants: rests }, located);
    expect(next.cities[0].schedule!['2026-06-15']).toBe(edited);
  });

  it('mergePlaces aligns /places answers by position and ignores unresolved ones', () => {
    const m = mergePlaces({ activities: [act('A', 'morning')], restaurants: [meal('R', 'lunch')] }, [{ name: 'A' }, { name: 'R', ...BASTILLE }]);
    expect(m.activities[0].lat).toBeUndefined();
    expect(m.restaurants[0]).toMatchObject({ lat: BASTILLE.lat, placeId: BASTILLE.placeId });
  });
});

/* ─────────────────────────── map uses stored coordinates ─────────────────────────── */

describe('map spots from stored coordinates', () => {
  it('pins located restaurants and scheduled activities without a geocoder lookup', async () => {
    const city = cityOf({
      activities: ['Louvre'],
      restaurants: [{ name: 'Café', cuisine: 'French', priceRange: '$$', ...NEAR_LOUVRE }],
      schedule: { '2026-06-15': [{ id: 'e', title: 'Louvre', startTime: '09:00', endTime: '11:00', category: 'activity', ...LOUVRE }] },
    });
    const seeds = buildCitySpots(tripOf(city), 0);
    const res = await geocodeSpots(seeds, { lat: 48.8566, lon: 2.3522 });
    expect(geocodeCities).not.toHaveBeenCalled();
    expect(res.spots.map((s) => [s.name, s.point])).toEqual([
      ['Louvre', { lat: LOUVRE.lat, lon: LOUVRE.lng }],
      ['Café', { lat: NEAR_LOUVRE.lat, lon: NEAR_LOUVRE.lng }],
    ]);
  });

  it('hands located spots over before geocoding the rest', async () => {
    const city = cityOf({
      activities: ['Some unlocated walk'],
      restaurants: [{ name: 'Café', cuisine: 'French', priceRange: '$$', ...NEAR_LOUVRE }],
    });
    const early = jest.fn();
    const res = await geocodeSpots(buildCitySpots(tripOf(city), 0), { lat: 48.8566, lon: 2.3522 }, early);
    expect(early).toHaveBeenCalledWith([expect.objectContaining({ name: 'Café' })]);
    expect(geocodeCities).toHaveBeenCalled();
    expect(res.spots.map((s) => s.name)).toEqual(['Café']);
  });
});
