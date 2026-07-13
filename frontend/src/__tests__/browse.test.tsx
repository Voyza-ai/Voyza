import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import BrowsePage from '@/app/browse/page';
import { PRESET_ITINERARIES, presetNights, presetCost } from '@/data/presetItineraries';

const NIGHTS_MAX = Math.max(...PRESET_ITINERARIES.map(presetNights));
const COST_MAX = Math.ceil(Math.max(...PRESET_ITINERARIES.map(presetCost)) / 100) * 100;

const search = (text: string) =>
  fireEvent.change(screen.getByPlaceholderText(/Describe your trip/i), {
    target: { value: text },
  });

const setSlider = (name: RegExp, value: number) =>
  fireEvent.change(screen.getByRole('slider', { name }), {
    target: { value: String(value) },
  });

const setVibe = (value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: /vibe/i }), {
    target: { value },
  });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BrowsePage filtering scenarios', () => {
  test('default shows the entire marketplace', () => {
    render(<BrowsePage />);
    for (const p of PRESET_ITINERARIES) {
      expect(screen.getByText(p.title)).toBeInTheDocument();
    }
  });

  test('search narrows to relevant trips', () => {
    render(<BrowsePage />);
    search('trip in Italy with a lot of architecture');
    expect(screen.getByText('Italian Renaissance Trail')).toBeInTheDocument();
    expect(screen.queryByText('Southeast Asia Adventure')).not.toBeInTheDocument();
  });

  test('nonsense search shows the AI-planner handoff and routes to /plan', () => {
    render(<BrowsePage />);
    search('zzqx flurbish');
    expect(screen.getByText(/No ready-made trip matches/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Describe it to the AI planner/i));
    expect(mockPush).toHaveBeenCalledWith('/plan');
  });

  test('clearing the search restores the full marketplace', () => {
    render(<BrowsePage />);
    search('iceland');
    expect(screen.queryByText('Japan Golden Route')).not.toBeInTheDocument();
    search('');
    expect(screen.getByText('Japan Golden Route')).toBeInTheDocument();
  });

  test('length slider filters to short trips and slides back to Any', () => {
    render(<BrowsePage />);
    setSlider(/trip length/i, 5);
    expect(screen.getByText('Paris Long Weekend')).toBeInTheDocument();
    expect(screen.getByText('Reykjavik Adventure Weekend')).toBeInTheDocument();
    expect(screen.getByText('Lisbon & Sintra Escape')).toBeInTheDocument();
    expect(screen.queryByText('Japan Golden Route')).not.toBeInTheDocument();
    setSlider(/trip length/i, NIGHTS_MAX);
    expect(screen.getByText('Japan Golden Route')).toBeInTheDocument();
  });

  test('budget slider filters out expensive trips', () => {
    render(<BrowsePage />);
    setSlider(/budget/i, 1000);
    expect(screen.getByText('Paris Long Weekend')).toBeInTheDocument();
    expect(screen.queryByText('Grand Asia Expedition')).not.toBeInTheDocument();
    expect(screen.queryByText('Mediterranean Odyssey')).not.toBeInTheDocument();
  });

  test('vibe dropdown filters by vibe', () => {
    render(<BrowsePage />);
    setVibe('beach');
    expect(screen.getByText('Greek Island Escape')).toBeInTheDocument();
    expect(screen.queryByText('Imperial Europe by Rail')).not.toBeInTheDocument();
    setVibe('');
    expect(screen.getByText('Imperial Europe by Rail')).toBeInTheDocument();
  });

  test('search and sidebar filters compose', () => {
    render(<BrowsePage />);
    search('food');
    setSlider(/trip length/i, 5);
    expect(screen.getByText('Lisbon & Sintra Escape')).toBeInTheDocument();
    expect(screen.queryByText('Southeast Asia Adventure')).not.toBeInTheDocument();
  });

  test('filters that exclude everything show the clear-filters state, and clearing restores', () => {
    render(<BrowsePage />);
    search('iceland'); // only Reykjavik matches (~$760)
    setSlider(/budget/i, 700); // below its cost
    expect(screen.getByText(/No trips match these filters/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Clear filters$/i }));
    expect(screen.getByText('Reykjavik Adventure Weekend')).toBeInTheDocument();
  });

  test('sidebar count reflects the filtered set', () => {
    render(<BrowsePage />);
    setSlider(/trip length/i, 5);
    expect(
      screen.getByText(new RegExp(`3 of ${PRESET_ITINERARIES.length} itineraries shown`)),
    ).toBeInTheDocument();
  });

  test('clear-all link in the sidebar resets every filter', () => {
    render(<BrowsePage />);
    setSlider(/trip length/i, 5);
    setVibe('beach');
    setSlider(/budget/i, COST_MAX - 100);
    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    for (const p of PRESET_ITINERARIES) {
      expect(screen.getByText(p.title)).toBeInTheDocument();
    }
  });
});
