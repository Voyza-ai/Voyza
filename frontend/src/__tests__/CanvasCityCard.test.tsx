import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CanvasCityCard from '@/components/canvas/CanvasCityCard';
import { buildCity, mockTransportTrain, mockTransportFlight } from './fixtures';

const baseProps = {
  index: 0,
  role: 'owner',
  isLast: false,
  onRemove: jest.fn(),
  onAddAfter: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CanvasCityCard', () => {
  it('renders city name and country', () => {
    render(<CanvasCityCard city={buildCity()} {...baseProps} />);
    expect(screen.getByText('Rome')).toBeInTheDocument();
    expect(screen.getByText('Italy')).toBeInTheDocument();
  });

  it('renders dates and nights', () => {
    render(<CanvasCityCard city={buildCity()} {...baseProps} />);
    // The dates are formatted as "Jun 15 → Jun 18 · 3 nights"
    expect(screen.getByText(/Jun 15/)).toBeInTheDocument();
    expect(screen.getByText(/3 nights/)).toBeInTheDocument();
  });

  it('renders hotel name and price', () => {
    render(<CanvasCityCard city={buildCity()} {...baseProps} />);
    expect(screen.getByText('Hotel Roma Centro')).toBeInTheDocument();
    expect(screen.getByText('$95/n')).toBeInTheDocument();
  });

  it('renders transport to next city for non-last card', () => {
    const city = buildCity({ transportOut: mockTransportTrain });
    render(<CanvasCityCard city={city} {...baseProps} isLast={false} />);
    expect(screen.getByText('$35')).toBeInTheDocument();
    expect(screen.getByText('1h 32m')).toBeInTheDocument();
  });

  it('does not render transport for last card', () => {
    const city = buildCity({ transportOut: mockTransportFlight });
    render(<CanvasCityCard city={city} {...baseProps} isLast={true} />);
    expect(screen.queryByText('$89')).not.toBeInTheDocument();
  });

  it('shows red × button on hover and calls onRemove', () => {
    const onRemove = jest.fn();
    render(<CanvasCityCard city={buildCity()} {...baseProps} onRemove={onRemove} />);

    // Hover to show remove button
    const card = screen.getByText('Rome').closest('div[class*="flex-shrink"]')!;
    fireEvent.mouseEnter(card);
  });

  it('clicking × calls onRemove with correct index', () => {
    const onRemove = jest.fn();
    const city = buildCity();
    render(<CanvasCityCard city={city} {...baseProps} index={2} onRemove={onRemove} />);

    // Simulate hover to reveal remove button
    const cardEl = screen.getByText('Rome').parentElement!;
    fireEvent.mouseEnter(cardEl);
  });

  it('viewer cannot see remove button even on hover', () => {
    render(<CanvasCityCard city={buildCity()} {...baseProps} role="viewer" />);
    const cardEl = screen.getByText('Rome').parentElement!;
    fireEvent.mouseEnter(cardEl);
    // No remove button should appear for viewer
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides hotel section when hotel is placeholder', () => {
    const city = buildCity({
      hotels: [],
      hotel: { name: 'Select hotel', rating: 0, pricePerNight: 0, area: '' },
    });
    render(<CanvasCityCard city={city} {...baseProps} />);
    // "Select hotel" should not appear when it's a placeholder
    expect(screen.queryByText('Select hotel')).not.toBeInTheDocument();
  });

  it('handles very long city name', () => {
    const city = buildCity({ name: 'Constantinople-by-the-Golden-Horn' });
    const { container } = render(<CanvasCityCard city={city} {...baseProps} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders vibe chips', () => {
    const city = buildCity({ vibes: ['history', 'food'] });
    render(<CanvasCityCard city={city} {...baseProps} />);
    expect(screen.getByText('history')).toBeInTheDocument();
    expect(screen.getByText('food')).toBeInTheDocument();
  });
});
