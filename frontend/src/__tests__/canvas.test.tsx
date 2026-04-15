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

  it('shows trip title from canvas session', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('My Euro Trip')).toBeInTheDocument();
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

  it('Invite button opens InviteModal', async () => {
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
      expect(screen.getByText('Share Canvas')).toBeInTheDocument();
    });
  });

  it('handles canvas session fetch failure gracefully', async () => {
    mockedGetSession.mockRejectedValue(new Error('403 Forbidden'));
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });

    const { container } = render(<CanvasPage />);
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
  });

  it('calls saveCanvas API when Save is clicked', async () => {
    mockedGetSession.mockResolvedValue({
      session: { state: mockCanvasState },
      role: 'owner',
    });
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] });
    mockedSaveCanvas.mockResolvedValue({ saved: true, savedAt: '2026-06-15T00:00:00Z' });

    render(<CanvasPage />);

    await waitFor(() => {
      expect(screen.getByText('Save')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockedSaveCanvas).toHaveBeenCalledWith('trip-test-123', mockCanvasState);
    });
  });
});
