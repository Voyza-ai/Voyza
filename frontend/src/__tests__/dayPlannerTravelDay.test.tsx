/**
 * The Day Planner for the day an overnight outbound leaves home is a travel
 * day, not a day in the first city.
 *
 * Owner's trip (JFK 19:25 Jan 10 → Paris 12:10 Jan 11): the Schedule's and
 * the Calendar's Jan 10 open the planner on the first city, which holds that
 * day's blocks (head to JFK, the flight), and it was titled
 * "Day Planner · Paris" — the traveller is not in Paris until Jan 11.
 * Harness 2026-10-30 (NYC → Paris, London, Zurich): "DAY PLANNER · PARIS" on
 * Sunday, January 10 from both views. The Schedule's own Jan 10 card already
 * says "Travel day"; the planner now says the same.
 */
import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import DayPlanner from '@/components/results/DayPlanner';
import { useTripStore } from '@/store/tripStore';
import type { City, HomeLeg, Transport, Trip } from '@/lib/types';
import { buildTrip } from './fixtures';

const emptyTransport: Transport = { mode: 'flight', operator: '', duration: '', price: 0 };

const outbound = (departDate: string): HomeLeg => ({
  originAirport: 'JFK',
  destAirport: 'PAR',
  price: 1337,
  currency: 'USD',
  durationMinutes: 645,
  operator: 'Icelandair',
  carrierCode: 'FI',
  departTime: '19:25',
  arriveTime: '12:10',
  departDate,
  arriveDate: '2027-01-11',
  stops: 1,
  bookingUrl: null,
});

const paris: City = {
  name: 'Paris',
  country: 'France',
  dates: { arrival: '2027-01-11', departure: '2027-01-13' },
  transportIn: emptyTransport,
  transportOut: { mode: 'flight', operator: 'Swiss', duration: '1h', price: 280, departTime: '09:17', arriveTime: '10:30' },
  hotel: { name: 'H', rating: 8, pricePerNight: 100, area: '' },
  hotels: [{ name: 'H', rating: 8, pricePerNight: 100, area: '' }],
  selectedHotelIndex: 0,
  activities: [],
  restaurants: [],
  vibes: [],
  colorIndex: 0,
} as City;

function trip(departDate = '2027-01-10'): Trip {
  return {
    ...buildTrip(),
    cities: [paris],
    origin: { city: 'New York', airports: ['JFK'], outboundLeg: outbound(departDate), returnLeg: null },
  };
}

function open(t: Trip, date: string) {
  useTripStore.setState({ currentTrip: t });
  return render(<DayPlanner trip={t} date={date} city={t.cities[0]} cityIndex={0} onClose={() => {}} />);
}

describe('Day Planner title', () => {
  it('the home departure day of an overnight trip is a travel day', () => {
    open(trip(), '2027-01-10');
    expect(screen.getByText('Day Planner · Travel day')).toBeInTheDocument();
    expect(screen.queryByText('Day Planner · Paris')).toBeNull();
  });

  it('the landing day and every stay day keep the city', () => {
    open(trip(), '2027-01-11');
    expect(screen.getByText('Day Planner · Paris')).toBeInTheDocument();
  });

  it('a same-day arrival (no separate departure day) keeps the city', () => {
    open(trip('2027-01-11'), '2027-01-11');
    expect(screen.getByText('Day Planner · Paris')).toBeInTheDocument();
  });
});
