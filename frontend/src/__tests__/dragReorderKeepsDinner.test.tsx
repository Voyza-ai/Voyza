import './mocks';
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildCity, buildTrip } from './fixtures';
import { fetchHomeLegs, searchHotels, compareLeg } from '@/lib/api';
import type { City, ScheduledEvent, Trip } from '@/lib/types';

/**
 * Dragging a city to a new place on the flowchart (results page restructure)
 * with a dinner plan on the trip.
 *
 * Live (2026-11-17): London Jan 12–16 → Paris Jan 16–19 with dinner on Paris's
 * 2nd night (Jan 17); Paris dragged first → Paris Jan 12–15. The store's sync
 * put the dinner on Jan 13 (Paris's 2nd night), then the drag handler cleared
 * the flight from home on a copy of the trip taken BEFORE that sync, putting
 * the old schedule back; the re-sync no longer knew the stay had moved and
 * sent the dinner to the nearest date, Jan 14 (Paris's 3rd night).
 */

let flowchartProps: any = null;
jest.mock('@/components/results/Flowchart', () => ({
  __esModule: true,
  default: (props: any) => {
    flowchartProps = props;
    return null;
  },
}));

// eslint-disable-next-line import/first
import ResultsPage from '@/app/results/page';

const mockedFetchHomeLegs = fetchHomeLegs as jest.MockedFunction<typeof fetchHomeLegs>;
const mockedSearchHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;
const mockedCompareLeg = compareLeg as jest.MockedFunction<typeof compareLeg>;

const dinner = (date: string): ScheduledEvent => ({
  id: 'dinner-1',
  title: 'Septime',
  startTime: '19:30',
  endTime: '21:30',
  category: 'restaurant',
  notes: 'Modern French · $$$',
  dinner: {
    restaurant: 'Septime',
    city: 'Paris',
    partySize: 2,
    status: 'not_booked',
    reserveUrl: 'https://www.google.com/maps/search/?api=1&query=Septime%2C%20Paris',
    reserveVia: 'Google Maps',
  },
} as any);

function londonThenParis(): Trip {
  return buildTrip({
    title: 'London → Paris',
    travelers: 2,
    savings: 0,
    totalCost: 0,
    returnToHome: true,
    cities: [
      buildCity({ name: 'London', dates: { arrival: '2027-01-12', departure: '2027-01-16' } }),
      {
        ...buildCity({ name: 'Paris', dates: { arrival: '2027-01-16', departure: '2027-01-19' } }),
        schedule: { '2027-01-16': [], '2027-01-17': [dinner('2027-01-17')], '2027-01-18': [] },
      } as City,
    ],
    origin: {
      city: 'New York',
      airports: ['JFK'],
      returnAirports: ['JFK'],
      outboundLeg: { originAirport: 'JFK', destAirport: 'LON', price: 440, currency: 'USD', durationMinutes: 480, operator: 'AA', carrierCode: 'AA', departTime: '08:30', arriveTime: '21:30', departDate: '2027-01-12', stops: 0, bookingUrl: null } as any,
      returnLeg: { originAirport: 'PAR', destAirport: 'JFK', price: 430, currency: 'USD', durationMinutes: 500, operator: 'AA', carrierCode: 'AA', departTime: '13:00', arriveTime: '15:30', departDate: '2027-01-19', stops: 0, bookingUrl: null } as any,
    } as any,
  });
}

const parisDinners = () => {
  const paris = useTripStore.getState().currentTrip!.cities.find((c) => c.name === 'Paris')!;
  return Object.entries(paris.schedule ?? {}).flatMap(([d, es]) => es.filter((e) => e.dinner).map(() => d));
};

beforeEach(() => {
  jest.clearAllMocks();
  flowchartProps = null;
  mockedSearchHotels.mockResolvedValue([] as any);
  mockedFetchHomeLegs.mockImplementation(() => new Promise(() => {}));
  mockedCompareLeg.mockImplementation(() => new Promise(() => {}));
  useTripStore.setState({ currentTrip: null, priceMode: 'total', restoredFromSession: false });
});

it('Paris dragged first: its stay moves to Jan 12–15 and the dinner stays on its 2nd night (Jan 13)', async () => {
  useTripStore.setState({ currentTrip: londonThenParis() });
  render(<ResultsPage />);
  await waitFor(() => expect(flowchartProps?.onReorder).toBeDefined());
  const [london, paris] = useTripStore.getState().currentTrip!.cities;
  await act(async () => {
    flowchartProps.onReorder([paris, london]);
  });
  const t = useTripStore.getState().currentTrip!;
  expect(t.cities.map((c) => `${c.name} ${c.dates.arrival}`)).toEqual(['Paris 2027-01-12', 'London 2027-01-15']);
  expect(parisDinners()).toEqual(['2027-01-13']);
});
