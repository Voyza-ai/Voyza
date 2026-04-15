import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Connector from '@/components/results/Connector';
import { mockTransportFlight, mockTransportTrain, buildTrip } from './fixtures';
import { useTripStore } from '@/store/tripStore';
import { compareLeg } from '@/lib/api';

const mockedCompareLeg = compareLeg as jest.MockedFunction<typeof compareLeg>;

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: buildTrip() });
});

const baseProps = {
  index: 0,
  cityIndex: 0,
  isExpanded: false,
  onToggle: jest.fn(),
};

describe('Connector', () => {
  it('shows plane icon for flight mode', () => {
    render(<Connector transport={mockTransportFlight} {...baseProps} />);
    // The icon badge should exist
    expect(screen.getByLabelText('Show travel details')).toBeInTheDocument();
  });

  it('displays price and duration in collapsed pill', () => {
    render(<Connector transport={mockTransportFlight} {...baseProps} />);
    expect(screen.getByText('$89')).toBeInTheDocument();
    expect(screen.getByText('2h 15m')).toBeInTheDocument();
  });

  it('displays departure and arrival times', () => {
    render(<Connector transport={mockTransportFlight} {...baseProps} />);
    expect(screen.getByText('09:15')).toBeInTheDocument();
    expect(screen.getByText('11:30')).toBeInTheDocument();
  });

  it('shows train duration and price for train mode', () => {
    render(<Connector transport={mockTransportTrain} {...baseProps} />);
    expect(screen.getByText('$35')).toBeInTheDocument();
    expect(screen.getByText('1h 32m')).toBeInTheDocument();
  });

  it('shows expanded transport detail on click (isExpanded=true)', () => {
    render(
      <Connector transport={mockTransportFlight} {...baseProps} isExpanded={true} />,
    );
    // Expanded view shows operator name
    expect(screen.getByText('Ryanair')).toBeInTheDocument();
    expect(screen.getByText('Flight')).toBeInTheDocument();
  });

  it('shows flight number in expanded view', () => {
    render(
      <Connector transport={mockTransportFlight} {...baseProps} isExpanded={true} />,
    );
    expect(screen.getByText('FR1234')).toBeInTheDocument();
  });

  it('shows baggage info in expanded view', () => {
    render(
      <Connector transport={mockTransportFlight} {...baseProps} isExpanded={true} />,
    );
    expect(screen.getByText('1 carry-on + 1 personal item')).toBeInTheDocument();
  });

  it('shows Book button with correct URL in expanded view', () => {
    render(
      <Connector transport={mockTransportFlight} {...baseProps} isExpanded={true} />,
    );
    const bookLink = screen.getByText('Book').closest('a');
    expect(bookLink).toHaveAttribute('href', 'https://ryanair.example.com/booking');
    expect(bookLink).toHaveAttribute('target', '_blank');
  });

  it('shows alternative transport options in expanded view', () => {
    render(
      <Connector transport={mockTransportTrain} {...baseProps} isExpanded={true} />,
    );
    // The train has one flight alternative at $120
    expect(screen.getByText('$120')).toBeInTheDocument();
    expect(screen.getByText('ITA Airways')).toBeInTheDocument();
  });

  it('calls onToggle when collapsed pill is clicked', () => {
    const onToggle = jest.fn();
    render(
      <Connector transport={mockTransportFlight} {...baseProps} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByLabelText('Show travel details'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onToggle when close button is clicked in expanded view', () => {
    const onToggle = jest.fn();
    render(
      <Connector
        transport={mockTransportFlight}
        {...baseProps}
        isExpanded={true}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByLabelText('Minimize'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows "Direct" for 0 layovers', () => {
    render(
      <Connector
        transport={{ ...mockTransportFlight, layovers: 0 }}
        {...baseProps}
        isExpanded={true}
      />,
    );
    expect(screen.getByText('Direct')).toBeInTheDocument();
  });

  it('shows layover count for flights with stops', () => {
    render(
      <Connector
        transport={{ ...mockTransportFlight, layovers: 2 }}
        {...baseProps}
        isExpanded={true}
      />,
    );
    expect(screen.getByText('2 stops')).toBeInTheDocument();
  });

  it('handles single city trip (no connector needed)', () => {
    // This is tested at Flowchart level, but connector with no transport should not crash
    const emptyTransport: any = {
      mode: 'flight',
      operator: '',
      duration: '',
      price: 0,
    };
    const { container } = render(
      <Connector transport={emptyTransport} {...baseProps} />,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
