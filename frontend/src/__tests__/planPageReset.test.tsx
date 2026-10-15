import './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import PlanPage from '@/app/plan/page';
import { useTripStore } from '@/store/tripStore';
import { mockTrip } from '@/lib/mockData';

/**
 * The plan route clears the previous planning session so the planner never
 * opens on a stale trip. That reset used to run during PlanPage's render,
 * which made it a render-phase write to the Zustand store: an App Router
 * navigation renders the incoming page while the outgoing one is still
 * mounted, so /results got re-rendered mid-render and React logged
 *
 *   Warning: Cannot update a component (`ResultsPageInner`) while rendering
 *   a different component (`PlanPage`).
 *
 * These tests pin both halves: the warning stays gone, and the reset still
 * lands before the planner reads any planning state.
 */

/** Mirrors ResultsPageInner: subscribes to the whole store, no selector. */
function StoreSubscriber() {
  const { currentTrip } = useTripStore();
  return <div data-testid="subscriber">{currentTrip ? currentTrip.title : 'no trip'}</div>;
}

function Harness({ showPlan }: { showPlan: boolean }) {
  return (
    <>
      <StoreSubscriber />
      {showPlan ? <PlanPage /> : null}
    </>
  );
}

describe('PlanPage planning-session reset', () => {
  let consoleErrors: string[] = [];
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    // jsdom has no Element.scrollTo — the chat's autoscroll timer throws.
    Element.prototype.scrollTo = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    window.history.pushState({}, '', '/plan');
    useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
    consoleErrors = [];
    errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '));
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
    window.history.pushState({}, '', '/');
    sessionStorage.clear();
  });

  const renderWarnings = () =>
    consoleErrors.filter((e) => /Cannot update a component/.test(e));

  it('does not update an already-mounted store subscriber while rendering', async () => {
    // A stale session, exactly as it looks after a trip was planned.
    useTripStore.setState({
      currentTrip: mockTrip,
      answers: { destinations: ['Rome'], travelers: 2 },
      chatHistory: [{ role: 'user', content: 'rome please' }],
    });

    // Subscriber mounts first, then PlanPage joins the tree — the shape of a
    // /results → /plan navigation, where both are mounted at once.
    const { rerender } = render(<Harness showPlan={false} />);
    expect(screen.getByTestId('subscriber')).toHaveTextContent(mockTrip.title);

    rerender(<Harness showPlan />);

    // The reset still happens, just from an effect instead of the render pass.
    await waitFor(() => expect(useTripStore.getState().currentTrip).toBeNull());
    expect(screen.getByTestId('subscriber')).toHaveTextContent('no trip');
    expect(renderWarnings()).toEqual([]);
  });

  it('clears a stale planning session on a fresh visit', async () => {
    useTripStore.setState({
      currentTrip: mockTrip,
      answers: { destinations: ['Rome'], travelers: 2, budget: 3000 },
      chatHistory: [{ role: 'assistant', content: 'Love it — Rome it is' }],
    });

    render(<PlanPage />);

    await waitFor(() => {
      const s = useTripStore.getState();
      expect(s.answers).toEqual({});
      expect(s.chatHistory).toEqual([]);
      expect(s.currentTrip).toBeNull();
    });

    // A wiped session opens on the intent picker, not the resumed chat.
    expect(
      await screen.findByText('What kind of trip are you planning?'),
    ).toBeInTheDocument();
    expect(renderWarnings()).toEqual([]);
  });

  it('keeps the whole session on ?resume=1 (the "Adjust trip" path)', async () => {
    window.history.pushState({}, '', '/plan?resume=1');
    const answers = { destinations: ['Rome'], travelers: 2, budget: 3000 };
    const chatHistory = [{ role: 'user' as const, content: 'rome please' }];
    useTripStore.setState({ currentTrip: mockTrip, answers, chatHistory });

    render(<PlanPage />);

    // Give the mount effects a chance to (wrongly) wipe the store.
    await new Promise((r) => setTimeout(r, 50));

    const s = useTripStore.getState();
    expect(s.answers).toEqual(answers);
    expect(s.chatHistory).toEqual(chatHistory);
    expect(s.currentTrip).toEqual(mockTrip);
    expect(renderWarnings()).toEqual([]);
  });

  it('carries a landing-page rawInput seed across the reset', async () => {
    useTripStore.setState({
      currentTrip: mockTrip,
      answers: { rawInput: '10 days in Japan in April', travelers: 9 },
      chatHistory: [{ role: 'assistant', content: 'stale' }],
    });

    render(<PlanPage />);

    await waitFor(() => expect(useTripStore.getState().currentTrip).toBeNull());
    const s = useTripStore.getState();
    // The stale answers are gone; the seed survived long enough for the
    // planner to hand it to the conversation (which then clears it).
    expect(s.answers.travelers).toBeUndefined();
    expect(s.answers.planningMode).toBe('destination');
    expect(s.answers.rawInput).toBeUndefined();
    expect(renderWarnings()).toEqual([]);
  });
});
