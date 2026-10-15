/**
 * The canvas handoff is the pipeline every marketplace/results save flows
 * through: stash intent → survive login redirects → enrich home-leg flights
 * → saveTrip → seed the canvas handoff keys. These tests pin its contract.
 */
jest.mock('@/lib/api', () => ({
  saveTrip: jest.fn(),
  fetchHomeLegs: jest.fn(),
}));

import { saveTrip, fetchHomeLegs } from '@/lib/api';
import {
  stashCanvasIntent,
  readCanvasIntent,
  clearCanvasIntent,
  resolveCanvasTripId,
  readCanvasSync,
  clearCanvasSync,
  type CanvasIntent,
} from '@/lib/canvasHandoff';

const mockedSaveTrip = saveTrip as jest.MockedFunction<typeof saveTrip>;
const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;

const cities = [
  { name: 'Rome', dates: { arrival: '2026-08-10', departure: '2026-08-13' } },
  { name: 'Venice', dates: { arrival: '2026-08-13', departure: '2026-08-15' } },
];

const baseIntent = (over: Partial<CanvasIntent> = {}): CanvasIntent => ({
  savedId: null,
  payload: { title: 'Test Trip', travelers: 2, cities, returnToHome: true },
  origin: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  mockedSaveTrip.mockResolvedValue({ tripId: 'trip-123', trip: {} });
  mockedFetchHomeLegs.mockResolvedValue({ outboundLeg: null, returnLeg: null });
});

describe('intent stash (survives OAuth redirects via sessionStorage)', () => {
  test('stash → read roundtrip preserves the intent', () => {
    const intent = baseIntent({ destination: 'results' });
    stashCanvasIntent(intent);
    expect(readCanvasIntent()).toEqual(intent);
  });

  test('read returns null when nothing is stashed', () => {
    expect(readCanvasIntent()).toBeNull();
  });

  test('clear removes the stashed intent', () => {
    stashCanvasIntent(baseIntent());
    clearCanvasIntent();
    expect(readCanvasIntent()).toBeNull();
  });
});

describe('resolveCanvasTripId', () => {
  test('already-saved trips short-circuit — no duplicate save', async () => {
    const id = await resolveCanvasTripId(baseIntent({ savedId: 'existing-9', payload: null }));
    expect(id).toBe('existing-9');
    expect(mockedSaveTrip).not.toHaveBeenCalled();
  });

  test('unsaved payloads are saved and return the new tripId', async () => {
    const id = await resolveCanvasTripId(baseIntent());
    expect(id).toBe('trip-123');
    expect(mockedSaveTrip).toHaveBeenCalledTimes(1);
  });

  test('returns null when there is nothing to open', async () => {
    const id = await resolveCanvasTripId(baseIntent({ payload: null }));
    expect(id).toBeNull();
    expect(mockedSaveTrip).not.toHaveBeenCalled();
  });

  test('seeds the per-trip origin key the canvas reads', async () => {
    const origin = { origin: { city: 'New York', airports: ['JFK'] }, returnToHome: true };
    await resolveCanvasTripId(baseIntent({ origin }));
    expect(JSON.parse(localStorage.getItem('voyza-origin-trip-123')!)).toEqual(origin);
  });

  test('hands the cities off for the canvas sync (one-shot)', async () => {
    await resolveCanvasTripId(baseIntent({ syncCities: cities }));
    const sync = readCanvasSync('trip-123');
    expect(sync?.cities).toEqual(cities);
    clearCanvasSync('trip-123');
    expect(readCanvasSync('trip-123')).toBeNull();
  });
});

describe('home-leg flight enrichment at save time', () => {
  const legIntent = () =>
    baseIntent({
      payload: {
        title: 'Preset',
        travelers: 4,
        returnToHome: true,
        cities,
        origin: { city: 'New York', airports: ['JFK'] },
      },
      origin: { origin: { city: 'New York', airports: ['JFK'] }, returnToHome: true },
    });

  test('searches flights with the trip party size and route endpoints', async () => {
    await resolveCanvasTripId(legIntent());
    expect(mockedFetchHomeLegs).toHaveBeenCalledWith(
      expect.objectContaining({
        originAirports: ['JFK'],
        originCity: 'New York',
        firstCity: 'Rome',
        lastCity: 'Venice',
        startDate: '2026-08-10',
        endDate: '2026-08-15',
        travelers: 4,
      }),
    );
  });

  test('found flights are attached to the trip before saving', async () => {
    const outboundLeg = { originAirport: 'JFK', destAirport: 'FCO', price: 500 };
    const returnLeg = { originAirport: 'VCE', destAirport: 'JFK', price: 450 };
    mockedFetchHomeLegs.mockResolvedValue({ outboundLeg, returnLeg });

    await resolveCanvasTripId(legIntent());

    const savedPayload = mockedSaveTrip.mock.calls[0][0];
    expect(savedPayload.origin.outboundLeg).toEqual(outboundLeg);
    expect(savedPayload.origin.returnLeg).toEqual(returnLeg);
  });

  test('flight search failure never blocks the save', async () => {
    mockedFetchHomeLegs.mockRejectedValue(new Error('duffel down'));
    const id = await resolveCanvasTripId(legIntent());
    expect(id).toBe('trip-123');
    expect(mockedSaveTrip).toHaveBeenCalledTimes(1);
  });

  test('trips that already carry flights are not re-searched', async () => {
    const intent = legIntent();
    (intent.payload as any).origin.outboundLeg = { price: 100 };
    await resolveCanvasTripId(intent);
    expect(mockedFetchHomeLegs).not.toHaveBeenCalled();
  });

  test('trips without a home anchor skip flight search entirely', async () => {
    await resolveCanvasTripId(baseIntent());
    expect(mockedFetchHomeLegs).not.toHaveBeenCalled();
  });
});
