import './mocks';
import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildCity, buildTrip } from './fixtures';
import {
  compareLeg,
  fetchHomeLegs,
  getCanvasSession,
  getCanvasSuggestions,
  planChat,
  searchHotels,
} from '@/lib/api';
import { liveTripTotal } from '@/lib/tripTotals';
import ResultsPage from '@/app/results/page';
import CanvasPage from '@/app/canvas/[tripId]/page';
import type { HomeLeg, Transport, Trip } from '@/lib/types';

/**
 * Accepting an AI date change re-prices what it moved (item 2).
 *
 * A pin or shift accepted from the chat only rewrote the cities' dates: every
 * flight kept the day and fare it was priced for, every hotel its old nights'
 * price, and the header added them up as the new trip's total. Pinning Zurich
 * to Jan 14–16 on the owner's trip moved all three stays a day later; the
 * Paris → Zurich card still said Jan 13, and the outbound still left Jan 10
 * for a Paris stay that now started Jan 12.
 *
 * Now each leg whose day changed is re-priced on its new day, each stay whose
 * dates changed has its hotels re-searched, the outbound is re-searched from
 * the trip's start moved by the same days (landing rule applied), and the
 * return on the last stay's new departure.
 */

const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;
const mockedCompareLeg = compareLeg as jest.MockedFunction<typeof compareLeg>;
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
const OUT_JAN10 = leg({});
const OUT_JAN11 = leg({ departDate: '2027-01-11', arriveDate: '2027-01-12', price: 1210 });
const BACK_JAN17 = leg({ originAirport: 'LON', destAirport: 'JFK', departDate: '2027-01-17', arriveDate: '2027-01-17', departTime: '12:23', arriveTime: '15:24', price: 1314 });
const BACK_JAN18 = { ...BACK_JAN17, departDate: '2027-01-18', arriveDate: '2027-01-18', price: 1290 };

const flight = (from: string, to: string, price: number, date: string): Transport => ({
  mode: 'flight',
  operator: 'Swiss',
  duration: '1h 20m',
  price,
  from,
  to,
  departTime: '09:00',
  arriveTime: '10:20',
  departDate: date,
});

function ownerTrip(): Trip {
  const pz = flight('Paris', 'Zurich', 281, '2027-01-13');
  const zl = flight('Zurich', 'London', 327, '2027-01-15');
  const stay = (name: string, arrival: string, departure: string, ppn: number, out: Transport | null, inn: Transport | null) =>
    buildCity({
      name,
      dates: { arrival, departure },
      hotels: [
        { name: `${name} Old`, rating: 8, pricePerNight: ppn, area: '' },
        { name: `${name} Other`, rating: 7, pricePerNight: ppn + 50, area: '' },
      ],
      hotel: { name: `${name} Old`, rating: 8, pricePerNight: ppn, area: '' },
      selectedHotelIndex: 0,
      transportOut: out ?? { mode: 'flight', operator: '', duration: '', price: 0 },
      transportIn: inn ?? { mode: 'flight', operator: '', duration: '', price: 0 },
    });
  const t = buildTrip({
    title: 'Paris → Zurich → London',
    travelers: 6,
    savings: 0,
    returnToHome: true,
    dateShiftSuggestion: undefined,
    cities: [
      stay('Paris', '2027-01-11', '2027-01-13', 400, pz, null),
      stay('Zurich', '2027-01-13', '2027-01-15', 250, zl, pz),
      stay('London', '2027-01-15', '2027-01-17', 330, null, zl),
    ],
    origin: { city: 'New York', airports: ['JFK'], outboundLeg: OUT_JAN10, returnLeg: BACK_JAN17 },
  } as any);
  return { ...t, totalCost: liveTripTotal(t) };
}

/** What the server answers for "pin Zurich to Jan 14–16": every stay a day later. */
function pinProposal(trip: Trip) {
  const moved = JSON.parse(JSON.stringify(trip)) as Trip;
  const dates = [
    ['2027-01-12', '2027-01-14'],
    ['2027-01-14', '2027-01-16'],
    ['2027-01-16', '2027-01-18'],
  ];
  moved.cities = moved.cities.map((c, i) => ({ ...c, dates: { arrival: dates[i][0], departure: dates[i][1] } }));
  moved.constraints = { pinned_cities: [{ city: 'Zurich', arrival: '2027-01-14', departure: '2027-01-16' }] };
  return {
    type: 'proposal',
    reply: 'Pinning Zurich to Jan 14 – Jan 16.',
    proposal: {
      kind: 'date_shift',
      toolName: 'pin_city_dates',
      toolInput: { city: 'Zurich', arrival: '2027-01-14', departure: '2027-01-16' },
      diff: [{ city: 'Zurich', oldArrival: '2027-01-13', newArrival: '2027-01-14', oldDeparture: '2027-01-15', newDeparture: '2027-01-16' }],
      proposedConstraints: moved.constraints,
      proposedTrip: moved,
    },
  } as any;
}

const rows = (city: string, ppn: number) =>
  [
    { name: `${city} New`, rating: 8.8, pricePerNight: ppn, bookingUrl: `https://b/${city}` },
    { name: `${city} Old`, rating: 8, pricePerNight: ppn + 20, bookingUrl: `https://b/${city}2` },
  ] as any;

function mockSearches() {
  mockedCompareLeg.mockImplementation(async (p: any) => ({
    flightOption: {
      id: 'x',
      price: p.origin === 'Paris' ? 300 : 352,
      currency: 'USD',
      departure: `${p.date}T08:00:00`,
      arrival: `${p.date}T09:15:00`,
      durationMinutes: 75,
      stops: 0,
      carrier: 'Swiss',
      carrierCode: 'LX',
      bookingUrl: '',
    },
    trainOption: null,
    cheapest: 'flight',
    fastest: 'flight',
    recommendation: 'flight',
    priceDifference: 0,
    timeDifference: 0,
  }));
  mockedFetchHomeLegs.mockImplementation(async (p: any) =>
    p.outbound
      ? ({ outboundLeg: OUT_JAN11, returnLeg: null, firstCityArrival: '2027-01-12' } as any)
      : ({ outboundLeg: null, returnLeg: BACK_JAN18 } as any),
  );
  mockedSearchHotels.mockImplementation(async (p: any) => rows(p.city, p.city === 'Paris' ? 380 : p.city === 'Zurich' ? 240 : 310));
}

async function sendChat(text: string) {
  const input = await screen.findByPlaceholderText('Ask about your trip...');
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.submit(input.closest('form')!);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: null, priceMode: 'total', restoredFromSession: false });
});

describe('results page: an accepted AI date change re-prices legs and hotels', () => {
  it('re-prices every moved leg and home flight and re-searches every moved stay', async () => {
    const consoleError = jest.spyOn(console, 'error');
    const trip = ownerTrip();
    useTripStore.setState({ currentTrip: trip });
    mockSearches();
    render(<ResultsPage />);
    mockedPlanChat.mockResolvedValueOnce(pinProposal(trip));
    await sendChat('pin Zurich to 2027-01-14 to 2027-01-16');
    await act(async () => {
      fireEvent.click(await screen.findByText('Accept'));
    });

    await waitFor(() => expect(mockedCompareLeg).toHaveBeenCalledTimes(2));
    expect(mockedCompareLeg.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        { origin: 'Paris', destination: 'Zurich', date: '2027-01-14', travelers: 6 },
        { origin: 'Zurich', destination: 'London', date: '2027-01-16', travelers: 6 },
      ]),
    );
    await waitFor(() => expect(mockedFetchHomeLegs).toHaveBeenCalledTimes(2));
    const calls = mockedFetchHomeLegs.mock.calls.map((c) => c[0] as any);
    const out = calls.find((p) => p.outbound);
    const ret = calls.find((p) => p.returnToHome);
    // The trip now leaves a day later: Jan 11, landing the 12th.
    expect(out.startDate).toBe('2027-01-11');
    expect(out.firstCityDeparture).toBe('2027-01-14');
    expect(ret.endDate).toBe('2027-01-18');
    await waitFor(() => expect(mockedSearchHotels).toHaveBeenCalledTimes(3));
    expect(mockedSearchHotels.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        { city: 'Paris', checkin: '2027-01-12', checkout: '2027-01-14', adults: 6 },
        { city: 'Zurich', checkin: '2027-01-14', checkout: '2027-01-16', adults: 6 },
        { city: 'London', checkin: '2027-01-16', checkout: '2027-01-18', adults: 6 },
      ]),
    );

    // Everything on the trip is priced for the new dates.
    await waitFor(() => {
      const t = useTripStore.getState().currentTrip!;
      expect(t.origin?.outboundLeg?.departDate).toBe('2027-01-11');
      expect(t.origin?.returnLeg?.departDate).toBe('2027-01-18');
      expect(t.cities[0].transportOut).toMatchObject({ price: 300, departDate: '2027-01-14' });
      expect(t.cities[1].transportIn).toMatchObject({ price: 300, departDate: '2027-01-14' });
      expect(t.cities[1].transportOut).toMatchObject({ price: 352, departDate: '2027-01-16' });
      expect(t.cities.map((c) => c.hotel.pricePerNight)).toEqual([400, 260, 330]);
    });
    // Accepting applies the trip from the click, not from inside a render
    // (harness: "Cannot update a component (ResultsPageInner) while rendering
    // a different component (AIChatPanel)").
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/Cannot update a component/);
    consoleError.mockRestore();
  });

  it('the header holds the last settled total until every search lands, then shows the new one', async () => {
    const trip = ownerTrip();
    useTripStore.setState({ currentTrip: trip });
    mockSearches();
    let releaseHotels!: () => void;
    const hotelsHeld = new Promise<void>((r) => (releaseHotels = r));
    mockedSearchHotels.mockImplementation(async (p: any) => {
      await hotelsHeld;
      return rows(p.city, 100); // far cheaper: must still not read as a saving
    });
    render(<ResultsPage />);
    const perPersonLine = () => screen.getByText(/\/person/).textContent;
    const before = perPersonLine();
    mockedPlanChat.mockResolvedValueOnce(pinProposal(trip));
    await sendChat('pin Zurich to 2027-01-14 to 2027-01-16');
    await act(async () => {
      fireEvent.click(await screen.findByText('Accept'));
    });
    // Legs and flights have landed; the hotels have not.
    await waitFor(() => expect(useTripStore.getState().currentTrip!.origin?.returnLeg?.departDate).toBe('2027-01-18'));
    expect(perPersonLine()).toBe(before);
    expect(screen.queryByText('You can save')).not.toBeInTheDocument();

    await act(async () => {
      releaseHotels();
    });
    const settled = useTripStore.getState().currentTrip!;
    await waitFor(() =>
      expect(perPersonLine()).toBe(`$${Math.round(liveTripTotal(useTripStore.getState().currentTrip!) / 6).toLocaleString()} /person`),
    );
    expect(liveTripTotal(useTripStore.getState().currentTrip!)).toBeLessThan(liveTripTotal(trip));
    expect(screen.queryByText('You can save')).not.toBeInTheDocument();
    expect(settled).toBeTruthy();
  });

  it('a leg with nothing on its new day shows the existing "no direct option" card, not the old fare', async () => {
    const trip = ownerTrip();
    useTripStore.setState({ currentTrip: trip });
    mockSearches();
    mockedCompareLeg.mockResolvedValue({ flightOption: null, trainOption: null, recommendation: 'unavailable' } as any);
    render(<ResultsPage />);
    mockedPlanChat.mockResolvedValueOnce(pinProposal(trip));
    await sendChat('pin Zurich to 2027-01-14 to 2027-01-16');
    await act(async () => {
      fireEvent.click(await screen.findByText('Accept'));
    });
    await waitFor(() => expect(useTripStore.getState().currentTrip!.cities[0].transportOut.unavailable).toBe(true));
    expect(useTripStore.getState().currentTrip!.cities[0].transportOut.price).toBe(0);
  });

  it('the date-shift check priced the old dates: its suggestion and "Best price" are dropped', async () => {
    const trip = {
      ...ownerTrip(),
      dateShiftChecked: true,
      dateShiftSuggestion: { dayOffset: -1, newStartDate: '2027-01-09', newTotalCost: 4000, savings: 120 },
    };
    useTripStore.setState({ currentTrip: trip });
    mockSearches();
    render(<ResultsPage />);
    mockedPlanChat.mockResolvedValueOnce(pinProposal(trip));
    await sendChat('pin Zurich to 2027-01-14 to 2027-01-16');
    await act(async () => {
      fireEvent.click(await screen.findByText('Accept'));
    });
    await waitFor(() => {
      const t = useTripStore.getState().currentTrip!;
      expect(t.dateShiftChecked).toBe(false);
      expect(t.dateShiftSuggestion).toBeUndefined();
    });
  });

  it('an answer that moves no date (a leg refresh) re-prices nothing', async () => {
    const trip = ownerTrip();
    useTripStore.setState({ currentTrip: trip });
    mockSearches();
    render(<ResultsPage />);
    mockedPlanChat.mockResolvedValueOnce({ type: 'answer', reply: 'Sure.' } as any);
    await sendChat('why this order?');
    await act(async () => {
      useTripStore.getState().setSelectedHotel(1, 1);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedCompareLeg).not.toHaveBeenCalled();
    expect(mockedSearchHotels).not.toHaveBeenCalled();
    expect(mockedFetchHomeLegs).not.toHaveBeenCalled();
  });
});

describe('canvas: an accepted AI date change re-prices legs and hotels', () => {
  it('re-prices the moved legs and home flights and re-searches the moved stays', async () => {
    const trip = ownerTrip();
    mockedGetSession.mockResolvedValue({
      session: {
        state: {
          trip: { title: 'Owner trip', travelers: 6, origin: trip.origin, returnToHome: true },
          cities: trip.cities,
        },
      },
      role: 'owner',
    } as any);
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] } as any);
    mockSearches();
    render(<CanvasPage />);
    await screen.findByText(/Jan 11 → Jan 13/);

    mockedPlanChat.mockResolvedValueOnce(pinProposal(trip));
    await sendChat('pin Zurich to 2027-01-14 to 2027-01-16');
    await act(async () => {
      fireEvent.click(await screen.findByText('Accept'));
    });

    await waitFor(() =>
      expect(mockedCompareLeg.mock.calls.map((c) => c[0])).toEqual(
        expect.arrayContaining([
          { origin: 'Paris', destination: 'Zurich', date: '2027-01-14', travelers: 6 },
          { origin: 'Zurich', destination: 'London', date: '2027-01-16', travelers: 6 },
        ]),
      ),
    );
    await waitFor(() => {
      const calls = mockedFetchHomeLegs.mock.calls.map((c) => c[0] as any);
      expect(calls.find((p) => p.outbound)?.startDate).toBe('2027-01-11');
      expect(calls.find((p) => p.returnToHome)?.endDate).toBe('2027-01-18');
    });
    await waitFor(() =>
      expect(mockedSearchHotels.mock.calls.map((c) => c[0])).toEqual(
        expect.arrayContaining([
          { city: 'Paris', checkin: '2027-01-12', checkout: '2027-01-14', adults: 6 },
          { city: 'Zurich', checkin: '2027-01-14', checkout: '2027-01-16', adults: 6 },
          { city: 'London', checkin: '2027-01-16', checkout: '2027-01-18', adults: 6 },
        ]),
      ),
    );
  });
});
