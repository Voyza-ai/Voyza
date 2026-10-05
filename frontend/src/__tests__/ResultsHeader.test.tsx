import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ResultsHeader from '@/components/results/ResultsHeader';
import { buildTrip } from './fixtures';

// Mock requestAnimationFrame — just suppress the animation loop; tests check labels only
beforeAll(() => {
  let id = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++id);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterAll(() => {
  (window.requestAnimationFrame as jest.Mock).mockRestore();
  (window.cancelAnimationFrame as jest.Mock).mockRestore();
});

describe('ResultsHeader', () => {
  it('displays total cost from trip data', () => {
    const trip = buildTrip({ totalCost: 1200 });
    render(<ResultsHeader trip={trip} />);
    // The animated counter should eventually show the total
    expect(screen.getByText(/Total trip/i)).toBeInTheDocument();
  });

  it('displays "You can save" with routing savings when that is the best offer', () => {
    const trip = buildTrip({ savings: 249 });
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByText(/You can save/i)).toBeInTheDocument();
    expect(screen.getByText(/vs default routing/i)).toBeInTheDocument();
  });

  it('shows the date-shift savings when it beats routing savings', () => {
    // totalCost 0 + savings 0 → baseline 0 → live routing savings clamp to 0,
    // so the $118 date-shift is unambiguously the best offer.
    const trip = buildTrip({
      savings: 0,
      totalCost: 0,
      dateShiftSuggestion: {
        dayOffset: -1,
        newStartDate: '2026-08-03',
        newTotalCost: 1000,
        savings: 118,
      },
    });
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByText(/You can save/i)).toBeInTheDocument();
    expect(screen.getByText(/by starting Aug 3/i)).toBeInTheDocument();
  });

  it('formats city names in title from trip.title', () => {
    const trip = buildTrip({ title: 'Rome · Florence · Barcelona' });
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByText('Rome · Florence · Barcelona')).toBeInTheDocument();
  });

  it('shows per-person cost', () => {
    const trip = buildTrip({ totalCost: 1200, travelers: 2 });
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByText(/\/person/)).toBeInTheDocument();
  });

  it('shows date range and total nights', () => {
    const trip = buildTrip();
    render(<ResultsHeader trip={trip} />);
    // Trip spans Jun 15 → Jun 20 = 5 nights
    expect(screen.getByText(/5 nights/)).toBeInTheDocument();
  });

  it('shows traveler count and stop count', () => {
    const trip = buildTrip({ travelers: 4 });
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByText(/4 travelers/)).toBeInTheDocument();
    expect(screen.getByText(/2 stops/)).toBeInTheDocument();
  });

  it('handles single traveler text correctly', () => {
    const trip = buildTrip({ travelers: 1 });
    render(<ResultsHeader trip={trip} />);
    expect(screen.getByText(/1 traveler$/)).toBeInTheDocument();
  });

  it('savings pill opens a menu of real date-shift options', () => {
    const trip = buildTrip({
      totalCost: 1711,
      savings: 0,
      dateShiftSuggestion: {
        dayOffset: -2,
        newStartDate: '2026-09-30',
        newTotalCost: 1456,
        savings: 255,
        options: [
          { dayOffset: -2, newStartDate: '2026-09-30', newTotalCost: 1456, savings: 255 },
          { dayOffset: 1, newStartDate: '2026-10-03', newTotalCost: 1531, savings: 180 },
          { dayOffset: 2, newStartDate: '2026-10-04', newTotalCost: 1601, savings: 110 },
        ],
      },
    } as any);
    render(<ResultsHeader trip={trip} />);
    fireEvent.click(screen.getByText(/You can save/i));
    expect(screen.getByText('Cheaper start dates')).toBeInTheDocument();
    expect(screen.getByText('2 days earlier')).toBeInTheDocument();
    expect(screen.getByText('1 day later')).toBeInTheDocument();
    expect(screen.getByText('2 days later')).toBeInTheDocument();
    expect(screen.getByText('save $255')).toBeInTheDocument();
    expect(screen.getByText('save $180')).toBeInTheDocument();
    expect(screen.getByText('save $110')).toBeInTheDocument();
    // Dates rendered human-readable.
    expect(screen.getByText(/starts Wed, Sep 30/)).toBeInTheDocument();
  });

  it('clicking an option stages shifted answers and routes to the autorun replan', () => {
    const { useTripStore } = require('@/store/tripStore');
    useTripStore.setState({ answers: {} });
    const trip = buildTrip({
      travelers: 2,
      dateShiftSuggestion: {
        dayOffset: -2,
        newStartDate: '2026-06-13',
        newTotalCost: 1456,
        savings: 255,
        options: [
          { dayOffset: -2, newStartDate: '2026-06-13', newTotalCost: 1456, savings: 255 },
        ],
      },
    } as any);
    render(<ResultsHeader trip={trip} />);
    fireEvent.click(screen.getByText(/You can save/i));
    fireEvent.click(screen.getByText('2 days earlier'));

    const a = useTripStore.getState().answers;
    // Start = the option's date; end = trip's last departure shifted -2
    // (fixture ends 2026-06-20 → 2026-06-18).
    expect(a.dateRange).toEqual({ start: '2026-06-13', end: '2026-06-18' });
    // Rebuilt from the trip since the store had no planner answers.
    expect(a.destinations).toEqual(['Rome', 'Florence']);
    expect(a.travelers).toBe(2);
    const { mockPush } = require('./mocks');
    expect(mockPush).toHaveBeenCalledWith('/plan?resume=1&autorun=1');
    // A snapshot must also be written so the planner can restore the
    // staged answers even if the plan page's reset wipes the store.
    const snapshot = JSON.parse(sessionStorage.getItem('bluemurr-autorun')!);
    expect(snapshot.dateRange).toEqual({ start: '2026-06-13', end: '2026-06-18' });
    expect(snapshot.destinations).toEqual(['Rome', 'Florence']);
    sessionStorage.clear();
  });

  it('older trips with only the flat suggestion get a one-entry menu', () => {
    const trip = buildTrip({
      totalCost: 1000,
      savings: 0,
      dateShiftSuggestion: {
        dayOffset: 2,
        newStartDate: '2026-08-28',
        newTotalCost: 800,
        savings: 200,
      },
    } as any);
    render(<ResultsHeader trip={trip} />);
    fireEvent.click(screen.getByText(/You can save/i));
    expect(screen.getByText('Cheaper start dates')).toBeInTheDocument();
    expect(screen.getByText('2 days later')).toBeInTheDocument();
    expect(screen.getByText('save $200')).toBeInTheDocument();
  });

  it('without a date-shift suggestion the pill is not clickable', () => {
    const trip = buildTrip({ savings: 249 });
    render(<ResultsHeader trip={trip} />);
    fireEvent.click(screen.getByText(/You can save/i));
    expect(screen.queryByText('Cheaper start dates')).not.toBeInTheDocument();
  });

  it('long AI-route titles cannot wrap the price cluster onto a second row', () => {
    // Describe-chat trips are titled with the full route ("Berlin → Florence
    // → Barcelona → Madrid"), which used to widen the left column until the
    // flex-wrap header dropped the toggle/pills/buttons below the title.
    const trip = buildTrip({
      title: 'Berlin → Florence → Barcelona → Madrid → Lisbon → Porto',
    });
    const { container } = render(<ResultsHeader trip={trip} />);
    const row = container.querySelector('.justify-between') as HTMLElement;
    expect(row).toBeTruthy();
    // The row must never be allowed to wrap, and must top-align both sides.
    expect(row.className).not.toContain('flex-wrap');
    expect(row.className).toContain('items-start');
    // The left column must be shrinkable so the title truncates inside it
    // instead of forcing the row wide.
    const left = row.firstElementChild as HTMLElement;
    expect(left.className).toContain('flex-1');
    expect(left.className).toContain('min-w-0');
  });
});
