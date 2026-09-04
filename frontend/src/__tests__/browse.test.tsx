import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BrowsePage from '@/app/browse/page';
import { PRESET_ITINERARIES, presetNights, presetCost } from '@/data/presetItineraries';
import { saveTrip } from '@/lib/api';

const setGeolocation = (impl: any) =>
  Object.defineProperty(global.navigator, 'geolocation', {
    value: impl,
    configurable: true,
  });

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

const apply = () =>
  fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  // Remove any geolocation mock so other tests see jsdom's default (undefined).
  // @ts-expect-error cleanup
  delete global.navigator.geolocation;
  localStorage.removeItem('bluemurr-use-location');
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

  test('filters do not take effect until Apply is clicked', () => {
    render(<BrowsePage />);
    setSlider(/trip length/i, 5);
    // Draft only — everything still visible.
    expect(screen.getByText('Japan Golden Route')).toBeInTheDocument();
    expect(screen.getByText(/Unapplied changes/i)).toBeInTheDocument();
    apply();
    expect(screen.queryByText('Japan Golden Route')).not.toBeInTheDocument();
  });

  test('length slider filters to short trips and slides back to Any', () => {
    render(<BrowsePage />);
    setSlider(/trip length/i, 5);
    apply();
    expect(screen.getByText('Paris Long Weekend')).toBeInTheDocument();
    expect(screen.getByText('Reykjavik Adventure Weekend')).toBeInTheDocument();
    expect(screen.getByText('Lisbon & Sintra Escape')).toBeInTheDocument();
    expect(screen.queryByText('Japan Golden Route')).not.toBeInTheDocument();
    setSlider(/trip length/i, NIGHTS_MAX);
    apply();
    expect(screen.getByText('Japan Golden Route')).toBeInTheDocument();
  });

  test('budget slider filters out expensive trips', () => {
    render(<BrowsePage />);
    setSlider(/budget/i, 1000);
    apply();
    expect(screen.getByText('Paris Long Weekend')).toBeInTheDocument();
    expect(screen.queryByText('Grand Asia Expedition')).not.toBeInTheDocument();
    expect(screen.queryByText('Mediterranean Odyssey')).not.toBeInTheDocument();
  });

  test('vibe dropdown filters by vibe', () => {
    render(<BrowsePage />);
    setVibe('beach');
    apply();
    expect(screen.getByText('Greek Island Escape')).toBeInTheDocument();
    expect(screen.queryByText('Imperial Europe by Rail')).not.toBeInTheDocument();
    setVibe('');
    apply();
    expect(screen.getByText('Imperial Europe by Rail')).toBeInTheDocument();
  });

  test('search and sidebar filters compose', () => {
    render(<BrowsePage />);
    search('food');
    setSlider(/trip length/i, 5);
    apply();
    expect(screen.getByText('Lisbon & Sintra Escape')).toBeInTheDocument();
    expect(screen.queryByText('Southeast Asia Adventure')).not.toBeInTheDocument();
  });

  test('filters that exclude everything show the clear-filters state, and clearing restores', () => {
    render(<BrowsePage />);
    search('iceland'); // only Reykjavik matches (~$760)
    setSlider(/budget/i, 700); // below its cost
    apply();
    expect(screen.getByText(/No trips match these filters/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Clear filters$/i }));
    expect(screen.getByText('Reykjavik Adventure Weekend')).toBeInTheDocument();
  });

  test('sidebar count reflects the filtered set', () => {
    render(<BrowsePage />);
    setSlider(/trip length/i, 5);
    apply();
    expect(
      screen.getByText(new RegExp(`3 of ${PRESET_ITINERARIES.length} itineraries shown`)),
    ).toBeInTheDocument();
  });

  test('clear-all link in the sidebar resets every filter', () => {
    render(<BrowsePage />);
    setSlider(/trip length/i, 5);
    setVibe('beach');
    setSlider(/budget/i, COST_MAX - 100);
    apply();
    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    for (const p of PRESET_ITINERARIES) {
      expect(screen.getByText(p.title)).toBeInTheDocument();
    }
  });

  test('saving with location granted uses the nearest airport city as origin', async () => {
    setGeolocation({
      // Boston city center — nearest airport city should be Boston, not NYC.
      getCurrentPosition: (ok: any) =>
        ok({ coords: { latitude: 42.36, longitude: -71.06 } }),
    });
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    const payload = (saveTrip as jest.Mock).mock.calls[0][0];
    expect(payload.origin.city).toBe('Boston');
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/results?tripId=trip-123'),
    );
  });

  test('saving with location denied falls back to the JFK default', async () => {
    setGeolocation({
      getCurrentPosition: (_ok: any, err: any) => err({ code: 1 }),
    });
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    const payload = (saveTrip as jest.Mock).mock.calls[0][0];
    expect(payload.origin).toEqual({ city: 'New York', airports: ['JFK'] });
  });

  test('saving without geolocation support falls back to the JFK default', async () => {
    // jsdom default: navigator.geolocation is undefined.
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    const payload = (saveTrip as jest.Mock).mock.calls[0][0];
    expect(payload.origin).toEqual({ city: 'New York', airports: ['JFK'] });
  });

  test('location toggle off skips the browser prompt and saves with JFK', async () => {
    const getCurrentPosition = jest.fn((ok: any) =>
      ok({ coords: { latitude: 42.36, longitude: -71.06 } }),
    );
    setGeolocation({ getCurrentPosition });
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    // Toggle is on by default; turn it off.
    const toggle = screen.getByRole('switch', { name: /use my location/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    // The browser was never asked, and the trip departs from the default.
    expect(getCurrentPosition).not.toHaveBeenCalled();
    const payload = (saveTrip as jest.Mock).mock.calls[0][0];
    expect(payload.origin).toEqual({ city: 'New York', airports: ['JFK'] });
  });

  test('location toggle persists via localStorage', () => {
    localStorage.setItem('bluemurr-use-location', 'off');
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    // Remembered off across page loads.
    const toggle = screen.getByRole('switch', { name: /use my location/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // Turning it back on clears the stored opt-out.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('bluemurr-use-location')).toBeNull();
    // And off again writes it back.
    fireEvent.click(toggle);
    expect(localStorage.getItem('bluemurr-use-location')).toBe('off');
  });

  test('location toggle on keeps the detection flow working', async () => {
    setGeolocation({
      getCurrentPosition: (ok: any) =>
        ok({ coords: { latitude: 42.36, longitude: -71.06 } }),
    });
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    const payload = (saveTrip as jest.Mock).mock.calls[0][0];
    expect(payload.origin.city).toBe('Boston');
  });

  test('save modal asks for travelers and updates the price live', () => {
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    // Modal opens with the preset default of 2 travelers.
    expect(screen.getByText('Travelers')).toBeInTheDocument();
    expect(screen.getByText('2 travelers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /more travelers/i }));
    fireEvent.click(screen.getByRole('button', { name: /more travelers/i }));
    expect(screen.getByText('4 travelers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /fewer travelers/i }));
    expect(screen.getByText('3 travelers')).toBeInTheDocument();
  });
});
