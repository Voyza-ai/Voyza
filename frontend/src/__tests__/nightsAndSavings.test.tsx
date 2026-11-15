import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CityCard from '@/components/results/CityCard';
import ResultsHeader from '@/components/results/ResultsHeader';
import { waysToSave } from '@/lib/waysToSave';
import { liveTripTotal } from '@/lib/tripTotals';
import { useTripStore } from '@/store/tripStore';
import { buildCity, buildTrip, mockHotel, mockHotel2 } from './fixtures';

const props = { isActive: false, isDimmed: false, onHover: jest.fn(), onLeave: jest.fn(), onClick: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: buildTrip(), priceMode: 'total' });
});

describe('nights stepper on a city card', () => {
  it('shows − / + only when the trip can be changed', () => {
    const city = buildCity({ dates: { arrival: '2026-06-15', departure: '2026-06-18' } });
    const { rerender } = render(<CityCard city={city} index={0} {...props} />);
    expect(screen.queryByLabelText('More nights in Rome')).toBeNull();
    rerender(<CityCard city={city} index={0} {...props} onNightsChange={jest.fn()} />);
    expect(screen.getByLabelText('More nights in Rome')).toBeInTheDocument();
    expect(screen.getByTestId('city-nights')).toHaveTextContent('3 nights');
  });

  it('asks for one more / one fewer night without opening the city guide', () => {
    const onNights = jest.fn();
    const onClick = jest.fn();
    const city = buildCity({ dates: { arrival: '2026-06-15', departure: '2026-06-18' } });
    render(<CityCard city={city} index={0} {...props} onClick={onClick} onNightsChange={onNights} />);
    fireEvent.click(screen.getByLabelText('More nights in Rome'));
    fireEvent.click(screen.getByLabelText('Fewer nights in Rome'));
    expect(onNights.mock.calls).toEqual([[4], [2]]);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('cannot go below one night', () => {
    const city = buildCity({ dates: { arrival: '2026-06-15', departure: '2026-06-16' } });
    render(<CityCard city={city} index={0} {...props} onNightsChange={jest.fn()} />);
    expect(screen.getByLabelText('Fewer nights in Rome')).toBeDisabled();
  });
});

describe('waysToSave', () => {
  it('offers the cheapest other hotel, and applying it lowers the total by exactly that', () => {
    const cheap = { ...mockHotel2, name: 'Cheap Inn', pricePerNight: 40 };
    const city = buildCity({ hotels: [mockHotel, cheap], hotel: mockHotel, selectedHotelIndex: 0 });
    const trip = buildTrip({ cities: [city] });
    const [opt] = waysToSave(trip);
    expect(opt.title).toBe('Cheaper hotel in Rome');
    expect(opt.detail).toContain('Cheap Inn');
    const switched = { ...trip, cities: [{ ...city, selectedHotelIndex: 1, hotel: cheap }] };
    expect(liveTripTotal(trip) - liveTripTotal(switched)).toBe(opt.savings);
  });

  it('never offers a pricier or unpriced choice, or undercuts a custom hotel', () => {
    const pricey = { ...mockHotel2, pricePerNight: 900 };
    const free = { ...mockHotel2, name: 'Unpriced', pricePerNight: 0 };
    const city = buildCity({ hotels: [mockHotel, pricey, free], hotel: mockHotel, selectedHotelIndex: 0 });
    expect(waysToSave(buildTrip({ cities: [city] }))).toEqual([]);
    const custom = buildCity({
      hotels: [mockHotel, { ...mockHotel2, pricePerNight: 1 }],
      customHotel: { name: 'Mine', amount: 500, mode: 'total' } as any,
    });
    expect(waysToSave(buildTrip({ cities: [custom] }))).toEqual([]);
  });
});

describe('the green savings box', () => {
  it('opens Ways to save on click and applies a switch', () => {
    const cheap = { ...mockHotel2, name: 'Cheap Inn', pricePerNight: 40 };
    const city = buildCity({ hotels: [mockHotel, cheap], hotel: mockHotel, selectedHotelIndex: 0 });
    const trip = buildTrip({ cities: [city], savings: 300, dateShiftChecked: true });
    useTripStore.setState({ currentTrip: trip });
    render(<ResultsHeader trip={trip} />);
    fireEvent.click(screen.getByTitle('See ways to save on this trip'));
    expect(screen.getByRole('dialog', { name: 'Ways to save' })).toBeInTheDocument();
    expect(screen.getByText(/by visiting your cities in this order/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('save-option'));
    expect(useTripStore.getState().currentTrip!.cities[0].selectedHotelIndex).toBe(1);
  });

  it('lists switches without applying them for someone who can only view', () => {
    const cheap = { ...mockHotel2, name: 'Cheap Inn', pricePerNight: 40 };
    const city = buildCity({ hotels: [mockHotel, cheap], hotel: mockHotel, selectedHotelIndex: 0 });
    const trip = buildTrip({ cities: [city], savings: 300 });
    useTripStore.setState({ currentTrip: trip });
    render(<ResultsHeader trip={trip} canEdit={false} />);
    fireEvent.click(screen.getByTitle('See ways to save on this trip'));
    expect(screen.getByTestId('save-option').tagName).toBe('DIV');
  });
});
