import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CityCard from '@/components/results/CityCard';
import { buildCity, mockHotel, mockHotel2 } from './fixtures';
import { useTripStore } from '@/store/tripStore';
import { buildTrip } from './fixtures';

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: buildTrip() });
});

const defaultProps = {
  isActive: false,
  isDimmed: false,
  onHover: jest.fn(),
  onLeave: jest.fn(),
  onClick: jest.fn(),
};

describe('CityCard', () => {
  it('renders city name, country, and dates', () => {
    const city = buildCity();
    render(<CityCard city={city} index={0} {...defaultProps} />);

    expect(screen.getByText('Rome')).toBeInTheDocument();
    expect(screen.getByText('Italy')).toBeInTheDocument();
    expect(screen.getByText('Jun 15')).toBeInTheDocument();
    expect(screen.getByText('Jun 18')).toBeInTheDocument();
  });

  it('displays correct number of nights', () => {
    const city = buildCity({ dates: { arrival: '2026-06-15', departure: '2026-06-18' } });
    render(<CityCard city={city} index={0} {...defaultProps} />);
    // 3 nights
    expect(screen.getByText(/3 nights/)).toBeInTheDocument();
  });

  it('shows 1 night for single night stays', () => {
    const city = buildCity({ dates: { arrival: '2026-06-15', departure: '2026-06-16' } });
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByText(/1 night$/)).toBeInTheDocument();
  });

  it('renders hotel name and price per night', () => {
    const city = buildCity();
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByText('Hotel Roma Centro')).toBeInTheDocument();
    expect(screen.getByText('$95/night')).toBeInTheDocument();
  });

  it('renders hotel rating as stars', () => {
    const city = buildCity();
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByText('4.5')).toBeInTheDocument();
  });

  it('shows hotel area', () => {
    const city = buildCity();
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByText('Trastevere')).toBeInTheDocument();
  });

  it('shows BLUEMURR BOOK badge when hotel is bookable', () => {
    const city = buildCity();
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByText('BLUEMURR BOOK')).toBeInTheDocument();
  });

  it('renders vibe tags from city vibes', () => {
    const city = buildCity({ vibes: ['history', 'food'] });
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByText(/History/i)).toBeInTheDocument();
    expect(screen.getByText(/Food/i)).toBeInTheDocument();
  });

  it('handles city with no vibes gracefully', () => {
    const city = buildCity({ vibes: undefined });
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByText('Rome')).toBeInTheDocument();
  });

  it('handles empty hotels array without crashing', () => {
    const city = buildCity({ hotels: [], hotel: mockHotel });
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByText('Hotel Roma Centro')).toBeInTheDocument();
  });

  it('shows chevron arrows when multiple hotels exist', () => {
    const city = buildCity({ hotels: [mockHotel, mockHotel2] });
    render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(screen.getByLabelText('Previous hotel option')).toBeInTheDocument();
    expect(screen.getByLabelText('Next hotel option')).toBeInTheDocument();
  });

  it('cycles to next hotel on right chevron click', () => {
    const trip = buildTrip();
    useTripStore.setState({ currentTrip: trip });
    const city = trip.cities[0];

    render(<CityCard city={city} index={0} {...defaultProps} />);

    // Initially showing Hotel Roma Centro
    expect(screen.getByText('Hotel Roma Centro')).toBeInTheDocument();

    // Click next
    fireEvent.click(screen.getByLabelText('Next hotel option'));

    // Store should have been updated — re-render with new state
    const updated = useTripStore.getState().currentTrip!;
    expect(updated.cities[0].selectedHotelIndex).toBe(1);
  });

  it('handles very long city names without breaking layout', () => {
    const city = buildCity({ name: 'San Cristóbal de las Casas Extra Long Name Test' });
    const { container } = render(<CityCard city={city} index={0} {...defaultProps} />);
    expect(container.firstChild).toBeTruthy();
  });
});
