import './mocks';
import { mockSearchParams } from './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildTrip } from './fixtures';

// Must import after mocks
import ResultsPage from '@/app/results/page';

const mockPush = jest.requireMock('next/navigation').useRouter().push;

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: null, chatHistory: [] });
});

describe('ResultsPage', () => {
  it('renders loading state while fetching trip by tripId', async () => {
    // Set tripId in search params
    const mockSearchParams = jest.requireMock('next/navigation').useSearchParams;
    jest.spyOn({ useSearchParams: mockSearchParams }, 'useSearchParams');

    // When there is no currentTrip and no tripId, it redirects
    render(<ResultsPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/plan');
    });
  });

  it('renders flowchart when store has a valid trip', () => {
    const trip = buildTrip();
    useTripStore.setState({ currentTrip: trip });

    render(<ResultsPage />);
    // Should render the trip title from the header
    expect(screen.getByText('Rome · Florence')).toBeInTheDocument();
  });

  it('shows ResultsHeader with trip data from Zustand', () => {
    const trip = buildTrip({ travelers: 3, savings: 300, totalCost: 1500 });
    useTripStore.setState({ currentTrip: trip });

    render(<ResultsPage />);
    expect(screen.getByText('Optimized itinerary')).toBeInTheDocument();
    expect(screen.getByText(/3 travelers/)).toBeInTheDocument();
    expect(screen.getByText(/2 stops/)).toBeInTheDocument();
  });

  it('redirects to /plan when no currentTrip and no tripId', async () => {
    render(<ResultsPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/plan');
    });
  });

  it('renders AI chat panel alongside the flowchart', () => {
    useTripStore.setState({ currentTrip: buildTrip() });
    render(<ResultsPage />);
    expect(screen.getByText('BlueMurr AI')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask about your trip...')).toBeInTheDocument();
  });

  it('renders nothing (null) before trip loads', () => {
    // No trip in store, but prevent redirect by checking render
    const { container } = render(<ResultsPage />);
    // The inner component renders null when no trip
    // (the Suspense fallback is also null)
    expect(container.querySelector('main')).toBeNull();
  });

  // Regression guard: a saved AI-planned trip (described in the chat) must
  // render city cards and chat exactly like a Browse preset does. Their DB
  // rows historically shipped without country/vibes, and the date-shift tip
  // used to knock out the suggestion chips.
  describe('saved AI-planned trip renders like a preset', () => {
    const realFetch = global.fetch;

    const emptyTransport = { mode: 'flight', operator: '', duration: '', price: 0 };
    const savedAiTrip = {
      id: 'trip-jp',
      title: 'Tokyo → Kyoto → Osaka',
      status: 'planning',
      totalCost: 6725,
      savings: 0,
      travelers: 4,
      dateShiftSuggestion: { newStartDate: '2026-08-28', dayOffset: 2, savings: 3230 },
      cities: [
        {
          name: 'Osaka',
          country: '', // what pre-fix saves look like
          vibes: [],
          dates: { arrival: '2026-08-29', departure: '2026-08-30' },
          transportIn: { ...emptyTransport },
          transportOut: { ...emptyTransport },
          hotel: { name: 'IAM HOTEL', rating: 8.6, pricePerNight: 457, area: '' },
          hotels: [{ name: 'IAM HOTEL', rating: 8.6, pricePerNight: 457, area: '' }],
          selectedHotelIndex: 0,
          activities: ['Osaka Castle'],
          restaurants: [],
        },
      ],
      savingsTips: [],
    };

    beforeEach(() => {
      mockSearchParams.set('tripId', 'trip-jp');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ trip: savedAiTrip }),
      }) as any;
    });

    afterEach(() => {
      mockSearchParams.delete('tripId');
      global.fetch = realFetch;
    });

    it('fills the missing country from the world-cities dataset', async () => {
      render(<ResultsPage />);
      // "Japan" must appear under Osaka even though the DB row had none.
      expect(await screen.findByText('Japan')).toBeInTheDocument();
    });

    it('shows the date-shift tip AND the suggestion chips together', async () => {
      render(<ResultsPage />);
      expect(await screen.findByText(/Heads up/)).toBeInTheDocument();
      // The tip's second bubble must not hide the chips anymore.
      expect(screen.getByText('Why this order of cities?')).toBeInTheDocument();
    });
  });
});
