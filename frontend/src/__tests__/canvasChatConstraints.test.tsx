import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CanvasPage from '@/app/canvas/[tripId]/page';
import { getCanvasSession, getCanvasSuggestions, planChat, saveCanvas } from '@/lib/api';
import { buildCity } from './fixtures';

/**
 * The canvas must hand the AI chat the trip's constraints, and keep the ones
 * the chat adds.
 *
 * The chat speaks the results page's Trip shape; the canvas adapts its local
 * state into one (buildCanvasTrip) and back (applyChatTrip). Both adapters
 * dropped `constraints`. So on the canvas a date pin the traveller accepted
 * from the chat vanished on the spot, and the next chat turn reached the
 * backend without it — where the new overlap check (WS5) looks for earlier
 * pins to refuse a contradictory one.
 */

const mockedGetSession = getCanvasSession as jest.MockedFunction<typeof getCanvasSession>;
const mockedGetSuggestions = getCanvasSuggestions as jest.MockedFunction<typeof getCanvasSuggestions>;
const mockedPlanChat = planChat as jest.MockedFunction<typeof planChat>;
const mockedSaveCanvas = saveCanvas as jest.MockedFunction<typeof saveCanvas>;

const ROME_PIN = { city: 'Rome', arrival: '2026-06-15', departure: '2026-06-18' };
const FLORENCE_PIN = { city: 'Florence', arrival: '2026-06-19', departure: '2026-06-21' };

const cities = () => [
  buildCity({ name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' } }),
  buildCity({ name: 'Florence', dates: { arrival: '2026-06-18', departure: '2026-06-20' } }),
];

function openCanvas(trip: Record<string, unknown>) {
  mockedGetSession.mockResolvedValue({
    session: { state: { trip: { title: 'Italy', travelers: 2, ...trip }, cities: cities() } },
    role: 'owner',
  } as any);
  mockedGetSuggestions.mockResolvedValue({ suggestions: [] });
  render(<CanvasPage />);
}

async function sendChat(text: string) {
  const input = await screen.findByPlaceholderText('Ask about your trip...');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
}

const lastChatTrip = () => mockedPlanChat.mock.calls[mockedPlanChat.mock.calls.length - 1][0].currentTrip;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('canvas ⇄ chat carry the trip constraints', () => {
  it('the chat sees the constraints the saved canvas already holds', async () => {
    openCanvas({ constraints: { pinned_cities: [ROME_PIN] } });
    await waitFor(() => expect(screen.getByText('Rome')).toBeInTheDocument());

    mockedPlanChat.mockResolvedValueOnce({ type: 'answer', reply: 'Sure.' });
    await sendChat('Why this order?');
    await waitFor(() => expect(mockedPlanChat).toHaveBeenCalledTimes(1));
    expect(lastChatTrip().constraints).toEqual({ pinned_cities: [ROME_PIN] });
  });

  it('a pin accepted from the chat is kept, reaches the next turn, and is saved', async () => {
    openCanvas({ constraints: { pinned_cities: [ROME_PIN] } });
    await waitFor(() => expect(screen.getByText('Rome')).toBeInTheDocument());

    const shifted = cities();
    shifted[1] = { ...shifted[1], dates: { arrival: '2026-06-19', departure: '2026-06-21' } };
    mockedPlanChat.mockResolvedValueOnce({
      type: 'proposal',
      reply: 'Here is the change.',
      proposal: {
        kind: 'date_shift',
        toolName: 'pin_city_dates',
        toolInput: FLORENCE_PIN,
        diff: [{ city: 'Florence', oldArrival: '2026-06-18', newArrival: '2026-06-19', oldDeparture: '2026-06-20', newDeparture: '2026-06-21' }],
        proposedConstraints: { pinned_cities: [ROME_PIN, FLORENCE_PIN] },
        proposedTrip: {
          title: 'Italy',
          travelers: 2,
          cities: shifted,
          constraints: { pinned_cities: [ROME_PIN, FLORENCE_PIN] },
        },
      },
    } as any);
    await sendChat('Pin Florence to Jun 19–21');
    fireEvent.click(await screen.findByText('Accept'));
    await screen.findByText(/Applied to your trip/);

    mockedPlanChat.mockResolvedValueOnce({ type: 'answer', reply: 'Noted.' });
    await sendChat('And Rome?');
    await waitFor(() => expect(mockedPlanChat).toHaveBeenCalledTimes(2));
    expect(lastChatTrip().constraints).toEqual({ pinned_cities: [ROME_PIN, FLORENCE_PIN] });

    // The owner's Save writes the canvas state, so the pin survives a reload.
    fireEvent.click(await screen.findByText('Save'));
    await waitFor(() => expect(mockedSaveCanvas).toHaveBeenCalled());
    const saved = mockedSaveCanvas.mock.calls[mockedSaveCanvas.mock.calls.length - 1][1];
    expect(saved.trip.constraints).toEqual({ pinned_cities: [ROME_PIN, FLORENCE_PIN] });
  });

  it('a chat edit that carries no constraints keeps the ones already there', async () => {
    openCanvas({ constraints: { pinned_cities: [ROME_PIN] } });
    await waitFor(() => expect(screen.getByText('Rome')).toBeInTheDocument());

    mockedPlanChat.mockResolvedValueOnce({
      type: 'proposal',
      reply: 'Here is the change.',
      proposal: {
        kind: 'date_shift',
        toolName: 'set_min_days',
        toolInput: {},
        diff: [],
        proposedConstraints: null,
        proposedTrip: { title: 'Italy', travelers: 2, cities: cities() },
      },
    } as any);
    await sendChat('At least 3 nights in Rome');
    fireEvent.click(await screen.findByText('Accept'));
    await screen.findByText(/Applied to your trip/);

    mockedPlanChat.mockResolvedValueOnce({ type: 'answer', reply: 'Noted.' });
    await sendChat('Anything else?');
    await waitFor(() => expect(mockedPlanChat).toHaveBeenCalledTimes(2));
    expect(lastChatTrip().constraints).toEqual({ pinned_cities: [ROME_PIN] });
  });

  it('a canvas without constraints stays without them', async () => {
    openCanvas({});
    await waitFor(() => expect(screen.getByText('Rome')).toBeInTheDocument());
    mockedPlanChat.mockResolvedValueOnce({ type: 'answer', reply: 'Sure.' });
    await sendChat('Hi');
    await waitFor(() => expect(mockedPlanChat).toHaveBeenCalledTimes(1));
    expect(lastChatTrip().constraints).toBeUndefined();
  });
});
