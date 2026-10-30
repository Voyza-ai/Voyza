import { mockPush, mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { useTripStore, restoreTripSession } from '@/store/tripStore';
import { buildTrip, buildCity, mockHotel, mockHotel2 } from './fixtures';
import { searchHotels, fetchHomeLegs, planChatSuggestions } from '@/lib/api';
import ResultsPage from '@/app/results/page';
import AIChatPanel from '@/components/results/AIChatPanel';
import type { Trip } from '@/lib/types';

/**
 * Reloading /results must not throw the trip away (audit D-05).
 *
 * The planner hands an unsaved trip to the store and routes to a bare
 * `/results`; nothing else holds it. A reload found an empty store and the
 * page redirected to `/plan`, so a presenter pressing refresh lost the trip.
 * The store now keeps a per-tab snapshot and the page restores it.
 *
 * The second half matters as much as the first: restoring must not make the
 * page re-buy what the trip already shows. Hotel searches, home-leg searches
 * and the chat's suggestion call all sit behind the paid-API rate limit (30
 * per 15 minutes on /api/plan, /api/hotels, /api/flights), and a reload that
 * spent them would trade a lost trip for a throttled demo.
 */

const SESSION_KEY = 'bluemurr-current-trip';
const mockedSearchHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;
const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;
const mockedSuggestions = planChatSuggestions as jest.MockedFunction<typeof planChatSuggestions>;

const homeLeg = (from: string, to: string, price: number) => ({
  originAirport: from,
  destinationAirport: to,
  price,
  currency: 'USD',
  durationMinutes: 480,
  stops: 0,
  carrier: 'Duffel Airways',
});

/** A trip the planner finished with: every city has its hotel list, home legs found. */
function plannedTrip(overrides: Partial<Trip> = {}): Trip {
  return buildTrip({
    id: undefined,
    title: 'Rome → Florence',
    cities: [
      buildCity(),
      buildCity({
        name: 'Florence',
        dates: { arrival: '2026-06-18', departure: '2026-06-20' },
        hotels: [mockHotel, mockHotel2],
        hotel: mockHotel,
      }),
    ],
    origin: {
      city: 'New York',
      airports: ['JFK'],
      outboundLeg: homeLeg('JFK', 'FCO', 1312) as any,
      returnLeg: homeLeg('FLR', 'JFK', 1190) as any,
    },
    returnToHome: true,
    ...overrides,
  });
}

/**
 * What a reload leaves behind: the tab's sessionStorage, and a brand-new,
 * empty store. Clearing the store through setState would also clear the
 * snapshot (that is the subscriber doing its job), so the raw entry is put
 * back afterwards — which is exactly the state a reloaded tab starts in.
 */
function simulateReload() {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  useTripStore.setState({ currentTrip: null, priceMode: 'total', restoredFromSession: false });
  if (raw !== null) window.sessionStorage.setItem(SESSION_KEY, raw);
}

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  mockSearchParams.delete('tripId');
  useTripStore.setState({ currentTrip: null, priceMode: 'total', restoredFromSession: false });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the store keeps a per-tab snapshot of the current trip', () => {
  it('writes the trip as it changes and restores it, price mode included', () => {
    const trip = plannedTrip();
    useTripStore.getState().setTrip(trip);
    useTripStore.getState().setPriceMode('perPerson');
    useTripStore.getState().cycleHotel(1, 1); // a later edit must be in the snapshot too
    const edited = useTripStore.getState().currentTrip;

    simulateReload();
    expect(useTripStore.getState().currentTrip).toBeNull();

    expect(restoreTripSession()).toBe(true);
    expect(useTripStore.getState().currentTrip).toEqual(edited);
    expect(useTripStore.getState().currentTrip?.cities[1].hotel?.name).toBe(mockHotel2.name);
    expect(useTripStore.getState().priceMode).toBe('perPerson');
    expect(useTripStore.getState().restoredFromSession).toBe(true);
  });

  it('forgets the trip when planning starts over, so a reload cannot bring it back', () => {
    useTripStore.getState().setTrip(plannedTrip());
    useTripStore.getState().resetPlanning();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    simulateReload();
    expect(restoreTripSession()).toBe(false);
  });

  it('over quota, drops the entry rather than leave the PREVIOUS trip to be restored', () => {
    useTripStore.getState().setTrip(plannedTrip({ title: 'Old trip' }));
    expect(window.sessionStorage.getItem(SESSION_KEY)).toContain('Old trip');

    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => useTripStore.getState().setTrip(plannedTrip({ title: 'New trip' }))).not.toThrow();
    jest.restoreAllMocks();

    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    simulateReload();
    expect(restoreTripSession()).toBe(false);
  });

  it.each([
    ['not JSON', '{oops'],
    ['another build’s shape', JSON.stringify({ v: 999, trip: plannedTrip(), priceMode: 'total' })],
    ['no trip', JSON.stringify({ v: 1, priceMode: 'total' })],
    ['a city the first render would crash on', JSON.stringify({ v: 1, trip: { ...plannedTrip(), cities: [{ name: 'Rome' }] } })],
  ])('ignores a snapshot that is %s', (_label, raw) => {
    window.sessionStorage.setItem(SESSION_KEY, raw);
    expect(restoreTripSession()).toBe(false);
    expect(useTripStore.getState().currentTrip).toBeNull();
  });

  it('survives storage that throws on access', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(restoreTripSession()).toBe(false);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => useTripStore.getState().setTrip(plannedTrip())).not.toThrow();
  });
});

describe('reloading /results', () => {
  it('renders the same trip instead of redirecting to /plan', async () => {
    useTripStore.getState().setTrip(plannedTrip());
    simulateReload();

    render(<ResultsPage />);

    expect(await screen.findAllByText('Florence')).not.toHaveLength(0);
    expect(useTripStore.getState().currentTrip?.title).toBe('Rome → Florence');
    expect(mockPush).not.toHaveBeenCalledWith('/plan');
  });

  it('buys nothing again: no hotel search, no home-leg search, no suggestion call', async () => {
    const chips = ['Why fly into Rome?', 'Cheaper Florence stay', 'Pin Rome dates', 'Add a day trip'];
    mockedSuggestions.mockResolvedValueOnce({ suggestions: chips });

    // First visit, as the planner leaves it: the chips are bought once.
    useTripStore.getState().setTrip(plannedTrip());
    const first = render(<ResultsPage />);
    expect(await screen.findByText(chips[0])).toBeInTheDocument();
    expect(mockedSuggestions).toHaveBeenCalledTimes(1);
    first.unmount();
    jest.clearAllMocks();

    simulateReload();
    render(<ResultsPage />);

    // The same chips, from this tab's copy.
    expect(await screen.findByText(chips[0])).toBeInTheDocument();
    // Let every effect the restore triggered run to completion.
    await waitFor(() => expect(useTripStore.getState().currentTrip).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedSearchHotels).not.toHaveBeenCalled();
    expect(mockedFetchHomeLegs).not.toHaveBeenCalled();
    expect(mockedSuggestions).not.toHaveBeenCalled();
  });

  it('still fetches what the restored trip is MISSING — a city with no hotels', async () => {
    const trip = plannedTrip();
    // The shape a city has when its hotel search came back empty.
    trip.cities[1] = {
      ...trip.cities[1],
      hotels: [],
      hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    };
    useTripStore.getState().setTrip(trip);
    simulateReload();

    render(<ResultsPage />);

    await waitFor(() => expect(mockedSearchHotels).toHaveBeenCalledTimes(1));
    expect(mockedSearchHotels.mock.calls[0][0]).toMatchObject({ city: 'Florence' });
  });

  it('leaves a ?tripId= reload to the database, which is where a canvas save in another tab lands', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ trip: plannedTrip({ id: 'trip-db-1', title: 'From the database' }) }),
    });
    (global as any).fetch = fetchSpy;
    useTripStore.getState().setTrip(plannedTrip({ id: 'trip-db-1', title: 'Stale tab copy' }));
    simulateReload();
    mockSearchParams.set('tripId', 'trip-db-1');

    render(<ResultsPage />);

    await waitFor(() =>
      expect(useTripStore.getState().currentTrip?.title).toBe('From the database'),
    );
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/trips/trip-db-1');
    expect(useTripStore.getState().restoredFromSession).toBe(false);
    mockSearchParams.delete('tripId');
  });

  it('with nothing to restore, still sends the traveller to /plan', async () => {
    render(<ResultsPage />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/plan'));
  });
});

describe('suggestion chips are re-used only for a restored trip', () => {
  const chips = ['A chip', 'B chip', 'C chip', 'D chip'];

  it('an ordinary visit asks every time, as before', async () => {
    mockedSuggestions.mockResolvedValue({ suggestions: chips });
    const trip = plannedTrip();
    const a = render(<AIChatPanel trip={trip} />);
    await screen.findByText('A chip');
    a.unmount();
    render(<AIChatPanel trip={trip} />);
    await screen.findByText('A chip');
    expect(mockedSuggestions).toHaveBeenCalledTimes(2);
  });

  it('a restored trip that changed since asks again', async () => {
    mockedSuggestions.mockResolvedValue({ suggestions: chips });
    const trip = plannedTrip();
    const a = render(<AIChatPanel trip={trip} />);
    await screen.findByText('A chip');
    a.unmount();

    useTripStore.setState({ restoredFromSession: true });
    const changed = { ...trip, cities: [trip.cities[0], { ...trip.cities[1], hotel: mockHotel2 }] };
    render(<AIChatPanel trip={changed} />);
    await waitFor(() => expect(mockedSuggestions).toHaveBeenCalledTimes(2));
  });

  it('a failed call leaves nothing behind to re-use', async () => {
    mockedSuggestions.mockRejectedValueOnce(new Error('429'));
    const trip = plannedTrip();
    const a = render(<AIChatPanel trip={trip} />);
    await waitFor(() => expect(mockedSuggestions).toHaveBeenCalledTimes(1));
    a.unmount();

    useTripStore.setState({ restoredFromSession: true });
    mockedSuggestions.mockResolvedValueOnce({ suggestions: chips });
    render(<AIChatPanel trip={trip} />);
    await screen.findByText('A chip');
    expect(mockedSuggestions).toHaveBeenCalledTimes(2);
  });
});
