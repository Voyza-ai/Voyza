import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { converse } from '@/lib/api';

// Typing a sentence BEFORE picking a planning mode ("Or just tell me
// everything at once...") must open the AI conversation seeded with that
// sentence. `setIntent('chat')` swaps PlanningChat's own chat UI out for
// ConversationalPlanner, so anything pushed into PlanningChat's `messages`
// at that moment is rendered by nothing and the sentence is dropped before
// it ever reaches /api/plan/converse. The only handoff that survives the
// swap is `chatSeedRef` → `seedMessage`, which is what the landing-hero
// path already uses.
//
// The mock below records the props ConversationalPlanner is mounted with
// AND renders the real component underneath, so one test proves both legs:
// the sentence arrives as `seedMessage`, and the planner sends it on.
const mockPlannerMounts: Array<Record<string, any>> = [];
jest.mock('@/components/planning/ConversationalPlanner', () => {
  const ReactInner = require('react');
  const Actual = jest.requireActual('@/components/planning/ConversationalPlanner').default;
  return {
    __esModule: true,
    default: (props: any) => {
      mockPlannerMounts.push(props);
      return ReactInner.createElement(Actual, props);
    },
  };
});

const mockedConverse = converse as jest.MockedFunction<typeof converse>;

const SENTENCE = '2 of us want 10 days in Japan in April, budget around $6000';

/** Render in the pre-intent state and type the sentence into the bottom bar. */
const typePreIntentSentence = async (sentence = SENTENCE, strict = false) => {
  window.history.pushState({}, '', '/plan');
  render(strict ? <React.StrictMode><PlanningChat /></React.StrictMode> : <PlanningChat />);

  // Pre-intent: the planner greeting is showing, no intent chosen yet, and
  // ConversationalPlanner has NOT mounted.
  expect(await screen.findByText(/What kind of trip are you planning/)).toBeInTheDocument();
  expect(mockPlannerMounts).toHaveLength(0);

  const bar = screen.getByPlaceholderText(/just tell me everything at once/i);
  fireEvent.change(bar, { target: { value: sentence } });
  return bar;
};

describe('PlanningChat pre-intent sentence → ConversationalPlanner seed', () => {
  beforeAll(() => {
    // jsdom has no Element.scrollTo — both components autoscroll on update.
    Element.prototype.scrollTo = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlannerMounts.length = 0;
    sessionStorage.clear();
    useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
    mockedConverse.mockResolvedValue({ reply: 'Sounds great!', updates: {}, action: 'ask' });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('hands the typed sentence to ConversationalPlanner as seedMessage (Enter)', async () => {
    const bar = await typePreIntentSentence();
    fireEvent.keyDown(bar, { key: 'Enter' });

    await waitFor(() => expect(mockPlannerMounts.length).toBeGreaterThan(0));
    expect(mockPlannerMounts[0].seedMessage).toBe(SENTENCE);
  });

  it('hands the typed sentence over when submitted with the send button', async () => {
    const bar = await typePreIntentSentence();
    // The send button is the only button next to the bar in the pre-intent bottom pill.
    fireEvent.click(bar.parentElement!.querySelector('button')!);

    await waitFor(() => expect(mockPlannerMounts.length).toBeGreaterThan(0));
    expect(mockPlannerMounts[0].seedMessage).toBe(SENTENCE);
  });

  it('sends the sentence through to /api/plan/converse and renders it in the conversation', async () => {
    const bar = await typePreIntentSentence();
    fireEvent.keyDown(bar, { key: 'Enter' });

    await waitFor(() =>
      expect(mockedConverse).toHaveBeenCalledWith(
        expect.objectContaining({ message: SENTENCE }),
      ),
    );
    // The sentence is a user bubble in the conversation that is actually on
    // screen, and the AI's reply came back under it.
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(await screen.findByText('Sounds great!')).toBeInTheDocument();
    // PlanningChat's own chat UI is gone — this is the swap that dropped the
    // sentence before the fix.
    expect(screen.queryByText(/What kind of trip are you planning/)).not.toBeInTheDocument();
  });

  it('sends the sentence exactly once (no double-seed on re-render)', async () => {
    const bar = await typePreIntentSentence();
    fireEvent.keyDown(bar, { key: 'Enter' });

    await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(1));
    // Let every pending timer/effect settle, then re-check.
    await new Promise((r) => setTimeout(r, 120));
    expect(mockedConverse).toHaveBeenCalledTimes(1);
    expect(mockedConverse.mock.calls[0][0].message).toBe(SENTENCE);
    // Seeded conversations start with the user's sentence, not the greeting.
    expect(mockedConverse.mock.calls[0][0].history).toEqual([]);
  });

  // The App Router turns Strict Mode on in dev, which mounts → unmounts →
  // remounts every component. The seed must not be sent twice.
  it('sends the sentence exactly once under StrictMode', async () => {
    const bar = await typePreIntentSentence(SENTENCE, true);
    fireEvent.keyDown(bar, { key: 'Enter' });

    await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(mockedConverse).toHaveBeenCalledTimes(1);
    expect(mockedConverse.mock.calls[0][0].message).toBe(SENTENCE);
  });

  it('trims surrounding whitespace off the seed', async () => {
    const bar = await typePreIntentSentence(`   ${SENTENCE}   `);
    fireEvent.keyDown(bar, { key: 'Enter' });

    await waitFor(() => expect(mockPlannerMounts.length).toBeGreaterThan(0));
    expect(mockPlannerMounts[0].seedMessage).toBe(SENTENCE);
  });

  it('stages planningMode=destination with the handoff', async () => {
    const bar = await typePreIntentSentence();
    fireEvent.keyDown(bar, { key: 'Enter' });

    await waitFor(() => expect(mockPlannerMounts.length).toBeGreaterThan(0));
    expect(useTripStore.getState().answers.planningMode).toBe('destination');
  });

  it('clears the staged text, so the guided fallback does not reopen with it in the box', async () => {
    // Every converse call fails → after 3 the planner offers the guided
    // escape hatch, which re-mounts PlanningChat's own input bar. If
    // setTextInput('') were dropped, the old sentence would be sitting in it.
    mockedConverse.mockRejectedValue(new Error('fetch failed'));

    const bar = await typePreIntentSentence();
    fireEvent.keyDown(bar, { key: 'Enter' });

    // Failure 1 is the seed itself; drive two more from the planner's input.
    await waitFor(() => expect(mockedConverse).toHaveBeenCalledTimes(1));
    for (const text of ['still there?', 'hello?']) {
      const plannerInput = await screen.findByPlaceholderText(/Say anything/);
      fireEvent.change(plannerInput, { target: { value: text } });
      fireEvent.submit(plannerInput.closest('form')!);
      await waitFor(() => expect(mockedConverse).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: text }),
      ));
    }

    const fallback = await screen.findByText(/continue with guided questions instead/);
    fireEvent.click(fallback);

    // Back on the guided flow: the bottom bar is mounted again and empty.
    const guidedBar = await screen.findByPlaceholderText(/Type a destination/);
    expect(guidedBar).toHaveValue('');
  });
});
