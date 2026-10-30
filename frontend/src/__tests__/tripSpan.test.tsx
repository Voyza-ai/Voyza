/**
 * F1 — the header shows the TRIP's span, not the first city's stay.
 *
 * Integrated run, 2026-10-30 (harness s1-02-results.png): the owner planned
 * Jan 10–17 (7 nights) from New York. The overnight JFK 19:25 Jan 10 →
 * Paris 12:10 Jan 11 correctly moved Paris's arrival to Jan 11 (B1), and the
 * header — which read the first city's arrival as the trip start — then said
 * "Jan 11 – Jan 17 · 6 nights", right above a home card reading
 * "DEPART Sun, Jan 10 19:25". The calendar footer said "6 nights" too.
 */
import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import ResultsHeader from '@/components/results/ResultsHeader';
import CalendarView from '@/components/results/CalendarView';
import type { City, HomeLeg, Trip } from '@/lib/types';
import { buildCity, buildTrip } from './fixtures';

beforeAll(() => {
  let id = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++id);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterAll(() => {
  (window.requestAnimationFrame as jest.Mock).mockRestore();
  (window.cancelAnimationFrame as jest.Mock).mockRestore();
});

/** The owner's outbound, as the optimizer returns it (overnight). */
const outbound = (over: Partial<HomeLeg> = {}): HomeLeg => ({
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

const stay = (name: string, arrival: string, departure: string): City =>
  buildCity({ name, dates: { arrival, departure } });

/** Paris → Zurich → London as the optimizer now dates it: Paris from the landing day. */
function ownerTrip(leg: HomeLeg | null, parisArrival = '2027-01-11'): Trip {
  return buildTrip({
    title: 'Paris → Zurich → London',
    cities: [
      stay('Paris', parisArrival, '2027-01-13'),
      stay('Zurich', '2027-01-13', '2027-01-15'),
      stay('London', '2027-01-15', '2027-01-17'),
    ],
    origin: { city: 'New York', airports: ['JFK'], outboundLeg: leg, returnLeg: null },
  });
}

describe('ResultsHeader — trip span', () => {
  it('runs from the outbound departure to the return: Jan 10 – Jan 17 · 7 nights', () => {
    render(<ResultsHeader trip={ownerTrip(outbound())} />);
    // Before: "Jan 11 – Jan 17" and "6 nights".
    expect(screen.getByText(/Jan 10\s*–\s*Jan 17/)).toBeInTheDocument();
    expect(screen.getByText(/7 nights/)).toBeInTheDocument();
  });

  it('is unchanged for a same-day arrival', () => {
    // Departs and lands Jan 10: the first stay already starts on Jan 10.
    const trip = ownerTrip(outbound({ departTime: '07:15', arriveTime: '19:40', arriveDate: '2027-01-10' }), '2027-01-10');
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByText(/Jan 10\s*–\s*Jan 17/)).toBeInTheDocument();
    expect(screen.getByText(/7 nights/)).toBeInTheDocument();
  });

  it('with no outbound leg, behaves exactly as before (first stay → last departure)', () => {
    render(<ResultsHeader trip={ownerTrip(null)} />);
    expect(screen.getByText(/Jan 11\s*–\s*Jan 17/)).toBeInTheDocument();
    expect(screen.getByText(/6 nights/)).toBeInTheDocument();
  });
});

describe('CalendarView — trip span', () => {
  it('counts the nights of the whole trip in its footer', () => {
    render(<CalendarView trip={ownerTrip(outbound())} />);
    // Before: "6 nights · 3 cities".
    expect(screen.getByText(/7 nights · 3 cities/)).toBeInTheDocument();
  });

  it('with no outbound leg, keeps the first-stay count', () => {
    render(<CalendarView trip={ownerTrip(null)} />);
    expect(screen.getByText(/6 nights · 3 cities/)).toBeInTheDocument();
  });
});
