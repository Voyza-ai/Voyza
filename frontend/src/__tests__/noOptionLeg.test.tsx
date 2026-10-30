/**
 * A leg with no option at all must look finished on every surface that draws
 * it, and must not claim a mode of travel it does not have.
 *
 * Zurich → Interlaken: Interlaken is priced through ZRH, so the leg is never
 * searched as a flight, and with no rail key there is no train either. The
 * planner marks it `unavailable` (PlanningChat legToTransport), with the
 * empty-transport placeholder underneath: mode 'flight', price 0, no times.
 * Harness run 2026-10-30 (NYC → Zurich, Interlaken, Lucerne, Geneva, 6
 * travellers): the flowchart said "No direct option", but the Calendar drew a
 * plane on Jan 12 ("✈ arrive" on Interlaken, a departure plane on the day) and
 * the Schedule's Jan 12 card carried the "Flight day" plane — a flight that
 * was never found.
 */
import './mocks';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import ScheduleView from '@/components/results/ScheduleView';
import CalendarView from '@/components/results/CalendarView';
import Connector from '@/components/results/Connector';
import { liveTripTotal } from '@/lib/tripTotals';
import type { City, Transport, Trip } from '@/lib/types';
import { buildTrip } from './fixtures';

/** What PlanningChat builds for a leg with nothing found. */
const noOption = (from: string, to: string): Transport => ({
  mode: 'flight',
  operator: '',
  duration: '',
  price: 0,
  from,
  to,
  unavailable: true,
});

const flight: Transport = {
  mode: 'flight',
  operator: 'Duffel Airways',
  duration: '0h 53m',
  price: 230.16,
  departTime: '18:05',
  arriveTime: '18:58',
};

const city = (name: string, arrival: string, departure: string, i: number, over: Partial<City> = {}): City =>
  ({
    name,
    country: 'Switzerland',
    dates: { arrival, departure },
    transportIn: flight,
    transportOut: flight,
    hotel: { name: `${name} Hotel`, rating: 8, pricePerNight: 200, area: '' },
    hotels: [{ name: `${name} Hotel`, rating: 8, pricePerNight: 200, area: '' }],
    selectedHotelIndex: 0,
    activities: [],
    restaurants: [],
    vibes: [],
    colorIndex: i,
    ...over,
  }) as City;

function swissTrip(): Trip {
  return {
    ...buildTrip(),
    travelers: 6,
    title: 'Zurich → Interlaken → Geneva',
    cities: [
      city('Zurich', '2027-01-11', '2027-01-12', 0, { transportOut: noOption('Zurich', 'Interlaken') }),
      city('Interlaken', '2027-01-12', '2027-01-14', 1, { transportIn: noOption('Zurich', 'Interlaken') }),
      city('Geneva', '2027-01-14', '2027-01-16', 2),
    ],
    origin: undefined,
  };
}

function onStore(trip: Trip, View: typeof ScheduleView | typeof CalendarView) {
  useTripStore.setState({ currentTrip: trip, priceMode: 'total' });
  function Live() {
    const t = useTripStore((s) => s.currentTrip);
    return t ? <View trip={t} /> : null;
  }
  return render(<Live />);
}

/** The calendar cell whose day number is `day`. */
function calendarCell(day: string): HTMLElement {
  const cell = screen
    .getAllByRole('button')
    .find((b) => b.querySelector('span')?.textContent === day);
  if (!cell) throw new Error(`no calendar cell ${day}`);
  return cell;
}

describe('a leg with no option', () => {
  it('flowchart pill: the existing "No direct option" card, no $0, no 0m', () => {
    useTripStore.setState({ currentTrip: swissTrip(), priceMode: 'total' });
    const { container } = render(
      <Connector transport={noOption('Zurich', 'Interlaken')} index={0} cityIndex={0} isExpanded={false} onToggle={() => {}} />,
    );
    expect(screen.getByText('No direct option')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$0|0m/);
  });

  it('Calendar: no plane on the day of a leg nothing was found for', () => {
    onStore(swissTrip(), CalendarView);
    const jan12 = calendarCell('12');
    // Before: the departure plane top-right and "✈ arrive" under Interlaken.
    expect(jan12.querySelector('.lucide-plane')).toBeNull();
    expect(within(jan12).getByText('Interlaken')).toBeInTheDocument();
    expect(within(jan12).getByText('arrive')).toBeInTheDocument();
    // A leg that IS a flight keeps its plane (Jan 14, Interlaken → Geneva).
    expect(calendarCell('14').querySelector('.lucide-plane')).not.toBeNull();
  });

  it('Schedule: the day card does not call it a flight day', () => {
    onStore(swissTrip(), ScheduleView);
    const jan12 = screen.getByText('Jan 12').closest('[class*="w-[340px]"]') as HTMLElement;
    expect(within(jan12).getByText('Interlaken')).toBeInTheDocument();
    // Before: aria-label "Flight day" on a plane icon.
    expect(within(jan12).queryByLabelText('Flight day')).toBeNull();
    const jan14 = screen.getByText('Jan 14').closest('[class*="w-[340px]"]') as HTMLElement;
    expect(within(jan14).getByLabelText('Flight day')).toBeInTheDocument();
  });

  it('adds nothing to the total', () => {
    // Hotels: 1 + 2 + 2 nights at $200; legs: the two real flights only
    // (Interlaken → Geneva and Geneva's onward leg). The no-option leg is $0
    // in the sum and is never shown as a price.
    expect(liveTripTotal(swissTrip())).toBe(Math.round(200 * 5 + 230.16 * 2));
  });
});
