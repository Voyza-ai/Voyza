/**
 * F4 — a saved preset starts its first stay the day the outbound LANDS.
 *
 * Integrated run, 2026-10-30: /browse → Paris Long Weekend → Save → sign in.
 * The saved trip had Paris Nov 29 → Dec 2 while the outbound landed Nov 30
 * 12:10, and the results page's hotel search checked in Nov 29 — a night on
 * the plane. The preset/save path (buildPresetTrip + /home-legs, through
 * resolveCanvasTripId) never applied the optimizer's landing-date rule.
 *
 * The rule itself is the backend's (firstStayArrival, answered by /home-legs
 * as `firstCityArrival`); fetchHomeLegs is mocked here with that response.
 */
jest.mock('@/lib/api', () => ({
  saveTrip: jest.fn(),
  fetchHomeLegs: jest.fn(),
}));

import { saveTrip, fetchHomeLegs } from '@/lib/api';
import { resolveCanvasTripId, stashCanvasIntent, readCanvasIntent, readCanvasSync } from '@/lib/canvasHandoff';
import { buildPresetTrip, PRESET_ITINERARIES } from '@/data/presetItineraries';

const mockedSaveTrip = saveTrip as jest.MockedFunction<typeof saveTrip>;
const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;

const paris = PRESET_ITINERARIES.find((p) => p.slug === 'paris-long-weekend')!;

/** The browse page's intent for a preset save (app/browse/page.tsx buildIntent). */
function presetIntent() {
  const trip = buildPresetTrip(paris, 4);
  return {
    savedId: null,
    payload: trip as any,
    origin: trip.origin ? { origin: trip.origin, returnToHome: true } : null,
    syncCities: trip.cities as any[],
    destination: 'results' as const,
  };
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** /home-legs for an overnight JFK 19:25 → PAR 12:10 (+1), as the backend answers it. */
function overnightResponse(departDate: string, firstCityArrival?: string) {
  return {
    outboundLeg: {
      originAirport: 'JFK',
      destAirport: 'PAR',
      price: 891.6,
      departTime: '19:25',
      arriveTime: '12:10',
      departDate,
      arriveDate: addDays(departDate, 1),
    },
    returnLeg: { originAirport: 'PAR', destAirport: 'JFK', price: 891.6, departDate: addDays(departDate, 3) },
    ...(firstCityArrival ? { firstCityArrival } : {}),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  mockedSaveTrip.mockResolvedValue({ tripId: 'trip-123', trip: {} });
});

describe('preset save — the landing-date rule', () => {
  it('saves Paris from the landing day, and the hotel search will check in then', async () => {
    const intent = presetIntent();
    const { arrival, departure } = intent.payload.cities[0].dates;
    mockedFetchHomeLegs.mockResolvedValue(overnightResponse(arrival, addDays(arrival, 1)) as any);

    await resolveCanvasTripId(intent);

    // The route is asked for the landing-day answer.
    expect(mockedFetchHomeLegs).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: arrival, firstCityDeparture: departure }),
    );
    const saved = mockedSaveTrip.mock.calls[0][0];
    // Before: Paris kept the departure day — a hotel night on the plane.
    expect(saved.cities[0].dates).toEqual({ arrival: addDays(arrival, 1), departure });
    // The results page checks hotels in on `city.dates.arrival` of the saved trip.
    expect(saved.origin.outboundLeg.arriveDate).toBe(saved.cities[0].dates.arrival);
    // The trip still starts the day the flight leaves (the header and
    // start_date read the outbound's departDate — F1).
    expect(saved.origin.outboundLeg.departDate).toBe(arrival);
  });

  it('keeps the canvas handoff in step, also after the OAuth round trip', async () => {
    const original = presetIntent();
    const { arrival } = original.payload.cities[0].dates;
    mockedFetchHomeLegs.mockResolvedValue(overnightResponse(arrival, addDays(arrival, 1)) as any);
    // Google sign-in: the intent survives as JSON, so syncCities is a copy.
    stashCanvasIntent(original as any);
    const intent = readCanvasIntent()!;

    await resolveCanvasTripId(intent);

    expect(readCanvasSync('trip-123')?.cities[0].dates.arrival).toBe(addDays(arrival, 1));
    expect(mockedSaveTrip.mock.calls[0][0].cities[0].dates.arrival).toBe(addDays(arrival, 1));
  });

  it('a same-day outbound, or a route that does not answer the rule, changes nothing', async () => {
    const intent = presetIntent();
    const before = JSON.parse(JSON.stringify(intent.payload.cities));
    mockedFetchHomeLegs.mockResolvedValue(overnightResponse(before[0].dates.arrival) as any);
    await resolveCanvasTripId(intent);
    expect(mockedSaveTrip.mock.calls[0][0].cities).toEqual(before);
  });
});
