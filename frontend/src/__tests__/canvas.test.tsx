import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CanvasPage from '@/app/canvas/[tripId]/page';
import { getCanvasSession, saveCanvas, getCanvasSuggestions, joinCanvasByLink, postCanvasSuggestion, compareLeg } from '@/lib/api';
import { buildCity } from './fixtures';

const mockedGetSession = getCanvasSession as jest.MockedFunction<typeof getCanvasSession>;
const mockedSaveCanvas = saveCanvas as jest.MockedFunction<typeof saveCanvas>;
const mockedGetSuggestions = getCanvasSuggestions as jest.MockedFunction<typeof getCanvasSuggestions>;
const mockedJoinLink = joinCanvasByLink as jest.MockedFunction<typeof joinCanvasByLink>;
const mockedPostSuggestion = postCanvasSuggestion as jest.MockedFunction<typeof postCanvasSuggestion>;
const mockedCompareLeg = compareLeg as jest.MockedFunction<typeof compareLeg>;

beforeEach(() => {
  jest.clearAllMocks();
});

const mockCanvasState = {
  trip: { title: 'My Euro Trip' },
  cities: [
    buildCity({ name: 'Rome' }),
    buildCity({ name: 'Florence' }),
  ],
};

describe('CanvasPage', () => {
  it('renders city cards from canvas session state', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Rome')).toBeInTheDocument();
      expect(screen.getByText('Florence')).toBeInTheDocument();
    });
  });

  it('shows the trip name the owner chose, not the derived route', async () => {
    // A named trip keeps its name in the header — that name is what everyone
    // the trip is shared with sees, so it must win over the city chain.
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('My Euro Trip')).toBeInTheDocument();
    });
    expect(screen.queryByText('Rome → Florence')).not.toBeInTheDocument();
  });

  it('falls back to the route when the trip has no name', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: { ...mockCanvasState, trip: { title: '' } } },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Rome → Florence')).toBeInTheDocument();
    });
  });

  it('Save button only visible to owner role', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Saved ✓')).toBeInTheDocument();
    });
  });

  it('Save button hidden for viewer role', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'viewer',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Rome')).toBeInTheDocument();
    });
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('Share button only visible to owner role', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Share')).toBeInTheDocument();
    });
  });

  it('Share button opens the share dialog with link access modes', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Share')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Share'));
    await waitFor(() => {
      expect(screen.getByText('Share this trip')).toBeInTheDocument();
    });
    // The three link access modes
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.getByText('Owner confirms edits')).toBeInTheDocument();
    expect(screen.getByText('Full access')).toBeInTheDocument();
  });

  it('editors get Save-a-copy (not the canonical Save)', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'editor',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);
    await waitFor(() => expect(screen.getByText('Rome')).toBeInTheDocument());

    expect(screen.getByText('Save a copy')).toBeInTheDocument();
    expect(screen.queryByText('Saved ✓')).not.toBeInTheDocument();
    // ...and Share stays owner-only
    expect(screen.queryByText('Share')).not.toBeInTheDocument();
  });

  it('handles canvas session fetch failure gracefully', async () => {
    mockedGetSession.mockRejectedValue(new Error('403 Forbidden'));
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);
    // Should not crash — renders Canvas title as fallback
    await waitFor(() => {
      expect(screen.getByText('Canvas')).toBeInTheDocument();
    });
  });

  it('shows Live indicator when connected', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Live')).toBeInTheDocument();
    });
  });

  it('renders empty canvas when no cities', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: { trip: { title: 'Empty Trip' }, cities: [] } },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Empty Trip')).toBeInTheDocument();
    });
    expect(screen.getByText('No cities yet')).toBeInTheDocument();
  });

  it('shows VOYZA logo in top bar', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('VOYZA')).toBeInTheDocument();
    });
  });

  it('shows the live total pill and the Voyza AI chat dock for owners', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);
    await waitFor(() => expect(screen.getByText('Rome')).toBeInTheDocument());

    // Header total pill (fixture hotels/nights/transports sum > 0)
    expect(screen.getByText('Total')).toBeInTheDocument();
    // Docked chat (same panel as results)
    expect(screen.getByPlaceholderText('Ask about your trip...')).toBeInTheDocument();
    expect(screen.getByLabelText('Close Voyza AI chat')).toBeInTheDocument();
  });

  it('hides the Voyza AI chat for viewers', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'viewer',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);
    await waitFor(() => expect(screen.getByText('Rome')).toBeInTheDocument());

    expect(screen.queryByPlaceholderText('Ask about your trip...')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Open Voyza AI chat')).not.toBeInTheDocument();
  });

  it('joins via ?share= link token, then strips the param', async () => {
    const token = '123e4567-e89b-42d3-a456-426614174000';
    window.history.replaceState({}, '', `/canvas/trip-test-123?share=${token}`);
    mockedJoinLink.mockResolvedValue({ role: 'editor', joined: true });
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'editor',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(mockedJoinLink).toHaveBeenCalledWith('trip-test-123', token);
    });
    // Param stripped so refreshes don't re-join
    await waitFor(() => {
      expect(window.location.search).not.toContain('share=');
    });
    // Session loads after the join and the canvas renders
    expect(await screen.findByText('Rome')).toBeInTheDocument();

    window.history.replaceState({}, '', '/');
  });

  describe('live sync (Phase B)', () => {
    const rt = jest.requireMock('@/hooks/useCanvasRealtime');
    const makeRt = (overrides: any = {}) => ({
      canvasState: null,
      suggestions: [],
      isConnected: true,
      updateState: jest.fn(),
      presence: [],
      remoteOp: null,
      broadcastOp: jest.fn(),
      ...overrides,
    });
    const originalHook = rt.useCanvasRealtime;
    afterEach(() => {
      rt.useCanvasRealtime = originalHook;
      jest.useRealTimers();
    });

    it('applies a live op broadcast by another user', async () => {
      // Stable object — a fresh remoteOp per render would loop the effect.
      const op = {
        state: { trip: {}, cities: [buildCity({ name: 'Berlin' })] },
        actor: 'someone-else',
        ts: 1,
      };
      rt.useCanvasRealtime = () => makeRt({ remoteOp: op });
      mockedGetSession.mockResolvedValue({
        session: { state: mockCanvasState },
        role: 'editor',
      });
      mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

      render(<CanvasPage />);
      // The remote op (Berlin) wins over the loaded session (Rome/Florence).
      // Berlin appears in both the header route title and the city card.
      expect((await screen.findAllByText('Berlin')).length).toBeGreaterThan(0);
      await waitFor(() => {
        expect(screen.queryByText('Rome')).not.toBeInTheDocument();
      });
    });

    it('broadcasts a local edit but never persists it silently', async () => {
      // Real timers on purpose: fake timers wedge RTL's waitFor here.
      const broadcastOp = jest.fn();
      rt.useCanvasRealtime = () => makeRt({ broadcastOp });
      mockedGetSession.mockResolvedValue({
        session: { state: mockCanvasState },
        role: 'owner',
      });
      mockedGetSuggestions.mockResolvedValue({ suggestions: [] });
      mockedSaveCanvas.mockResolvedValue({ saved: true } as any);

      render(<CanvasPage />);
      expect(await screen.findByText('Rome')).toBeInTheDocument();

      // Local edit: remove Rome via the card's context menu
      fireEvent.contextMenu(screen.getByText('Rome'));
      fireEvent.click(await screen.findByText('Remove city'));

      // Broadcast fires on the 400ms debounce
      await waitFor(() => expect(broadcastOp).toHaveBeenCalled(), { timeout: 1500 });
      // …and there is NO silent autosave — persistence is the owner's
      // explicit Save (2.5s of quiet proves no timer fires).
      await new Promise((r) => setTimeout(r, 2500));
      expect(mockedSaveCanvas).not.toHaveBeenCalled();
      // The owner now has an enabled Save + a Discard
      expect(screen.getByText('Save')).toBeInTheDocument();
      expect(screen.getByText('Discard')).toBeInTheDocument();
    }, 10000);
  });

  describe('owner-confirms mode (Phase C)', () => {
    it('suggester edits locally and proposes; local view resets after sending', async () => {
      mockedGetSession.mockResolvedValue({
        session: { state: mockCanvasState },
        role: 'suggester',
      });
      mockedGetSuggestions.mockResolvedValue({ suggestions: [] });
      mockedPostSuggestion.mockResolvedValue({ suggestion: { id: 's1' } } as any);

      render(<CanvasPage />);
      expect(await screen.findByText('Rome')).toBeInTheDocument();

      // Suggesters get Propose changes, not Save / autosave status
      expect(screen.getByText('Propose changes')).toBeInTheDocument();
      expect(screen.queryByText('Saved ✓')).not.toBeInTheDocument();

      // Edit locally: remove Rome via the context menu
      fireEvent.contextMenu(screen.getByText('Rome'));
      fireEvent.click(await screen.findByText('Remove city'));
      await waitFor(() => {
        expect(screen.queryByText('Rome')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Propose changes'));

      await waitFor(() => {
        expect(mockedPostSuggestion).toHaveBeenCalledWith(
          'trip-test-123',
          'edit',
          expect.objectContaining({
            summary: expect.arrayContaining(['Remove Rome']),
            state: expect.objectContaining({ cities: expect.any(Array) }),
          }),
        );
      });
      // ...and nothing was saved directly
      expect(mockedSaveCanvas).not.toHaveBeenCalled();
      // Local view resets to canonical (Rome returns)
      expect(await screen.findAllByText('Rome')).not.toHaveLength(0);
    });
  });

  describe('stale-leg repair', () => {
    it('re-searches the new adjacent pair after removing a middle city', async () => {
      const threeCities = {
        trip: { title: 'Trio' },
        cities: [
          buildCity({ name: 'Rome' }),
          buildCity({
            name: 'Florence',
            dates: { arrival: '2026-06-18', departure: '2026-06-20' },
          }),
          buildCity({
            name: 'Venice',
            dates: { arrival: '2026-06-20', departure: '2026-06-22' },
          }),
        ],
      };
      mockedGetSession.mockResolvedValue({
        session: { state: threeCities },
        role: 'owner',
      });
      mockedGetSuggestions.mockResolvedValue({ suggestions: [] });
      mockedCompareLeg.mockResolvedValue({
        flightOption: {
          id: 'f1', price: 120, currency: 'USD',
          departure: '2026-06-18T09:00:00', arrival: '2026-06-18T10:10:00',
          durationMinutes: 70, stops: 0, carrier: 'ITA Airways',
          carrierCode: 'AZ', bookingUrl: 'https://example.com',
        } as any,
        trainOption: null,
        cheapest: 'flight', fastest: 'flight',
        recommendation: 'flight', priceDifference: 0, timeDifference: 0,
      });

      render(<CanvasPage />);
      expect(await screen.findByText('Florence')).toBeInTheDocument();

      // Remove the middle city → Rome/Venice become adjacent with a stale leg
      fireEvent.contextMenu(screen.getByText('Florence'));
      fireEvent.click(await screen.findByText('Remove city'));

      await waitFor(
        () =>
          expect(mockedCompareLeg).toHaveBeenCalledWith(
            expect.objectContaining({ origin: 'Rome', destination: 'Venice' }),
          ),
        { timeout: 2500 },
      );
      // The repaired transport lands on the connector (and the card line)
      const prices = await screen.findAllByText('$120', {}, { timeout: 2500 });
      expect(prices.length).toBeGreaterThan(0);
    }, 10000);
  });
});
