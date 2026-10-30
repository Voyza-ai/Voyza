/**
 * F2 — the day an overnight outbound leaves home is a day of the trip.
 *
 * Regression from B1 (the first stay starts the day the flight LANDS).
 * Integrated run, 2026-10-30 (owner trip, JFK 19:25 Jan 10 → Paris 12:10
 * Jan 11): before B1 the Schedule showed Jan 10 with "Head to JFK 17:25",
 * the flight at 19:25 and — wrongly — Paris plans. After B1, Jan 10 was gone
 * from the Schedule and the Calendar altogether; the Schedule started on
 * Jan 11 with "Arrive at PAR". Jan 10 must exist, with the home side of the
 * trip only: head to the airport, the flight, nothing in Paris.
 */
import './mocks';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import {
  buildCityScheduleFromSuggestions,
  buildDefaultSchedule,
} from '@/lib/dayScheduleDefaults';
import ScheduleView from '@/components/results/ScheduleView';
import CalendarView from '@/components/results/CalendarView';
import type { City, HomeLeg, ScheduledEvent, Transport, Trip } from '@/lib/types';
import type { ActivitySuggestion, RestaurantSuggestion } from '@/lib/api';
import { buildTrip } from './fixtures';

const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

/** The owner's outbound (overnight) — or a same-day one with `sameDay`. */
const outbound = (sameDay = false): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'PAR',
  price: 1337,
  currency: 'USD',
  durationMinutes: 645,
  operator: 'Icelandair',
  carrierCode: 'FI',
  departTime: sameDay ? '07:15' : '19:25',
  arriveTime: sameDay ? '19:40' : '12:10',
  departDate: '2027-01-10',
  arriveDate: sameDay ? '2027-01-10' : '2027-01-11',
  stops: 1,
  bookingUrl: null,
});

const city = (name: string, arrival: string, departure: string, colorIndex: number): City =>
  ({
    name,
    country: '',
    dates: { arrival, departure },
    transportIn: emptyTransport,
    transportOut: { mode: 'flight', operator: 'Swiss', duration: '1h', price: 280, departTime: '09:17', arriveTime: '10:30' },
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    hotels: [],
    selectedHotelIndex: 0,
    activities: ['Louvre', 'Orsay'],
    restaurants: [{ name: 'Le Comptoir', cuisine: 'French', priceRange: '$$' }],
    vibes: [],
    colorIndex,
  }) as City;

/** Paris → Zurich, dated the way the optimizer dates it now. */
function ownerTrip(sameDay = false): Trip {
  const parisArrival = sameDay ? '2027-01-10' : '2027-01-11';
  return {
    ...buildTrip(),
    title: 'Paris → Zurich',
    cities: [
      city('Paris', parisArrival, '2027-01-13', 0),
      { ...city('Zurich', '2027-01-13', '2027-01-17', 1), transportOut: emptyTransport },
    ],
    origin: { city: 'New York', airports: ['JFK'], outboundLeg: outbound(sameDay), returnLeg: null },
  };
}

const acts: ActivitySuggestion[] = [
  { name: 'Louvre', timeOfDay: 'morning', durationHours: 3, category: 'museum', reason: '' },
  { name: 'Marais walk', timeOfDay: 'afternoon', durationHours: 2, category: 'experience', reason: '' },
  { name: 'Seine cruise', timeOfDay: 'evening', durationHours: 2, category: 'experience', reason: '' },
  { name: 'Orsay', timeOfDay: 'morning', durationHours: 2, category: 'museum', reason: '' },
];
const rests: RestaurantSuggestion[] = [
  { name: 'Cafe A', cuisine: 'French', priceRange: '$$', mealType: 'breakfast', reason: '' },
  { name: 'Bistro B', cuisine: 'French', priceRange: '$$', mealType: 'lunch', reason: '' },
  { name: 'Brasserie C', cuisine: 'French', priceRange: '$$', mealType: 'dinner', reason: '' },
];

const shape = (events: ScheduledEvent[] = []) =>
  events.map((e) => `${e.startTime}-${e.endTime} ${e.title}`);

describe('scheduler — the home departure day', () => {
  it('trip creation: Jan 10 holds the head-to and the flight, nothing in Paris', () => {
    const trip = ownerTrip();
    const { schedule } = buildCityScheduleFromSuggestions(acts, rests, trip.cities[0], 0, trip);

    // Before (cd4dbb8): schedule['2027-01-10'] was undefined.
    expect(shape(schedule['2027-01-10'])).toEqual([
      '17:25-19:25 Head to JFK',
      '19:25-12:10 Flight JFK → PAR',
    ]);
    // The landing day is unchanged: the arrival marker, then Paris from 13:10.
    expect(schedule['2027-01-11'][0].title).toBe('Arrive at PAR');
    expect(schedule['2027-01-11'].some((e) => e.title.startsWith('Head to'))).toBe(false);
  });

  it('spends none of the city’s suggestions on the departure day', () => {
    const trip = ownerTrip();
    const withDay = buildCityScheduleFromSuggestions(acts, rests, trip.cities[0], 0, trip);
    // The same outbound with no departDate: the landing day gets the same
    // "Arrive at" block, and there is no departure day — what B1 scheduled.
    const leg = { ...trip.origin!.outboundLeg!, departDate: '' };
    const noDay = { ...trip, origin: { ...trip.origin!, outboundLeg: leg } };
    const stayOnly = buildCityScheduleFromSuggestions(acts, rests, trip.cities[0], 0, noDay);
    expect(stayOnly.schedule['2027-01-10']).toBeUndefined();
    for (const day of ['2027-01-11', '2027-01-12']) {
      expect(shape(withDay.schedule[day])).toEqual(shape(stayOnly.schedule[day]));
    }
    expect(withDay.unscheduled).toEqual(stayOnly.unscheduled);
  });

  it('lazy build (saved trips, the day planner): Jan 10 is the head-to and the flight', () => {
    const trip = ownerTrip();
    expect(shape(buildDefaultSchedule(trip.cities[0], '2027-01-10', trip, 0))).toEqual([
      '17:25-19:25 Head to JFK',
      '19:25-12:10 Flight JFK → PAR',
    ]);
  });

  it('a same-day arrival is scheduled exactly as before', () => {
    const trip = ownerTrip(true);
    const { schedule } = buildCityScheduleFromSuggestions(acts, rests, trip.cities[0], 0, trip);
    // Head-to, flight and arrival on the one day, and no extra day before it.
    expect(Object.keys(schedule).sort()[0]).toBe('2027-01-10');
    expect(shape(schedule['2027-01-10']).slice(0, 3)).toEqual([
      '05:15-07:15 Head to JFK',
      '07:15-19:40 Flight JFK → PAR',
      '19:40-19:55 Arrive at PAR',
    ]);
  });
});

/** Renders a view on the store's trip, so the views' own schedule writes land. */
function onStore(trip: Trip, View: typeof ScheduleView | typeof CalendarView) {
  useTripStore.setState({ currentTrip: trip });
  function Live() {
    const t = useTripStore((s) => s.currentTrip);
    return t ? <View trip={t} /> : null;
  }
  return render(<Live />);
}

describe('ScheduleView — the home departure day', () => {
  it('has a Jan 10 travel-day card with the head-to and the flight', () => {
    onStore(ownerTrip(), ScheduleView);
    // Before: 7 days, starting Jan 11.
    expect(screen.getByText(/^8 days ·/)).toBeInTheDocument();
    const jan10 = screen.getByText('Jan 10').closest('[class*="w-[340px]"]') as HTMLElement;
    expect(within(jan10).getByText('Travel day')).toBeInTheDocument();
    expect(within(jan10).getByText('Head to JFK')).toBeInTheDocument();
    expect(within(jan10).getByText('Flight JFK → PAR')).toBeInTheDocument();
    expect(within(jan10).queryByText('Louvre')).toBeNull();
    expect(within(jan10).queryByText('Arrive at PAR')).toBeNull();
  });

  it('a same-day arrival keeps its first card on the city, as before', () => {
    onStore(ownerTrip(true), ScheduleView);
    expect(screen.getByText(/^8 days ·/)).toBeInTheDocument();
    expect(screen.queryByText('Travel day')).toBeNull();
    const jan10 = screen.getByText('Jan 10').closest('[class*="w-[340px]"]') as HTMLElement;
    expect(within(jan10).getByText('Paris')).toBeInTheDocument();
    expect(within(jan10).getByText('Arrive at PAR')).toBeInTheDocument();
  });
});

describe('CalendarView — the home departure day', () => {
  it('marks Jan 10 as the departure, and opens its plan: the head-to and the flight', () => {
    onStore(ownerTrip(), CalendarView);
    // The departure-only cell: the outbound's time, no city.
    expect(screen.getByText('19:25')).toBeInTheDocument();
    fireEvent.click(screen.getByText('19:25'));
    // Before: nothing opened (no city, no departing city on Jan 10).
    expect(screen.getByText(/Day Planner/)).toBeInTheDocument();
    expect(screen.getAllByText('Head to JFK').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Flight JFK → PAR').length).toBeGreaterThan(0);
    expect(screen.queryByText('Louvre')).toBeNull();
  });
});
