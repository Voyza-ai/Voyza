import './mocks';
import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildCity, buildTrip } from './fixtures';
import { fetchHomeLegs, searchHotels, getCanvasSession, getCanvasSuggestions } from '@/lib/api';
import ResultsPage from '@/app/results/page';
import CanvasPage from '@/app/canvas/[tripId]/page';
import type { HomeLeg, Trip } from '@/lib/types';

/**
 * Changing the outbound must re-date the first stay (item 1).
 *
 * The optimizer starts the first stay the day the outbound LANDS: the owner's
 * JFK 19:25 Jan 10 → Paris 12:10 Jan 11 gives Paris Jan 11–13. Three places
 * replace or re-search that flight without re-applying the rule:
 *
 *  (a) the other reading of an ambiguous home city (results page) — searched
 *      from the first stay's arrival, which IS the landing day, so an
 *      overnight trip was searched a day late: harness, Portland → "Portland,
 *      Maine": home-legs startDate 2027-01-11 and the header fell to
 *      "Jan 11 – Jan 17 · 6 nights";
 *  (b) a new home city / airports on the canvas home card — the same search;
 *  (c) an outbound alternative that lands on another day.
 *
 * The fix searches from the trip's start with the first stay's departure, takes
 * the server's `firstCityArrival` (the backend rule), and re-searches the first
 * city's hotels — for the party — when its dates change.
 */

const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;
const mockedSearchHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;
const mockedGetSession = getCanvasSession as jest.MockedFunction<typeof getCanvasSession>;
const mockedGetSuggestions = getCanvasSuggestions as jest.MockedFunction<typeof getCanvasSuggestions>;

const leg = (over: Partial<HomeLeg>): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'PAR',
  price: 1337,
  currency: 'USD',
  durationMinutes: 645,
  operator: 'Icelandair',
  carrierCode: 'FI',
  departTime: '19:25',
  arriveTime: '12:10',
  departDate: '2027-01-10',
  arriveDate: '2027-01-11',
  stops: 1,
  bookingUrl: null,
  ...over,
});
const OVERNIGHT = (over: Partial<HomeLeg> = {}) => leg(over);
const SAME_DAY = (over: Partial<HomeLeg> = {}) =>
  leg({ departTime: '06:30', arriveTime: '20:10', arriveDate: '2027-01-10', ...over });
const BACK = (over: Partial<HomeLeg> = {}) =>
  leg({ originAirport: 'LON', destAirport: 'JFK', departDate: '2027-01-17', arriveDate: '2027-01-17', departTime: '12:23', arriveTime: '15:24', price: 1314, ...over });

const PARIS_ROWS = [
  { name: 'Hôtel A', rating: 8.6, pricePerNight: 400, bookingUrl: 'https://b/a' },
  { name: 'Hôtel B', rating: 8.1, pricePerNight: 320, bookingUrl: 'https://b/b' },
] as any;

function trip(parisArrival: string, origin: Trip['origin'], over: Partial<Trip> = {}): Trip {
  return buildTrip({
    title: 'Paris → Zurich → London',
    travelers: 6,
    savings: 0,
    totalCost: 0,
    returnToHome: true,
    cities: [
      buildCity({ name: 'Paris', dates: { arrival: parisArrival, departure: '2027-01-13' } }),
      buildCity({ name: 'Zurich', dates: { arrival: '2027-01-13', departure: '2027-01-15' } }),
      buildCity({ name: 'London', dates: { arrival: '2027-01-15', departure: '2027-01-17' } }),
    ],
    origin,
    ...over,
  });
}

const paris = () => useTripStore.getState().currentTrip!.cities[0];
const hotelSearchesFor = (city: string) =>
  mockedSearchHotels.mock.calls.map((c) => c[0]).filter((p) => p.city === city);

beforeEach(() => {
  jest.clearAllMocks();
  mockedSearchHotels.mockResolvedValue(PARIS_ROWS);
  useTripStore.setState({ currentTrip: null, priceMode: 'total', restoredFromSession: false });
});

async function chooseOther(label: string) {
  fireEvent.click(screen.getByRole('button', { name: /see the other$/i }));
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
}

describe('(a) the other reading of an ambiguous home city', () => {
  const portland = () =>
    trip(
      '2027-01-11',
      {
        city: 'Portland',
        airports: ['PDX'],
        returnAirports: ['PDX'],
        outboundLeg: OVERNIGHT({ originAirport: 'PDX' }),
        returnLeg: BACK({ destAirport: 'PDX' }),
      },
      {
        originClarification: {
          input: 'Portland',
          reason: 'near-tie',
          candidates: [
            { placeId: 'gn:1', label: 'Portland, Oregon, United States', airports: ['PDX'] },
            { placeId: 'gn:2', label: 'Portland, Maine, United States', airports: ['PWM'] },
          ],
        },
      } as any,
    );

  it('overnight → same-day: searched from the trip start, the stay gains its night back, its hotels are re-searched', async () => {
    useTripStore.setState({ currentTrip: portland() });
    mockedFetchHomeLegs.mockImplementation(async (p: any) =>
      p.outbound
        ? { outboundLeg: SAME_DAY({ originAirport: 'PWM' }), returnLeg: null, firstCityArrival: '2027-01-10' }
        : { outboundLeg: null, returnLeg: BACK({ destAirport: 'PWM' }) },
    );
    render(<ResultsPage />);
    await chooseOther('Portland, Maine, United States');

    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalledTimes(2));
    const out = mockedFetchHomeLegs.mock.calls.map((c) => c[0] as any).find((p) => p.outbound);
    // Before: startDate 2027-01-11 (the landing day) and no firstCityDeparture.
    expect(out.startDate).toBe('2027-01-10');
    expect(out.firstCityDeparture).toBe('2027-01-13');

    await waitFor(() => expect(paris().dates).toEqual({ arrival: '2027-01-10', departure: '2027-01-13' }));
    await waitFor(() =>
      expect(hotelSearchesFor('Paris')).toContainEqual({ city: 'Paris', checkin: '2027-01-10', checkout: '2027-01-13', adults: 6 }),
    );
    await waitFor(() => expect(paris().hotels.map((h) => h.name)).toEqual(['Hôtel A', 'Hôtel B']));
    await waitFor(() => expect(screen.getByText(/Jan 10\s*–\s*Jan 17/)).toBeInTheDocument());
    expect(screen.getByText(/7 nights/)).toBeInTheDocument();
  });

  it('same-day → overnight: the stay starts the day the new flight lands', async () => {
    const london = trip(
      '2027-01-10',
      {
        city: 'London',
        airports: ['LHR'],
        returnAirports: ['LHR'],
        outboundLeg: SAME_DAY({ originAirport: 'LHR', departTime: '09:20', arriveTime: '11:38', price: 480 }),
        returnLeg: BACK({ destAirport: 'LHR' }),
      },
      {
        originClarification: {
          input: 'London',
          reason: 'multi-country',
          candidates: [
            { placeId: 'gn:3', label: 'London, England, United Kingdom', airports: ['LHR'] },
            { placeId: 'gn:4', label: 'London, Ontario, Canada', airports: ['YXU'] },
          ],
        },
      } as any,
    );
    useTripStore.setState({ currentTrip: london });
    mockedFetchHomeLegs.mockImplementation(async (p: any) =>
      p.outbound
        ? { outboundLeg: OVERNIGHT({ originAirport: 'YXU' }), returnLeg: null, firstCityArrival: '2027-01-11' }
        : { outboundLeg: null, returnLeg: BACK({ destAirport: 'YXU' }) },
    );
    render(<ResultsPage />);
    await chooseOther('London, Ontario, Canada');

    await waitFor(() => expect(paris().dates.arrival).toBe('2027-01-11'));
    const out = mockedFetchHomeLegs.mock.calls.map((c) => c[0] as any).find((p) => p.outbound);
    expect(out.startDate).toBe('2027-01-10');
    await waitFor(() =>
      expect(hotelSearchesFor('Paris')).toContainEqual({ city: 'Paris', checkin: '2027-01-11', checkout: '2027-01-13', adults: 6 }),
    );
    // Still a Jan 10 – 17 trip: it leaves home on the 10th.
    await waitFor(() => expect(screen.getByText(/Jan 10\s*–\s*Jan 17/)).toBeInTheDocument());
  });
});

describe('(c) an outbound alternative that lands on another day', () => {
  it("re-dates the first stay and re-searches that city's hotels for the party", async () => {
    const t = trip('2027-01-11', {
      city: 'New York',
      airports: ['JFK'],
      outboundLeg: { ...OVERNIGHT(), alternatives: [SAME_DAY({ operator: 'Delta', price: 1500 })] },
      returnLeg: BACK(),
    });
    useTripStore.setState({ currentTrip: t });
    render(<ResultsPage />);
    expect(mockedSearchHotels).not.toHaveBeenCalled();

    await act(async () => {
      useTripStore.getState().setHomeLegAlternative('outbound', 0);
    });
    expect(paris().dates.arrival).toBe('2027-01-10');
    await waitFor(() =>
      expect(hotelSearchesFor('Paris')).toEqual([{ city: 'Paris', checkin: '2027-01-10', checkout: '2027-01-13', adults: 6 }]),
    );
    await waitFor(() => expect(paris().hotels[0].name).toBe('Hôtel A'));
    // No other city moved, so no other city is searched.
    expect(mockedSearchHotels).toHaveBeenCalledTimes(1);
  });
});

describe('(b) a new home city on the canvas home card', () => {
  function openCanvas(origin: any, parisArrival: string) {
    const c = trip(parisArrival, origin).cities;
    mockedGetSession.mockResolvedValue({
      session: { state: { trip: { title: 'Owner trip', travelers: 6, origin, returnToHome: true }, cities: c } },
      role: 'owner',
    } as any);
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] } as any);
    render(<CanvasPage />);
  }

  async function changeHomeTo(city: string) {
    fireEvent.click(await screen.findByTitle('Edit home card'));
    fireEvent.change(screen.getByPlaceholderText('e.g. New York'), { target: { value: city } });
    await act(async () => {
      fireEvent.click(screen.getByText('Apply'));
    });
  }

  it('New York (overnight) → London (same day): searched from Jan 10, Paris gains Jan 10, its hotels re-searched', async () => {
    openCanvas({ city: 'New York', airports: ['JFK'], outboundLeg: OVERNIGHT(), returnLeg: BACK() }, '2027-01-11');
    mockedFetchHomeLegs.mockResolvedValue({
      outboundLeg: SAME_DAY({ originAirport: 'LHR', departTime: '09:20', arriveTime: '11:38', price: 480 }),
      returnLeg: null,
      firstCityArrival: '2027-01-10',
    } as any);
    await screen.findByText(/Jan 11 → Jan 13/);
    await changeHomeTo('London');

    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalled());
    const p = mockedFetchHomeLegs.mock.calls[0][0] as any;
    // Before: startDate 2027-01-11 and no firstCityDeparture.
    expect(p.startDate).toBe('2027-01-10');
    expect(p.firstCityDeparture).toBe('2027-01-13');
    await screen.findByText(/Jan 10 → Jan 13/);
    await waitFor(() =>
      expect(hotelSearchesFor('Paris')).toContainEqual({ city: 'Paris', checkin: '2027-01-10', checkout: '2027-01-13', adults: 6 }),
    );
  });

  it('London (same day) → New York (overnight): Paris starts on Jan 11', async () => {
    openCanvas(
      { city: 'London', airports: ['LHR'], outboundLeg: SAME_DAY({ originAirport: 'LHR' }), returnLeg: BACK() },
      '2027-01-10',
    );
    mockedFetchHomeLegs.mockResolvedValue({ outboundLeg: OVERNIGHT(), returnLeg: null, firstCityArrival: '2027-01-11' } as any);
    await screen.findByText(/Jan 10 → Jan 13/);
    await changeHomeTo('New York');

    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalled());
    expect((mockedFetchHomeLegs.mock.calls[0][0] as any).startDate).toBe('2027-01-10');
    await screen.findByText(/Jan 11 → Jan 13/);
    await waitFor(() =>
      expect(hotelSearchesFor('Paris')).toContainEqual({ city: 'Paris', checkin: '2027-01-11', checkout: '2027-01-13', adults: 6 }),
    );
  });
});
