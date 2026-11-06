import './mocks';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Flowchart from '@/components/results/Flowchart';
import { flowchartFilterCounts, parseFlowchartFilter } from '@/components/results/FlowchartFilter';
import { useTripStore } from '@/store/tripStore';
import type { HomeLeg, Trip } from '@/lib/types';
import { buildTrip } from './fixtures';

/**
 * The flowchart's type filter (All · Flights · Hotels · Activities): the city
 * sequence and the route stay, only the cards change.
 */

const leg = (from: string, to: string, date: string): HomeLeg => ({
  originAirport: from,
  destAirport: to,
  price: 420,
  currency: 'USD',
  durationMinutes: 500,
  operator: 'Delta',
  carrierCode: 'DL',
  departTime: '18:00',
  arriveTime: '08:20',
  departDate: date,
  stops: 0,
  bookingUrl: null,
});

const trip: Trip = buildTrip({
  origin: {
    city: 'New York',
    airports: ['JFK'],
    outboundLeg: leg('JFK', 'FCO', '2026-06-14'),
    returnLeg: leg('FLR', 'JFK', '2026-06-20'),
  },
  returnToHome: true,
});

const chip = (id: string) => document.querySelector(`[data-filter-chip="${id}"]`) as HTMLElement;
const count = (sel: string) => document.querySelectorAll(sel).length;

beforeEach(() => {
  window.history.replaceState(null, '', '/results');
  useTripStore.setState({ currentTrip: trip, tripPicks: null });
});

describe('flowchart type filter', () => {
  it('counts what each chip shows', () => {
    // 2 home legs + 1 city leg; both stays; Rome 2 + 1, Florence 1 + 0.
    expect(flowchartFilterCounts(trip)).toEqual({ flights: 3, hotels: 2, activities: 4 });
    expect(parseFlowchartFilter('hotels')).toBe('hotels');
    expect(parseFlowchartFilter('nonsense')).toBe('all');
    expect(parseFlowchartFilter(null)).toBe('all');
  });

  it('All is the full flowchart', () => {
    render(<Flowchart trip={trip} />);
    expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Activities & Dining')).toHaveLength(2);
    expect(screen.getAllByText('Click for details')).toHaveLength(3);
    expect(screen.getByText('Hotel Roma Centro')).toBeInTheDocument();
    expect(screen.getByText('Depart')).toBeInTheDocument(); // full home card
    expect(count('[data-plain-route]')).toBe(0);
    expect(count('[data-compact-city]')).toBe(0);
  });

  it('Flights: home cards and every leg in full, cities as compact nodes', () => {
    render(<Flowchart trip={trip} />);
    fireEvent.click(chip('flights'));
    expect(chip('flights')).toHaveAttribute('aria-pressed', 'true');
    expect(window.location.search).toBe('?show=flights');
    // Every leg opened: the expanded card's close button, no collapsed pills.
    expect(screen.getAllByLabelText('Minimize')).toHaveLength(3);
    expect(screen.queryByText('Click for details')).not.toBeInTheDocument();
    expect(screen.getByText('Depart')).toBeInTheDocument();
    expect(screen.getByText('Arrive')).toBeInTheDocument();
    expect(count('[data-compact-city]')).toBe(2);
    expect(screen.queryByText('Activities & Dining')).not.toBeInTheDocument();
    expect(screen.queryByText('Hotel Roma Centro')).not.toBeInTheDocument();
  });

  it('Hotels: stays only, legs as the bare dashed route', () => {
    render(<Flowchart trip={trip} />);
    fireEvent.click(chip('hotels'));
    expect(window.location.search).toBe('?show=hotels');
    expect(screen.getByText('Hotel Roma Centro')).toBeInTheDocument();
    expect(screen.getByText('Hotel Firenze')).toBeInTheDocument();
    expect(count('[data-plain-route]')).toBe(3);
    expect(screen.queryByText('Click for details')).not.toBeInTheDocument();
    expect(screen.queryByText('Depart')).not.toBeInTheDocument();
    expect(count('[data-compact-home]')).toBe(2);
    expect(screen.queryByText('Activities & Dining')).not.toBeInTheDocument();
  });

  it('Activities: the Activities & Dining cards, no hotels, bare route', () => {
    render(<Flowchart trip={trip} />);
    fireEvent.click(chip('activities'));
    expect(screen.getAllByText('Activities & Dining')).toHaveLength(2);
    expect(screen.getByText('Colosseum')).toBeInTheDocument();
    expect(count('[data-compact-city]')).toBe(2);
    expect(count('[data-plain-route]')).toBe(3);
    expect(screen.queryByText('Hotel Roma Centro')).not.toBeInTheDocument();
    expect(screen.queryByText('Click for details')).not.toBeInTheDocument();
  });

  it('back to All restores the flowchart, its open legs included', () => {
    render(<Flowchart trip={trip} />);
    // A leg the traveller opened in All stays open across the filters.
    fireEvent.click(screen.getAllByLabelText('Show travel details')[1]);
    const before = document.querySelector('[data-testid="flowchart"]')!.textContent;
    fireEvent.click(chip('flights'));
    fireEvent.click(chip('hotels'));
    fireEvent.click(chip('all'));
    expect(window.location.search).toBe('');
    expect(document.querySelector('[data-testid="flowchart"]')!.textContent).toBe(before);
    expect(screen.getAllByLabelText('Minimize')).toHaveLength(1);
  });

  it('opens on the filter in ?show=', () => {
    const nav = jest.requireMock('next/navigation') as { useSearchParams: () => URLSearchParams };
    const spy = jest.spyOn(nav, 'useSearchParams').mockReturnValue(new URLSearchParams('show=hotels'));
    render(<Flowchart trip={trip} />);
    expect(chip('hotels')).toHaveAttribute('aria-pressed', 'true');
    expect(count('[data-plain-route]')).toBe(3);
    spy.mockRestore();
  });
});
