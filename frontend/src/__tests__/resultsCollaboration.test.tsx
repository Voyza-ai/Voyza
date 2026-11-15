import './mocks';
import { mockSearchParams, mockPush } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ResultsPage from '@/app/results/page';
import {
  getCanvasSession,
  getCanvasRole,
  getCanvasSuggestions,
  joinCanvasByLink,
  postCanvasSuggestion,
  saveCanvas,
  compareLeg,
  searchHotels,
  searchActivities,
} from '@/lib/api';
import { useTripStore } from '@/store/tripStore';
import { buildCity, buildTrip } from './fixtures';

/**
 * The results page took over the canvas: a saved trip is a shared, live
 * document here — Share (not "Edit in Canvas"), roles, share-link joins,
 * access gates, live edits, proposals, and rearranging the trip (remove,
 * add, reorder, change home airports) with what each change leaves stale
 * searched again.
 */

const mockedGetSession = getCanvasSession as jest.MockedFunction<typeof getCanvasSession>;
const mockedGetRole = getCanvasRole as jest.MockedFunction<typeof getCanvasRole>;
const mockedGetSuggestions = getCanvasSuggestions as jest.MockedFunction<typeof getCanvasSuggestions>;
const mockedJoin = joinCanvasByLink as jest.MockedFunction<typeof joinCanvasByLink>;
const mockedPost = postCanvasSuggestion as jest.MockedFunction<typeof postCanvasSuggestion>;
const mockedSaveCanvas = saveCanvas as jest.MockedFunction<typeof saveCanvas>;
const mockedCompareLeg = compareLeg as jest.MockedFunction<typeof compareLeg>;
const mockedSearchHotels = searchHotels as jest.MockedFunction<typeof searchHotels>;
const mockedSearchActivities = searchActivities as jest.MockedFunction<typeof searchActivities>;

const TRIP_ID = 'trip-test-123';
const realFetch = global.fetch;

function threeCityTrip() {
  return buildTrip({
    id: TRIP_ID,
    title: 'My Euro Trip',
    cities: [
      buildCity({ name: 'Rome', dates: { arrival: '2026-06-15', departure: '2026-06-18' }, colorIndex: 0 }),
      buildCity({ name: 'Florence', dates: { arrival: '2026-06-18', departure: '2026-06-20' }, colorIndex: 1 }),
      buildCity({ name: 'Venice', dates: { arrival: '2026-06-20', departure: '2026-06-22' }, colorIndex: 2 }),
    ],
  });
}

function serveTrip(trip = threeCityTrip()) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ trip }) }) as any;
}

function asRole(role: string) {
  mockedGetSession.mockResolvedValue({ session: { state: null }, role } as any);
  mockedGetRole.mockResolvedValue({ role } as any);
}

const rt = jest.requireMock('@/hooks/useCanvasRealtime');
const originalHook = rt.useCanvasRealtime;
const makeRt = (overrides: any = {}) => ({
  canvasState: null,
  suggestions: [],
  isConnected: true,
  updateState: jest.fn(),
  presence: [],
  remoteOp: null,
  broadcastOp: jest.fn(),
  roleEvent: null,
  broadcastRoleChange: jest.fn(),
  cursorEvent: null,
  broadcastCursor: jest.fn(),
  suggestionsTick: 0,
  suggestionDecision: null,
  broadcastSuggestionsChanged: jest.fn(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ currentTrip: null, tripPicks: null, restoredFromSession: false });
  mockSearchParams.set('tripId', TRIP_ID);
  mockedGetSuggestions.mockResolvedValue({ suggestions: [] });
  serveTrip();
});

afterEach(() => {
  mockSearchParams.delete('tripId');
  mockSearchParams.delete('share');
  global.fetch = realFetch;
  rt.useCanvasRealtime = originalHook;
  asRole('viewer');
});

describe('the header on a saved trip', () => {
  it('owner: Share in place of Edit in Canvas, no Adjust trip, the total under the title', async () => {
    asRole('owner');
    render(<ResultsPage />);
    expect(await screen.findByText('My Euro Trip')).toBeInTheDocument();
    expect(await screen.findByTestId('share-button')).toBeInTheDocument();
    expect(screen.queryByText('Edit in Canvas')).not.toBeInTheDocument();
    expect(screen.queryByText('Adjust trip')).not.toBeInTheDocument();
    expect(screen.getByText('Total trip')).toBeInTheDocument();
    // The owner can rearrange the trip.
    expect(screen.getAllByLabelText(/Drag to move/).length).toBe(3);
  });

  it('Share opens the share dialog with its link access modes', async () => {
    asRole('owner');
    render(<ResultsPage />);
    fireEvent.click(await screen.findByTestId('share-button'));
    expect(await screen.findByText('Share this trip')).toBeInTheDocument();
    expect(screen.getByText('Owner confirms edits')).toBeInTheDocument();
    expect(screen.getByText('Full access')).toBeInTheDocument();
  });

  it('viewer: no Share, "View only", no AI chat, nothing to drag or remove', async () => {
    asRole('viewer');
    render(<ResultsPage />);
    expect(await screen.findByText('View only')).toBeInTheDocument();
    expect(screen.queryByTestId('share-button')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Ask about your trip...')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Drag to move/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Remove /)).not.toBeInTheDocument();
  });

  it('editor: Share and Save a copy, and the AI chat', async () => {
    asRole('editor');
    render(<ResultsPage />);
    expect(await screen.findByText('Save a copy')).toBeInTheDocument();
    expect(screen.getByTestId('share-button')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask about your trip...')).toBeInTheDocument();
  });
});

describe('opening a shared trip', () => {
  it('joins via ?share= before loading the trip, then strips the param', async () => {
    const token = '123e4567-e89b-42d3-a456-426614174000';
    mockSearchParams.set('share', token);
    window.history.replaceState({}, '', `/results?tripId=${TRIP_ID}&share=${token}`);
    let joined = false;
    mockedJoin.mockImplementation(async () => {
      joined = true;
      return { role: 'editor', joined: true };
    });
    const fetchSpy = jest.fn().mockImplementation(async () => {
      // The trip load waits for the join.
      expect(joined).toBe(true);
      return { ok: true, json: async () => ({ trip: threeCityTrip() }) };
    });
    global.fetch = fetchSpy as any;
    asRole('editor');

    render(<ResultsPage />);
    await waitFor(() => expect(mockedJoin).toHaveBeenCalledWith(TRIP_ID, token));
    await waitFor(() => expect(window.location.search).not.toContain('share='));
    expect(await screen.findByText('My Euro Trip')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalled();
    // Said once the trip is on screen, not behind the loading screen.
    expect(await screen.findByText('You joined this trip as editor')).toBeInTheDocument();
    window.history.replaceState({}, '', '/');
  });

  it('someone with no access sees the no-access screen, not an error', async () => {
    mockedGetSession.mockRejectedValue(new Error('Not a member of this trip'));
    mockedGetRole.mockResolvedValue({ role: null } as any);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }) as any;
    render(<ResultsPage />);
    expect(await screen.findByText("You don't have access to this trip")).toBeInTheDocument();
    fireEvent.click(screen.getByText('Take me back to My Trips'));
    expect(mockPush).toHaveBeenCalledWith('/history');
  });

  it('a member the owner removes sees the removed screen', async () => {
    rt.useCanvasRealtime = () =>
      makeRt({ roleEvent: { actor: 'owner-id', targetUserId: 'u1', role: 'removed', ts: 1 } });
    mockedGetSession.mockResolvedValue({ session: { state: null }, role: 'editor' } as any);
    mockedGetRole.mockResolvedValue({ role: null } as any);
    render(<ResultsPage />);
    expect(
      await screen.findByText("You've been removed from this trip", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('the removed screen keeps the navbar, and offers a new invite to this trip as soon as it arrives', async () => {
    const { useNotificationsStore } = require('@/store/notificationsStore');
    useNotificationsStore.setState({ items: [], unreadCount: 0 });
    rt.useCanvasRealtime = () =>
      makeRt({ roleEvent: { actor: 'owner-id', targetUserId: 'u1', role: 'removed', ts: 1 } });
    mockedGetSession.mockResolvedValue({ session: { state: null }, role: 'editor' } as any);
    mockedGetRole.mockResolvedValue({ role: null } as any);
    render(<ResultsPage />);
    await screen.findByText("You've been removed from this trip", {}, { timeout: 4000 });
    expect(screen.getByText('BlueMurr')).toBeInTheDocument(); // the navbar (and its bell)
    expect(screen.queryByTestId('reinvite-note')).not.toBeInTheDocument();
    // An OLD invite to this trip (from before the removal) is not offered…
    act(() =>
      useNotificationsStore.setState({
        items: [
          { id: 'old', type: 'canvas_invite', created_at: new Date(Date.now() - 3600_000).toISOString(), read_at: null,
            title: '', body: '', data: { tripId: TRIP_ID, role: 'editor', link: `/results?tripId=${TRIP_ID}&share=old` } },
        ],
      }),
    );
    expect(screen.queryByTestId('reinvite-note')).not.toBeInTheDocument();
    // …a new one is.
    act(() =>
      useNotificationsStore.setState({
        items: [
          { id: 'new', type: 'canvas_invite', created_at: new Date().toISOString(), read_at: null,
            title: '', body: '', data: { tripId: TRIP_ID, role: 'suggester', link: `/results?tripId=${TRIP_ID}&share=tok2` } },
          ...useNotificationsStore.getState().items,
        ],
      }),
    );
    expect(screen.getByTestId('reinvite-note')).toHaveTextContent('invited back as a suggester');
    expect(screen.getByRole('button', { name: 'Open the trip' })).toBeInTheDocument();
  });

  it('a removed member leaves the live channel, so nobody sees them online any more', async () => {
    const calls: any[] = [];
    rt.useCanvasRealtime = (id: string, me: any) => {
      calls.push(me);
      return makeRt({ roleEvent: { actor: 'owner-id', targetUserId: 'u1', role: 'removed', ts: 1 } });
    };
    mockedGetSession.mockResolvedValue({ session: { state: null }, role: 'editor' } as any);
    mockedGetRole.mockResolvedValue({ role: null } as any);
    render(<ResultsPage />);
    await screen.findByText("You've been removed from this trip", {}, { timeout: 4000 });
    expect(calls.some((me) => me && me.id === 'u1')).toBe(true); // was on the trip
    expect(calls.at(-1)).toBeNull(); // and is off it now
  });

  it('an old link after "Reset link" says so on the no-access screen', async () => {
    const token = '123e4567-e89b-42d3-a456-426614174000';
    mockSearchParams.set('share', token);
    mockedJoin.mockRejectedValue(Object.assign(new Error('Invalid share link'), { status: 404 }));
    mockedGetSession.mockRejectedValue(new Error('Not a member of this trip'));
    mockedGetRole.mockResolvedValue({ role: null } as any);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }) as any;
    render(<ResultsPage />);
    expect(await screen.findByText(/no longer valid\. The owner may have reset it/)).toBeInTheDocument();
    mockSearchParams.delete('share');
  });

  it('a mid-transfer role blip shows "now an editor", never the removed screen', async () => {
    rt.useCanvasRealtime = () =>
      makeRt({ roleEvent: { actor: 'someone', targetUserId: 'u1', role: 'editor', ts: 1 } });
    mockedGetSession.mockResolvedValue({ session: { state: null }, role: 'owner' } as any);
    mockedGetRole.mockResolvedValueOnce({ role: null } as any).mockResolvedValue({ role: 'editor' } as any);
    render(<ResultsPage />);
    expect(await screen.findByText(/you're now an editor/i, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText("You've been removed from this trip")).not.toBeInTheDocument();
  });
});

describe('live edits', () => {
  it("applies another person's live edit", async () => {
    const op = {
      state: { trip: { title: 'My Euro Trip' }, cities: [buildCity({ name: 'Berlin', colorIndex: 0 })] },
      actor: 'someone-else',
      ts: 1,
    };
    rt.useCanvasRealtime = () => makeRt({ remoteOp: op });
    asRole('editor');
    render(<ResultsPage />);
    await waitFor(() => expect(useTripStore.getState().currentTrip?.cities.map((c) => c.name)).toEqual(['Berlin']));
    // A received change is not searched again on this screen.
    expect(mockedCompareLeg).not.toHaveBeenCalled();
  });

  it("the owner's edit is broadcast and saved (the owner's page keeps the shared trip)", async () => {
    const broadcastOp = jest.fn();
    rt.useCanvasRealtime = () => makeRt({ broadcastOp });
    asRole('owner');
    mockedSaveCanvas.mockResolvedValue({ saved: true } as any);
    render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Florence'));
    await waitFor(() => expect(broadcastOp).toHaveBeenCalled(), { timeout: 2000 });
    const sent = broadcastOp.mock.calls.at(-1)![0];
    expect(sent.cities.map((c: any) => c.name)).toEqual(['Rome', 'Venice']);
    await waitFor(() => expect(mockedSaveCanvas).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('two people removing different cities at once: both removals stick (found live with 4 people)', async () => {
    const { computeCollabDelta, tripToCollabState } = require('@/lib/tripCollab');
    const broadcastOp = jest.fn();
    let op: any = null;
    rt.useCanvasRealtime = () => makeRt({ remoteOp: op, broadcastOp });
    asRole('owner');
    mockedSaveCanvas.mockResolvedValue({ saved: true } as any);
    const { rerender } = render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Florence'));
    await waitFor(() => expect(broadcastOp).toHaveBeenCalled(), { timeout: 2000 });
    // What went out says what changed, not just the result.
    expect(broadcastOp.mock.calls.at(-1)![0].delta.removed).toEqual(['florence']);
    // Meanwhile an editor, who hadn't seen that yet, removed Venice.
    const base = threeCityTrip();
    const theirs = { ...base, cities: base.cities.filter((c) => c.name !== 'Venice') };
    op = { state: { ...tripToCollabState(theirs), delta: computeCollabDelta(base, theirs) }, actor: 'editor-id', ts: Date.now() };
    rerender(<ResultsPage />);
    await waitFor(() => expect(useTripStore.getState().currentTrip?.cities.map((c) => c.name)).toEqual(['Rome']));
  });

  it("approving a proposal applies just its change: the owner's newer edits stay", async () => {
    const { computeCollabDelta, tripToCollabState } = require('@/lib/tripCollab');
    // The suggester removed Venice from the 3-city trip…
    const base = threeCityTrip();
    const proposed = { ...base, cities: base.cities.filter((c) => c.name !== 'Venice') };
    mockedGetSuggestions.mockResolvedValue({
      suggestions: [
        { id: 's1', type: 'edit', status: 'pending', user_id: 'sugg', created_at: new Date().toISOString(),
          payload: { state: tripToCollabState(proposed), delta: computeCollabDelta(base, proposed), summary: 'Removed Venice' } },
      ],
    } as any);
    asRole('owner');
    mockedSaveCanvas.mockResolvedValue({ saved: true } as any);
    render(<ResultsPage />);
    // …and meanwhile the owner removed Florence.
    fireEvent.click(await screen.findByLabelText('Remove Florence'));
    await waitFor(() => expect(useTripStore.getState().currentTrip?.cities.map((c) => c.name)).toEqual(['Rome', 'Venice']));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    // Venice goes (the proposal); Florence does NOT come back.
    await waitFor(() => expect(useTripStore.getState().currentTrip?.cities.map((c) => c.name)).toEqual(['Rome']));
  });

  it('a viewer never broadcasts', async () => {
    const broadcastOp = jest.fn();
    rt.useCanvasRealtime = () => makeRt({ broadcastOp });
    asRole('viewer');
    render(<ResultsPage />);
    expect(await screen.findByText('View only')).toBeInTheDocument();
    act(() => {
      const t = useTripStore.getState().currentTrip!;
      useTripStore.setState({ currentTrip: { ...t, travelers: 5 } });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(broadcastOp).not.toHaveBeenCalled();
  });

  it('a suggester edits a copy and proposes it; the view resets after sending', async () => {
    asRole('suggester');
    mockedPost.mockResolvedValue({ suggestion: { id: 's1' } } as any);
    render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Rome'));
    fireEvent.click(await screen.findByText('Propose changes'));
    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith(
        TRIP_ID,
        'edit',
        expect.objectContaining({
          summary: expect.arrayContaining(['Remove Rome']),
          state: expect.objectContaining({ cities: expect.any(Array) }),
        }),
      ),
    );
    expect(mockedSaveCanvas).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(useTripStore.getState().currentTrip?.cities.map((c) => c.name)).toEqual(['Rome', 'Florence', 'Venice']),
    );
  });

  it("a suggester's proposal tells the owner's page to re-read the suggestions", async () => {
    const broadcastSuggestionsChanged = jest.fn();
    rt.useCanvasRealtime = () => makeRt({ broadcastSuggestionsChanged });
    asRole('suggester');
    mockedPost.mockResolvedValue({ suggestion: { id: 's1' } } as any);
    render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Rome'));
    fireEvent.click(await screen.findByText('Propose changes'));
    await waitFor(() => expect(broadcastSuggestionsChanged).toHaveBeenCalled());
  });

  it("a suggester is told when the owner approves their proposal", async () => {
    let tick = 0;
    let decision: any = null;
    rt.useCanvasRealtime = () => makeRt({ suggestionsTick: tick, suggestionDecision: decision });
    asRole('suggester');
    const pending = { id: 's1', type: 'edit', status: 'pending', suggested_by: 'u1', created_at: new Date().toISOString(), payload: { summary: ['Remove Rome'] } };
    mockedPost.mockResolvedValue({ suggestion: pending } as any);
    const { rerender } = render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Rome'));
    fireEvent.click(await screen.findByText('Propose changes'));
    await screen.findByText('Sent to the owner for approval');
    // As the server answers: pending only, so the decided one is just gone.
    mockedGetSuggestions.mockResolvedValue({ suggestions: [] } as any);
    decision = { id: 's1', status: 'approved' };
    tick = 1;
    rerender(<ResultsPage />);
    expect(await screen.findByText('Your proposal was approved')).toBeInTheDocument();
  });

  it("the owner's changes that arrive during a suggester's edit are put on when they send it", async () => {
    let op: any = null;
    rt.useCanvasRealtime = () => makeRt({ remoteOp: op });
    asRole('suggester');
    mockedPost.mockResolvedValue({ suggestion: { id: 's2' } } as any);
    const { rerender } = render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Venice'));
    // Meanwhile the owner dropped Florence.
    const cities = useTripStore.getState().currentTrip!.cities;
    op = {
      state: { trip: {}, cities: [cities[0], { ...cities[1], name: 'Venice' }].map((c, i) => ({ ...c, colorIndex: i })) },
      actor: 'owner-id',
      ts: 5,
    };
    rerender(<ResultsPage />);
    // Kept: the suggester's own edit is still on screen.
    expect(useTripStore.getState().currentTrip!.cities.map((c) => c.name)).toEqual(['Rome', 'Florence']);
    fireEvent.click(await screen.findByText('Propose changes'));
    await waitFor(() =>
      expect(useTripStore.getState().currentTrip!.cities.map((c) => c.name)).toEqual(['Rome', 'Venice']),
    );
  });

  it('the owner sees a new proposal when told the suggestions changed (no reload)', async () => {
    // Measured live: the table's change feed never delivered the proposal.
    let tick = 0;
    rt.useCanvasRealtime = () => makeRt({ suggestionsTick: tick });
    asRole('owner');
    const { rerender } = render(<ResultsPage />);
    await screen.findByLabelText('Remove Rome');
    expect(screen.queryByText(/Pending Suggestions/)).not.toBeInTheDocument();
    mockedGetSuggestions.mockResolvedValue({
      suggestions: [
        { id: 's9', type: 'edit', status: 'pending', suggested_by: 'guest', created_at: new Date().toISOString(),
          payload: { summary: ['Remove Rome'], state: { trip: {}, cities: [] } } },
      ],
    } as any);
    tick = 1;
    rerender(<ResultsPage />);
    expect(await screen.findByText(/Pending Suggestions \(1\)/)).toBeInTheDocument();
  });
});

describe('rearranging the trip', () => {
  const flight = {
    flightOption: {
      id: 'f1', price: 120, currency: 'USD',
      departure: '2026-06-15T09:00:00', arrival: '2026-06-15T10:10:00',
      durationMinutes: 70, stops: 0, carrier: 'ITA Airways', carrierCode: 'AZ', bookingUrl: 'https://example.com',
    } as any,
    trainOption: null,
    cheapest: 'flight', fastest: 'flight', recommendation: 'flight', priceDifference: 0, timeDifference: 0,
  } as any;

  it('removing a middle city re-chains the dates and re-searches the new adjacent pair', async () => {
    asRole('owner');
    mockedCompareLeg.mockResolvedValue(flight);
    render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Florence'));

    const cities = () => useTripStore.getState().currentTrip!.cities;
    expect(cities().map((c) => c.name)).toEqual(['Rome', 'Venice']);
    // Venice keeps its 2 nights and now follows Rome.
    expect(cities()[1].dates).toEqual({ arrival: '2026-06-18', departure: '2026-06-20' });
    await waitFor(() =>
      expect(mockedCompareLeg).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'Rome', destination: 'Venice', date: '2026-06-18' }),
      ),
    );
    await waitFor(() => expect(cities()[0].transportOut.price).toBe(120));
  });

  it('an auto-titled trip follows its stops; a chosen name stays; the "vs original order" saving goes', async () => {
    serveTrip({ ...threeCityTrip(), title: 'Rome → Florence → Venice', savings: 225 });
    asRole('owner');
    mockedCompareLeg.mockResolvedValue(flight);
    render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Florence'));
    const t = useTripStore.getState().currentTrip!;
    expect(t.title).toBe('Rome → Venice');
    expect(t.savings).toBe(0);
  });

  it('a name the owner chose is kept when the stops change', async () => {
    asRole('owner');
    mockedCompareLeg.mockResolvedValue(flight);
    render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Remove Florence'));
    expect(useTripStore.getState().currentTrip!.title).toBe('My Euro Trip');
  });

  it('the last city cannot be removed', async () => {
    serveTrip(buildTrip({ id: TRIP_ID, cities: [buildCity({ name: 'Rome' })] }));
    asRole('owner');
    render(<ResultsPage />);
    expect(await screen.findAllByLabelText(/Drag to move/)).toHaveLength(1);
    expect(screen.queryByLabelText('Remove Rome')).not.toBeInTheDocument();
  });

  it('adding a city between two stops dates it, finds its hotels and AI picks, and prices its legs', async () => {
    asRole('owner');
    mockedCompareLeg.mockResolvedValue(flight);
    mockedSearchHotels.mockResolvedValue([] as any);
    render(<ResultsPage />);
    fireEvent.click(await screen.findByLabelText('Add a city after Rome'));
    const input = await screen.findByPlaceholderText('Search a city or country...');
    fireEvent.change(input, { target: { value: 'Bologna' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const cities = () => useTripStore.getState().currentTrip!.cities;
    await waitFor(() => expect(cities().map((c) => c.name)).toEqual(['Rome', 'Bologna', 'Florence', 'Venice']));
    expect(cities()[1].dates.arrival).toBe('2026-06-18');
    await waitFor(() => expect(mockedSearchHotels).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bologna' })));
    await waitFor(() => expect(mockedSearchActivities).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockedCompareLeg).toHaveBeenCalledWith(expect.objectContaining({ origin: 'Rome', destination: 'Bologna' })),
    );
  });
});
