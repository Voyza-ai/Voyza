import './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConversationalPlanner from '@/components/planning/ConversationalPlanner';
import { converse } from '@/lib/api';
import { useTripStore } from '@/store/tripStore';

/**
 * The origin airports a planned trip is PRICED from, driven through the real
 * planner rather than injected.
 *
 * `answers.originAirports` is the field `PlanningChat` sends to
 * `/api/optimize`, and `optimizer.ts` prices home legs from it verbatim. An
 * earlier verification of the Moscow fix wrote the server's answer into this
 * store directly and passed — while the planner, which computes the list
 * itself through `locationResolver`, kept writing the region's SVO, VKO, ZIA.
 * So this test only controls what the AI says; the airports come from the
 * component's own lookup.
 */

const mockedConverse = converse as jest.MockedFunction<typeof converse>;

const baseProps = {
  onFindTrip: jest.fn(),
  findTripLoading: false,
  findTripStatus: '',
  findTripError: null,
  onSwitchToGuided: jest.fn(),
};

const sendText = async (text: string) => {
  const input = screen.getByPlaceholderText(/Say anything/);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
};

const answers = () => useTripStore.getState().answers;

beforeEach(() => {
  jest.clearAllMocks();
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
});

describe('the planner writes the airports a trip is priced from', () => {
  it('Moscow: Sheremetyevo, Domodedovo, Vnukovo — not the region’s Zhukovsky', async () => {
    mockedConverse.mockResolvedValue({
      reply: 'Moscow it is.',
      updates: { origin: 'Moscow' },
      action: 'ask',
    } as any);

    render(<ConversationalPlanner {...baseProps} />);
    await sendText('flying from moscow');

    await waitFor(() => expect(answers().origin).toBe('Moscow'));
    await waitFor(() => expect(answers().originAirports).toEqual(['SVO', 'DME', 'VKO']));
  });

  it('Moscow, Idaho: Pullman leads, so the label rule did not reach it', async () => {
    mockedConverse.mockResolvedValue({
      reply: 'Got it.',
      updates: { origin: 'Moscow, Idaho' },
      action: 'ask',
    } as any);

    render(<ConversationalPlanner {...baseProps} />);
    await sendText('from moscow idaho');

    await waitFor(() => expect(answers().originAirports?.[0]).toBe('PUW'));
  });
});
