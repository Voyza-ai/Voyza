/**
 * The first city's ARRIVE and the last city's DEPART read the home flights.
 *
 * In an assembled trip `cities[0].transportIn` and `cities[last].transportOut`
 * are empty placeholders — the flights from and back home live on
 * `trip.origin.outboundLeg` / `returnLeg`. The city guide showed the first
 * city's ARRIVE as "— · Dec 21 —" (5 production trips), and the Calendar's
 * first day said just "arrive" while every other travel day had times.
 */
import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import CalendarView from '@/components/results/CalendarView';
import { effectiveTransportIn, effectiveTransportOut } from '@/lib/cityLegs';
import type { City, HomeLeg, Transport, Trip } from '@/lib/types';

const placeholder: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

const leg = (over: Partial<HomeLeg>): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'CDG',
  price: 600,
  currency: 'USD',
  durationMinutes: 450,
  operator: 'Air France',
  carrierCode: 'AF',
  departTime: '08:05',
  arriveTime: '21:20',
  departDate: '2026-12-21',
  arriveDate: '2026-12-21',
  stops: 0,
  bookingUrl: null,
  ...over,
});

const train = (from: string, to: string, dep: string, arr: string, date: string): Transport => ({
  mode: 'train',
  operator: 'Eurostar',
  duration: '1h 22m',
  price: 60,
  from,
  to,
  departTime: dep,
  arriveTime: arr,
  departDate: date,
  fromStation: `${from} station`,
  toStation: `${to} station`,
});

const city = (name: string, arrival: string, departure: string, i: number, tin: Transport, tout: Transport): City =>
  ({
    name,
    country: '',
    dates: { arrival, departure },
    transportIn: tin,
    transportOut: tout,
    hotel: { name: 'Hotel', rating: 4, pricePerNight: 100, area: '' },
    hotels: [{ name: 'Hotel', rating: 4, pricePerNight: 100, area: '' }],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
    colorIndex: i,
  }) as City;

function tripWith(origin: Trip['origin'] | undefined): Trip {
  const pb = train('Paris', 'Brussels', '10:13', '11:35', '2026-12-24');
  const ba = train('Brussels', 'Amsterdam', '12:52', '14:41', '2026-12-26');
  return {
    id: 't-arrival',
    title: 'Paris · Brussels · Amsterdam',
    status: 'planning',
    totalCost: 0,
    savings: 0,
    travelers: 1,
    cities: [
      city('Paris', '2026-12-21', '2026-12-24', 0, placeholder, pb),
      city('Brussels', '2026-12-24', '2026-12-26', 1, pb, ba),
      city('Amsterdam', '2026-12-26', '2026-12-28', 2, ba, placeholder),
    ],
    savingsTips: [],
    origin,
    returnToHome: !!origin?.returnLeg,
  } as Trip;
}

const homeTrip = () =>
  tripWith({
    city: 'New York',
    airports: ['JFK'],
    outboundLeg: leg({}),
    returnLeg: leg({
      originAirport: 'AMS',
      destAirport: 'JFK',
      operator: 'KLM',
      departTime: '13:45',
      arriveTime: '16:10',
      departDate: '2026-12-28',
      arriveDate: '2026-12-28',
    }),
  });

const nav = { onClose: jest.fn(), onPrev: jest.fn(), onNext: jest.fn() };

describe('effectiveTransportIn / effectiveTransportOut', () => {
  it('first city arrives on the outbound home flight', () => {
    const t = effectiveTransportIn(homeTrip(), 0);
    expect(t).toMatchObject({ mode: 'flight', arriveTime: '21:20', departTime: '08:05', toStation: 'CDG', operator: 'Air France' });
  });

  it('last city departs on the return home flight', () => {
    const t = effectiveTransportOut(homeTrip(), 2);
    expect(t).toMatchObject({ mode: 'flight', departTime: '13:45', fromStation: 'AMS', operator: 'KLM' });
  });

  it('middle legs are the city legs, untouched', () => {
    const trip = homeTrip();
    expect(effectiveTransportIn(trip, 1)).toBe(trip.cities[1].transportIn);
    expect(effectiveTransportOut(trip, 0)).toBe(trip.cities[0].transportOut);
    expect(effectiveTransportOut(trip, 1)).toBe(trip.cities[1].transportOut);
    expect(effectiveTransportIn(trip, 2)).toBe(trip.cities[2].transportIn);
  });

  it('falls back to the placeholder when the trip has no home anchor', () => {
    const trip = tripWith(undefined);
    expect(effectiveTransportIn(trip, 0)).toBe(trip.cities[0].transportIn);
    expect(effectiveTransportOut(trip, 2)).toBe(trip.cities[2].transportOut);
  });
});

// The guide shows only the arrive and depart DATES (stacked under its
// arrows); the times and airports are on the flowchart. Which transport
// each date comes from is pinned by the effectiveTransportIn/Out tests above.
describe('CityDetailPanel arrive/depart dates', () => {
  beforeEach(() => useTripStore.setState({ currentTrip: homeTrip(), priceMode: 'total' }));
  const short = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  it.each([0, 1, 2])('city %i: Arr is its first day, Dep its last', (i) => {
    const t = homeTrip();
    render(<CityDetailPanel trip={t} cityIndex={i} {...nav} />);
    const dates = screen.getByTestId('travel-dates').textContent ?? '';
    expect(dates).toContain(`Arr${short(t.cities[i].dates.arrival)}`);
    expect(dates).toContain(`Dep${short(t.cities[i].dates.departure)}`);
  });

  // Each date carries the time of the transport the trip actually uses: the
  // home flights at either end, the trains in between.
  it("the first city's Arr time is the outbound flight's landing, its Dep the train", () => {
    render(<CityDetailPanel trip={homeTrip()} cityIndex={0} {...nav} />);
    const dates = screen.getByTestId('travel-dates').textContent ?? '';
    expect(dates).toMatch(/Arr.*·21:20/);
    expect(dates).toMatch(/Dep.*·10:13/);
  });

  it("the last city's Dep time is the return flight's take-off", () => {
    render(<CityDetailPanel trip={homeTrip()} cityIndex={2} {...nav} />);
    const dates = screen.getByTestId('travel-dates').textContent ?? '';
    expect(dates).toMatch(/Arr.*·14:41/);
    expect(dates).toMatch(/Dep.*·13:45/);
  });
});

describe('CalendarView first and last travel days', () => {
  it("first day shows the outbound's times, not a bare 'arrive'", () => {
    const trip = homeTrip();
    useTripStore.setState({ currentTrip: trip });
    render(<CalendarView trip={trip} />);
    expect(screen.getByText('08:05→21:20')).toBeInTheDocument();
    expect(screen.queryByText('arrive')).toBeNull();
    // Middle arrivals unchanged.
    expect(screen.getByText('10:13→11:35')).toBeInTheDocument();
    // Flying home: the return's depart time on the last day.
    expect(screen.getByText('13:45')).toBeInTheDocument();
  });
});
