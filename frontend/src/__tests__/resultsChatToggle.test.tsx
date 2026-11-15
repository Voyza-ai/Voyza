import './mocks';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useTripStore } from '@/store/tripStore';
import { buildTrip } from './fixtures';
import ResultsPage from '@/app/results/page';

beforeEach(() => {
  window.localStorage.clear();
  useTripStore.setState({ currentTrip: buildTrip(), chatHistory: [] });
});

it('BlueMurr AI can be hidden and brought back from a tab on the right', () => {
  render(<ResultsPage />);
  expect(screen.getByText('Tweak your trip in plain English')).toBeVisible();
  fireEvent.click(screen.getByLabelText('Hide BlueMurr AI'));
  // Hidden but kept (the conversation survives), with a tab to bring it back.
  expect(screen.getByText('Tweak your trip in plain English').closest('aside')).toHaveClass('hidden');
  expect(window.localStorage.getItem('bluemurr.chatHidden')).toBe('1');
  fireEvent.click(screen.getByLabelText('Show BlueMurr AI'));
  expect(screen.getByText('Tweak your trip in plain English').closest('aside')).not.toHaveClass('hidden');
  expect(screen.queryByLabelText('Show BlueMurr AI')).not.toBeInTheDocument();
  expect(window.localStorage.getItem('bluemurr.chatHidden')).toBe('0');
});

it('stays hidden on the next visit', () => {
  window.localStorage.setItem('bluemurr.chatHidden', '1');
  render(<ResultsPage />);
  expect(screen.getByText('Tweak your trip in plain English').closest('aside')).toHaveClass('hidden');
  expect(screen.getByLabelText('Show BlueMurr AI')).toBeInTheDocument();
});
