import './mocks';
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildCity, buildTrip } from './fixtures';
import { fetchHomeLegs, searchHotels, updateTrip } from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';
import ResultsPage from '@/app/results/page';
import type { HomeLeg, Trip } from '@/lib/types';

/**
 * Re-pricing and the header's two numbers (items 3 and 4).
 *
 * Item 3: while a re-price is in flight the header shows the trip as it last
 * settled — never a total or a saving computed from a half-searched trip — and
 * when it settles the stored total follows the live one, so a cheaper result
 * is a new price, not "You can save $X".
 *
 * Item 4: My Trips lists `trips.total_cost`. When this page re-prices a SAVED
 * trip, the settled live total is written back with updateTrip, so the list
 * shows what opening the trip shows. Harness, saved Paris Long Weekend preset
 * for 4: My Trips $1,344 (the preset's quote, home flights excluded) while the
 * trip it opened said $2,390.
 */

const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;
const mockedSearchHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;
const mockedUpdateTrip = updateTrip as jest.MockedFunction<typeof updateTrip>;

const leg = (over: Partial<HomeLeg>): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'PAR',
  price: 891.6,
  currency: 'USD',
  durationMinutes: 645,
  operator: 'Icelandair',
  carrierCode: 'FI',
  departTime: '19:25',
  arriveTime: '12:10',
  departDate: '2026-11-29',
  arriveDate: '2026-11-30',
  stops: 1,
  bookingUrl: null,
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** "$N /person" — not animated, so it reads true at once. */
const perPersonLine = () => screen.getByText(/\/person/).textContent;
const perPerson = (trip: Trip) => `$${Math.round(liveTripTotal(trip) / trip.travelers).toLocaleString()} /person`;

/** A saved Browse preset as it opens: the preset's one hotel, its quote as the total, nothing saved. */
function savedPreset(): Trip {
  const quoteHotel = { name: 'Preset Hotel', rating: 8, pricePerNight: 448, area: '' };
  return buildTrip({
    id: 'c6961a4e-saved',
    title: 'Paris Long Weekend',
    travelers: 4,
    totalCost: 1344,
    savings: 0,
    returnToHome: true,
    dateShiftSuggestion: undefined,
    cities: [
      buildCity({
        name: 'Paris',
        dates: { arrival: '2026-11-30', departure: '2026-12-02' },
        hotels: [quoteHotel],
        hotel: quoteHotel,
        selectedHotelIndex: 0,
        transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
      }),
    ],
    origin: {
      city: 'New York',
      airports: ['JFK'],
      outboundLeg: leg({}),
      returnLeg: leg({ originAirport: 'PAR', destAirport: 'JFK', departDate: '2026-12-02', arriveDate: '2026-12-02' }),
    },
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: null, priceMode: 'total', restoredFromSession: false });
});

describe("a saved preset's first hotel search", () => {
  it('holds the header until the search lands, then stores and persists the live total', async () => {
    const trip = savedPreset();
    useTripStore.setState({ currentTrip: trip });
    const hotels = deferred<any>();
    mockedSearchHotels.mockReturnValue(hotels.promise);

    render(<ResultsPage />);
    expect(perPersonLine()).toBe(perPerson(trip));
    await act(async () => {
      hotels.resolve([
        { name: 'Mama Shelter Paris East', rating: 8.4, pricePerNight: 303.35, bookingUrl: 'https://b/1' },
        { name: 'Other', rating: 8, pricePerNight: 350, bookingUrl: 'https://b/2' },
      ]);
    });

    const settled = useTripStore.getState().currentTrip!;
    expect(settled.cities[0].hotel.name).toBe('Mama Shelter Paris East');
    const live = liveTripTotal(settled);
    await waitFor(() => expect(perPersonLine()).toBe(perPerson(settled)));
    // Before: never written back; My Trips kept $1,344.
    await waitFor(() => expect(mockedUpdateTrip).toHaveBeenCalledWith('c6961a4e-saved', { totalCost: live }));
    expect(settled.totalCost).toBe(live);
    expect(screen.queryByText('You can save')).not.toBeInTheDocument();
  });

  it('a quote above the live total never reads as a saving', async () => {
    // The preset quoted more than the live search found: the old baseline
    // (quote + 0) minus the live total was shown as "You can save".
    const trip = { ...savedPreset(), totalCost: 9000 };
    useTripStore.setState({ currentTrip: trip });
    mockedSearchHotels.mockResolvedValue([
      { name: 'Cheap', rating: 8, pricePerNight: 100, bookingUrl: 'https://b/c' },
      { name: 'Cheap 2', rating: 7.5, pricePerNight: 120, bookingUrl: 'https://b/d' },
    ] as any);
    render(<ResultsPage />);
    await waitFor(() => expect(useTripStore.getState().currentTrip!.cities[0].hotel.name).toBe('Cheap'));
    await waitFor(() => expect(useTripStore.getState().currentTrip!.totalCost).toBe(liveTripTotal(useTripStore.getState().currentTrip!)));
    expect(screen.queryByText('You can save')).not.toBeInTheDocument();
  });

  it('an unsaved trip is re-priced in memory only', async () => {
    const trip = { ...savedPreset(), id: undefined };
    useTripStore.setState({ currentTrip: trip });
    mockedSearchHotels.mockResolvedValue([
      { name: 'A', rating: 8, pricePerNight: 300, bookingUrl: 'https://b/a' },
      { name: 'B', rating: 8, pricePerNight: 320, bookingUrl: 'https://b/b' },
    ] as any);
    render(<ResultsPage />);
    await waitFor(() => expect(useTripStore.getState().currentTrip!.cities[0].hotel.name).toBe('A'));
    await waitFor(() => expect(useTripStore.getState().currentTrip!.totalCost).toBe(liveTripTotal(useTripStore.getState().currentTrip!)));
    expect(mockedUpdateTrip).not.toHaveBeenCalled();
  });
});

describe('home legs found for a saved trip', () => {
  it('persists the live total with them', async () => {
    const trip = savedPreset();
    trip.cities[0].hotels = [trip.cities[0].hotel, { ...trip.cities[0].hotel, name: 'Second' }];
    trip.origin = { ...trip.origin!, outboundLeg: null, returnLeg: null };
    useTripStore.setState({ currentTrip: trip });
    mockedFetchHomeLegs.mockImplementation(async (p: any) =>
      p.outbound
        ? ({ outboundLeg: leg({}), returnLeg: null, firstCityArrival: '2026-11-30' } as any)
        : ({ outboundLeg: null, returnLeg: leg({ originAirport: 'PAR', destAirport: 'JFK', departDate: '2026-12-02' }) } as any),
    );
    render(<ResultsPage />);
    await waitFor(() => expect(useTripStore.getState().currentTrip!.origin?.returnLeg).toBeTruthy());
    const settled = useTripStore.getState().currentTrip!;
    await waitFor(() =>
      expect(mockedUpdateTrip).toHaveBeenCalledWith('c6961a4e-saved', { totalCost: liveTripTotal(settled) }),
    );
  });
});
