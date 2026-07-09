import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CanvasPage from '@/app/canvas/[tripId]/page';
import { getCanvasSession, saveCanvas, getCanvasSuggestions } from '@/lib/api';
import { buildCity } from './fixtures';

const mockedGetSession = getCanvasSession as jest.MockedFunction<typeof getCanvasSession>;
const mockedSaveCanvas = saveCanvas as jest.MockedFunction<typeof saveCanvas>;
const mockedGetSuggestions = getCanvasSuggestions as jest.MockedFunction<typeof getCanvasSuggestions>;

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

  it('Invite button only visible to owner role', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Invite')).toBeInTheDocument();
    });
  });

  it('Invite button opens InviteModal', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Invite')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Invite'));
    await waitFor(() => {
      expect(screen.getByText('Share Canvas')).toBeInTheDocument();
    });
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
});
