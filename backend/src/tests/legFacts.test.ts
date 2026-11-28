// legFacts pulls in services/allaboard, which loads the env config; without
// these the config refuses to load and the whole suite fails to start.
jest.mock('../config/env', () => ({
  env: {
    ALLABOARD_API_URL: 'https://test.api-gateway.allaboard.eu',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

import {
  airportTransferMinutes,
  DEPARTURE_AIRPORT_MINUTES,
  flightCo2FromOffer,
  flightDoorToDoor,
  RAIL_DETOUR,
  RAIL_G_CO2E_PER_PKM,
  trainCo2,
  trainDoorToDoor,
} from '../services/legFacts';
import { allAboardIsTestGateway } from '../services/allaboard';

describe('legFacts — door to door', () => {
  test('a flight adds both airport transfers and the departure-airport time, and says so', () => {
    const d = flightDoorToDoor({
      from: { city: 'Munich', country: 'Germany' },
      to: { city: 'Berlin', country: 'Germany' },
      originAirport: 'MUC',
      destinationAirport: 'BER',
      flightMinutes: 70,
    });
    expect(d).not.toBeNull();
    expect(d!.parts.map((p) => p.kind)).toEqual(['transfer', 'airport', 'flight', 'transfer']);
    expect(d!.parts[0].label).toBe('City centre → MUC');
    expect(d!.parts[3].label).toBe('BER → city centre');
    expect(d!.parts[1].minutes).toBe(DEPARTURE_AIRPORT_MINUTES);
    expect(d!.totalMinutes).toBe(d!.parts.reduce((s, p) => s + p.minutes, 0));
    // MUC is ~28 km out of Munich: a real transfer, not a token one.
    expect(d!.parts[0].minutes).toBeGreaterThanOrEqual(60);
    expect(d!.parts[0].minutes).toBeLessThanOrEqual(90);
  });

  test('no total without the flight length or a known airport', () => {
    const base = { from: { city: 'Munich' }, to: { city: 'Berlin' }, originAirport: 'MUC', destinationAirport: 'BER' };
    expect(flightDoorToDoor({ ...base, flightMinutes: 0 })).toBeNull();
    expect(flightDoorToDoor({ ...base, flightMinutes: null })).toBeNull();
    expect(flightDoorToDoor({ ...base, originAirport: undefined, flightMinutes: 70 })).toBeNull();
    expect(flightDoorToDoor({ ...base, destinationAirport: 'ZZZ', flightMinutes: 70 })).toBeNull();
  });

  test('a train is its own journey time, station to station', () => {
    expect(trainDoorToDoor(230)).toEqual({
      totalMinutes: 230,
      basis: 'city centre to city centre',
      parts: [{ kind: 'train', label: 'Train, station to station', minutes: 230 }],
    });
    expect(trainDoorToDoor(0)).toBeNull();
    expect(trainDoorToDoor(-720)).toBeNull();
  });

  test('transfer estimate matches the day schedule formula (15 + km×1.3 at 40 km/h, up to 5)', () => {
    expect(airportTransferMinutes(0)).toBe(15);
    expect(airportTransferMinutes(20)).toBe(55); // 15 + 39 = 54 → 55
  });
});

describe('legFacts — CO₂', () => {
  test('train CO₂ = straight line × rail detour × factor × travellers, labelled an estimate', () => {
    const one = trainCo2({ city: 'Berlin', country: 'Germany' }, { city: 'Hamburg', country: 'Germany' }, 1)!;
    const two = trainCo2({ city: 'Berlin', country: 'Germany' }, { city: 'Hamburg', country: 'Germany' }, 2)!;
    expect(one.source).toBe('estimate');
    expect(one.gramsPerPassengerKm).toBe(RAIL_G_CO2E_PER_PKM);
    // ~255 km straight → ~306 km assumed by rail.
    expect(one.distanceKm).toBeGreaterThan(255 * RAIL_DETOUR - 15);
    expect(one.distanceKm).toBeLessThan(255 * RAIL_DETOUR + 15);
    expect(one.kg).toBeCloseTo((one.distanceKm! * RAIL_G_CO2E_PER_PKM) / 1000, 0);
    expect(two.kg).toBeCloseTo(one.kg * 2, 0);
  });

  test('unknown city → no train CO₂ rather than a guess', () => {
    expect(trainCo2({ city: 'Qxzzyvillé' }, { city: 'Hamburg' }, 1)).toBeNull();
  });

  test("flight CO₂ is Duffel's total_emissions_kg, only when it is a positive number", () => {
    expect(flightCo2FromOffer({ total_emissions_kg: '113' })).toEqual({ kg: 113, source: 'duffel' });
    expect(flightCo2FromOffer({ total_emissions_kg: 42.5 })).toEqual({ kg: 42.5, source: 'duffel' });
    expect(flightCo2FromOffer({})).toBeNull();
    expect(flightCo2FromOffer({ total_emissions_kg: '0' })).toBeNull();
    expect(flightCo2FromOffer({ total_emissions_kg: 'n/a' })).toBeNull();
    expect(flightCo2FromOffer(null)).toBeNull();
  });
});

describe('All Aboard test gateway detection', () => {
  test('the default test URL is a test gateway; a production host is not', () => {
    expect(allAboardIsTestGateway('https://test.api-gateway.allaboard.eu')).toBe(true);
    expect(allAboardIsTestGateway('https://api-gateway.allaboard.eu')).toBe(false);
    expect(allAboardIsTestGateway('not a url')).toBe(true);
  });
});
