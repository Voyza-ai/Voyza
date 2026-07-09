import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CanvasPage from '@/app/canvas/[tripId]/page';
import { getCanvasSession, saveCanvas, getCanvasSuggestions, joinCanvasByLink } from '@/lib/api';
import { buildCity } from './fixtures';

const mockedGetSession = getCanvasSession as jest.MockedFunction<typeof getCanvasSession>;
const mockedSaveCanvas = saveCanvas as jest.MockedFunction<typeof saveCanvas>;
const mockedGetSuggestions = getCanvasSuggestions as jest.MockedFunction<typeof getCanvasSuggestions>;
const mockedJoinLink = joinCanvasByLink as jest.MockedFunction<typeof joinCanvasByLink>;

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

  it('shows route header derived from the current cities', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
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
      expect(screen.getByText('Save')).toBeInTheDocument();
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

  it('editors get a Save button too (live collaboration)', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'editor',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);
    await waitFor(() => expect(screen.getByText('Rome')).toBeInTheDocument());

    expect(screen.getByText('Save')).toBeInTheDocument();
    // ...but Share stays owner-only
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
});
