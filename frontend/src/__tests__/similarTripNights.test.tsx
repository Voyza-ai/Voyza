/**
 * "Plan a similar trip" keeps the preset's own night split and countries
 * (website audit m11). The Lisbon & Sintra preset says Lisbon 3 nights +
 * Sintra 1; the re-plan came back 2 + 2, because the planner only sent the
 * optimizer a total, and Sintra's card had no country (it is not in the city
 * dataset). Now the split and countries are staged with the preset's shape
 * and sent to the optimizer while they still describe the trip.
 */
import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BrowsePage from '@/app/browse/page';
import PlanningChat from '@/components/planning/PlanningChat';
import { PRESET_ITINERARIES } from '@/data/presetItineraries';
import { optimizeTrip } from '@/lib/api';
import { stagedCountry, usableCityNights } from '@/lib/cityNights';
import { useTripStore } from '@/store/tripStore';

const mockedOptimize = optimizeTrip as jest.MockedFunction<typeof optimizeTrip>;

const setGeolocation = (impl: any) =>
  Object.defineProperty(global.navigator, 'geolocation', { value: impl, configurable: true });
const BOSTON = { latitude: 42.36, longitude: -71.06 };

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
});
beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
});
afterEach(() => {
  // @ts-expect-error cleanup
  delete global.navigator.geolocation;
  window.history.pushState({}, '', '/');
  sessionStorage.clear();
});

describe('usableCityNights', () => {
  const split = { Lisbon: 3, Sintra: 1 };

  it('passes a split that names exactly the destinations and adds up', () => {
    expect(usableCityNights(split, ['Lisbon', 'Sintra'], 4)).toEqual(split);
    expect(usableCityNights(split, ['Sintra', 'Lisbon'], undefined)).toEqual({ Sintra: 1, Lisbon: 3 });
    expect(usableCityNights({ ' lisbon ': 3, SINTRA: 1 }, ['Lisbon', 'Sintra'], 4)).toEqual(split);
  });

  it.each([
    ['nothing staged', undefined, ['Lisbon', 'Sintra'], 4],
    ['a city added in the chat since', split, ['Lisbon', 'Sintra', 'Porto'], 5],
    ['a city swapped', split, ['Lisbon', 'Porto'], 4],
    ['a different length', split, ['Lisbon', 'Sintra'], 6],
    ['a zero', { Lisbon: 4, Sintra: 0 }, ['Lisbon', 'Sintra'], 4],
    ['a city named twice', { Lisbon: 2, lisbon: 2 }, ['Lisbon'], 4],
  ])('drops %s (the even split applies)', (_why, given, destinations, total) => {
    expect(usableCityNights(given as any, destinations as string[], total as number)).toBeUndefined();
  });

  it('stagedCountry matches names like the nights do', () => {
    expect(stagedCountry({ Sintra: 'Portugal' }, ' sintra')).toBe('Portugal');
    expect(stagedCountry({ Sintra: 'Portugal' }, 'Porto')).toBeUndefined();
    expect(stagedCountry(undefined, 'Sintra')).toBeUndefined();
  });
});

describe('/browse stages the split', () => {
  it('"Plan a similar trip" stages each city’s nights and country from the preset', async () => {
    setGeolocation({ getCurrentPosition: (ok: any) => ok({ coords: BOSTON }) });
    const preset = PRESET_ITINERARIES.find((p) => p.cities.length > 1 && new Set(p.cities.map((c) => c.nights)).size > 1)!;
    render(<BrowsePage />);
    fireEvent.click(screen.getByText(preset.title));
    fireEvent.click(await screen.findByRole('button', { name: /Plan a similar trip/i }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/plan?resume=1&autorun=1'));
    const staged = JSON.parse(sessionStorage.getItem('bluemurr-autorun')!);
    expect(staged.cityNights).toEqual(Object.fromEntries(preset.cities.map((c) => [c.name, c.nights])));
    expect(staged.cityCountries).toEqual(Object.fromEntries(preset.cities.map((c) => [c.name, c.country])));
  });
});

describe('the planner sends it to the optimizer', () => {
  const lisbonSintra = {
    destinations: ['Lisbon', 'Sintra'],
    dateRange: { start: '2027-03-10', end: '2027-03-14' },
    travelers: 2,
    origin: 'Boston',
    originAirports: ['BOS'],
    returnToHome: true,
    planningMode: 'destination' as const,
    cityNights: { Lisbon: 3, Sintra: 1 },
    cityCountries: { Lisbon: 'Portugal', Sintra: 'Portugal' },
    autorunReason: 'similar-trip',
  };

  const run = async (staged: Record<string, unknown>) => {
    mockedOptimize.mockRejectedValue(new Error('search stopped by test'));
    window.history.pushState({}, '', '/plan?resume=1&autorun=1');
    sessionStorage.setItem('bluemurr-autorun', JSON.stringify(staged));
    render(<PlanningChat />);
    await waitFor(() => expect(mockedOptimize).toHaveBeenCalledTimes(1));
    return mockedOptimize.mock.calls[0][0];
  };

  it('with the preset’s split and each city’s country', async () => {
    const call = await run(lisbonSintra);
    expect(call.totalNights).toBe(4);
    expect(call.cityNights).toEqual({ Lisbon: 3, Sintra: 1 });
    expect(call.cities).toEqual([
      { name: 'Lisbon', country: 'Portugal' },
      { name: 'Sintra', country: 'Portugal' },
    ]);
  });

  it('without a split that no longer matches the trip', async () => {
    const call = await run({ ...lisbonSintra, dateRange: { start: '2027-03-10', end: '2027-03-16' } });
    expect(call.totalNights).toBe(6);
    expect(call.cityNights).toBeUndefined();
  });

  it('a plain plan sends neither, as before', async () => {
    const { cityNights: _n, cityCountries: _c, autorunReason: _r, ...plain } = lisbonSintra;
    const call = await run(plain);
    expect(call.cityNights).toBeUndefined();
    expect(call.cities).toEqual([{ name: 'Lisbon' }, { name: 'Sintra' }]);
  });
});
