/**
 * A city whose hotel search came back empty shows no $0 stay.
 *
 * It arrives with the empty placeholder (name '', $0). Harness 2026-10-30
 * (Interlaken, no rows): the flowchart card read "STAY $0", "★ 0" and
 * "$0/night" under a blank name, and the detail panel read "Stay total $0"
 * and "Using custom hotel" — there was no custom hotel.
 */
import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';
import CityCard from '@/components/results/CityCard';
import CityDetailPanel from '@/components/results/CityDetailPanel';
import { useTripStore } from '@/store/tripStore';
import { liveTripTotal } from '@/lib/tripTotals';
import type { City, Trip } from '@/lib/types';
import { buildCity, buildTrip } from './fixtures';

const cardProps = { isActive: false, isDimmed: false, onHover: jest.fn(), onLeave: jest.fn(), onClick: jest.fn() };
const panelProps = { onClose: jest.fn(), onPrev: jest.fn(), onNext: jest.fn() };

/** What PlanningChat builds for a city whose hotel search came back empty. */
const noHotel = (over: Partial<City> = {}): City =>
  buildCity({
    name: 'Interlaken',
    country: 'Switzerland',
    hotel: { name: '', rating: 0, pricePerNight: 0, area: '' },
    hotels: [],
    selectedHotelIndex: 0,
    ...over,
  });

function tripWith(cities: City[], travelers = 6): Trip {
  return { ...buildTrip(), travelers, cities };
}

beforeEach(() => useTripStore.setState({ priceMode: 'total' }));

describe('a city with no hotel found', () => {
  it('flowchart card: no $0 stay, no blank hotel — the existing "No options found"', () => {
    const trip = tripWith([buildCity(), noHotel()]);
    useTripStore.setState({ currentTrip: trip });
    const { container } = render(<CityCard city={trip.cities[1]} index={1} {...cardProps} />);
    expect(container.textContent).not.toMatch(/\$0(?![\d,.])/);
    expect(screen.queryByText('/night', { exact: false })).toBeNull();
    expect(screen.getByText('No options found')).toBeInTheDocument();
  });

  it('detail panel: no "$0" stay total and no false "Using custom hotel"', () => {
    const trip = tripWith([buildCity(), noHotel()]);
    useTripStore.setState({ currentTrip: trip });
    const { container } = render(<CityDetailPanel trip={trip} cityIndex={1} {...panelProps} />);
    expect(screen.queryByText('Using custom hotel')).toBeNull();
    expect(screen.getByText('No options found')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$0(?![\d,.])/);
    // The way out stays: the traveller can still add their own stay.
    expect(screen.getByText('Use my own hotel or Airbnb')).toBeInTheDocument();
  });

  it('a custom stay on that city still reads "Using custom hotel" and shows its price', () => {
    const trip = tripWith([noHotel({ customHotel: { name: 'Chalet', mode: 'total', amount: 600 } })]);
    useTripStore.setState({ currentTrip: trip });
    render(<CityDetailPanel trip={trip} cityIndex={0} {...panelProps} />);
    expect(screen.getByText('Using custom hotel')).toBeInTheDocument();
    expect(screen.getAllByText('$600').length).toBeGreaterThan(0);
  });

  it('the total is the stays and legs that exist — nothing invented for the empty one', () => {
    const rome = buildCity({ transportOut: { mode: 'flight', operator: 'X', duration: '1h', price: 100 } });
    const empty = noHotel({ transportOut: { mode: 'flight', operator: '', duration: '', price: 0 } });
    // Rome: $95 × 3 nights + $5 taxes × 3 nights; the leg $100; Interlaken: nothing.
    expect(liveTripTotal(tripWith([rome, empty]))).toBe(95 * 3 + 5 * 3 + 100);
  });
});
