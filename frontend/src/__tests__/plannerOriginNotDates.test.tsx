import './mocks';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import PlanningChat from '@/components/planning/PlanningChat';
import { useTripStore } from '@/store/tripStore';
import { interpretPlan } from '@/lib/api';
import { originNotAPlace } from '@/lib/originAnswer';

/**
 * "Where are you starting from?" answered with dates is not a home city.
 * An audit (2026-11-18) typed "January 12 to 19, 2027" there and the planner
 * stored it as the origin. Now it re-asks — keeping the dates when the trip
 * has none yet — and a real city then moves on as before.
 */
const mockedInterpret = interpretPlan as jest.MockedFunction<typeof interpretPlan>;

beforeAll(() => {
  Element.prototype.scrollTo = jest.fn();
  Element.prototype.scrollIntoView = jest.fn();
});
beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  window.history.pushState({}, '', '/plan');
  useTripStore.setState({ answers: {}, chatHistory: [], currentTrip: null });
});
const type = (bar: HTMLElement, value: string) => {
  fireEvent.change(bar, { target: { value } });
  fireEvent.keyDown(bar, { key: 'Enter' });
};

it('dates typed as the home city: re-asked, dates kept, then a real city moves on', async () => {
  mockedInterpret.mockResolvedValue({ destinations: ['Paris'] } as any);
  render(<PlanningChat />);
  fireEvent.click(await screen.findByText('I know where I want to go'));
  type(await screen.findByPlaceholderText('Type a destination...'), 'Paris');
  await screen.findByText(/Where are you starting from\?/, undefined, { timeout: 3000 });

  type(screen.getByPlaceholderText(/starting from|New York/), 'January 12 to 19, 2027');
  expect(await screen.findByText("That looks like dates — I've noted them. Which city are you flying from?")).toBeInTheDocument();
  expect(useTripStore.getState().answers.origin).toBeUndefined();
  expect(useTripStore.getState().answers.dateRange).toEqual({ start: '2027-01-12', end: '2027-01-19' });
  expect(screen.queryByText(/One-way or round-trip\?/)).toBeNull();

  type(screen.getByPlaceholderText(/starting from|New York/), 'New York');
  await screen.findByText(/One-way or round-trip\?/, undefined, { timeout: 3000 });
  expect(useTripStore.getState().answers.origin).toBe('New York');
});

describe('originNotAPlace', () => {
  it.each(['January 12 to 19, 2027', 'Jan 12 - 19', '12/01/2027', '2027-01-12', 'next week'])('dates: %p', (t) => {
    expect(originNotAPlace(t)).toBe('dates');
  });
  it.each(['New York', 'São Paulo', 'Marseille', 'Mayo', 'St. Petersburg', 'Area 51'])('a place: %p', (t) => {
    expect(originNotAPlace(t)).toBeNull();
  });
});
