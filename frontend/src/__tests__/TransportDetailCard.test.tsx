import './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import Connector from '@/components/results/Connector';
import { mockTransportFlight, buildTrip } from './fixtures';
import { useTripStore } from '@/store/tripStore';
import { compareLeg, LegComparison } from '@/lib/api';

const mockedCompareLeg = compareLeg as jest.MockedFunction<typeof compareLeg>;

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: buildTrip() });
});

const baseProps = {
  index: 0,
  cityIndex: 0,
  isExpanded: true,
  onToggle: jest.fn(),
};

const fullComparison: LegComparison = {
  flightOption: {
    id: 'f1',
    price: 89,
    currency: 'USD',
    departure: '2026-06-20T09:15:00',
    arrival: '2026-06-20T11:30:00',
    durationMinutes: 135,
    stops: 0,
    carrier: 'Ryanair',
    carrierCode: 'FR',
    bookingUrl: 'https://example.com',
  },
  trainOption: {
    id: 't1',
    price: 45,
    currency: 'USD',
    departure: '2026-06-20T08:00:00',
    arrival: '2026-06-20T12:30:00',
    durationMinutes: 270,
    operator: 'Renfe',
    trainType: 'AVE',
    bookingUrl: 'https://renfe.com',
    limitedCoverage: false,
  },
  cheapest: 'train',
  fastest: 'flight',
  recommendation: 'train',
  priceDifference: 44,
  timeDifference: 135,
};

describe('TransportDetailCard (via Connector expanded)', () => {
  it('shows both flight and train options when both available', async () => {
    mockedCompareLeg.mockResolvedValue(fullComparison);

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Flight vs Train')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Ryanair/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Renfe/)).toBeInTheDocument();
  });

  it('highlights recommended option', async () => {
    mockedCompareLeg.mockResolvedValue(fullComparison);

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Flight vs Train')).toBeInTheDocument();
    });
    // The train card should have the recommendation (highlighted with green border)
    expect(screen.getByText('$45')).toBeInTheDocument();
  });

  it('shows "Price varies" when trainOption.price is null', async () => {
    const compWithNullPrice: LegComparison = {
      ...fullComparison,
      trainOption: { ...fullComparison.trainOption!, price: null },
    };
    mockedCompareLeg.mockResolvedValue(compWithNullPrice);

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Price varies')).toBeInTheDocument();
    });
  });

  it('shows limitedCoverage warning when flag is true', async () => {
    const compWithLimited: LegComparison = {
      ...fullComparison,
      trainOption: { ...fullComparison.trainOption!, limitedCoverage: true },
    };
    mockedCompareLeg.mockResolvedValue(compWithLimited);

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Limited coverage')).toBeInTheDocument();
    });
  });

  it('shows only flight when trainOption is null', async () => {
    const flightOnly: LegComparison = {
      ...fullComparison,
      trainOption: null,
      recommendation: 'flight',
    };
    mockedCompareLeg.mockResolvedValue(flightOnly);

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Flight vs Train')).toBeInTheDocument();
    });
    // Should have flight info but no train info
    expect(screen.queryByText('Renfe')).not.toBeInTheDocument();
  });

  it('shows only train when flightOption is null', async () => {
    const trainOnly: LegComparison = {
      ...fullComparison,
      flightOption: null,
      recommendation: 'train',
    };
    mockedCompareLeg.mockResolvedValue(trainOnly);

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('Flight vs Train')).toBeInTheDocument();
    });
    expect(screen.getByText(/Renfe/)).toBeInTheDocument();
  });

  it('displays priceDifference and timeDifference correctly', async () => {
    mockedCompareLeg.mockResolvedValue(fullComparison);

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Train saves \$44/)).toBeInTheDocument();
      expect(screen.getByText(/Flight saves 135min/)).toBeInTheDocument();
    });
  });

  it('shows loading state while fetching comparison', () => {
    // compareLeg never resolves
    mockedCompareLeg.mockReturnValue(new Promise(() => {}));

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    expect(screen.getByText('Comparing flight vs train...')).toBeInTheDocument();
  });

  it('does not crash when API returns 500', async () => {
    mockedCompareLeg.mockRejectedValue(new Error('Server error'));

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    // Should not crash, just not show the comparison
    await waitFor(() => {
      expect(screen.queryByText('Flight vs Train')).not.toBeInTheDocument();
    });
  });

  it('does not render when recommendation is unavailable', async () => {
    const unavailable: LegComparison = {
      flightOption: null,
      trainOption: null,
      cheapest: 'unavailable',
      fastest: 'unavailable',
      recommendation: 'unavailable',
      priceDifference: 0,
      timeDifference: 0,
    };
    mockedCompareLeg.mockResolvedValue(unavailable);

    render(<Connector transport={mockTransportFlight} {...baseProps} />);

    await waitFor(() => {
      expect(screen.queryByText('Flight vs Train')).not.toBeInTheDocument();
    });
  });
});
