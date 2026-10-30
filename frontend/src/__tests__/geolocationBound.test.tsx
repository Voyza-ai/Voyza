import './mocks';
import { mockPush } from './mocks';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import BrowsePage from '@/app/browse/page';
import { saveTrip } from '@/lib/api';
import { DETECT_TIMEOUT_MS, detectNearestAirportCity } from '@/lib/nearestAirport';

/**
 * Audit D-13: "use my location" waited on the browser's permission prompt
 * with no bound — getCurrentPosition's own timeout starts only after
 * permission — so an ignored prompt left Save / "Plan a similar trip"
 * spinning (90 s+ measured). The whole wait is bounded now, and the
 * fallback is the same no-location path a denial takes.
 */
const setGeolocation = (impl: any) =>
  Object.defineProperty(global.navigator, 'geolocation', { value: impl, configurable: true });

// A prompt nobody answers: never calls back unless the test says so.
let answer: ((coords: { latitude: number; longitude: number }) => void) | null = null;
const ignoredPrompt = () =>
  setGeolocation({
    getCurrentPosition: (ok: any) => {
      answer = (coords) => ok({ coords });
    },
  });
const BOSTON = { latitude: 42.36, longitude: -71.06 };

beforeEach(() => {
  jest.clearAllMocks();
  answer = null;
  sessionStorage.clear();
});
afterEach(() => {
  jest.useRealTimers();
  // @ts-expect-error cleanup
  delete global.navigator.geolocation;
});

describe('detectNearestAirportCity bound', () => {
  it('an unanswered prompt resolves as a timeout after DETECT_TIMEOUT_MS, not never', async () => {
    jest.useFakeTimers();
    ignoredPrompt();
    let result: unknown = 'pending';
    detectNearestAirportCity().then((r) => (result = r));
    await act(async () => {
      jest.advanceTimersByTime(DETECT_TIMEOUT_MS - 1);
    });
    expect(result).toBe('pending');
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('a position that arrives after the bound cannot replace the timeout', async () => {
    jest.useFakeTimers();
    ignoredPrompt();
    const p = detectNearestAirportCity();
    jest.advanceTimersByTime(DETECT_TIMEOUT_MS);
    answer!(BOSTON);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
  });

  it('a prompt answered in time still wins', async () => {
    ignoredPrompt();
    const p = detectNearestAirportCity();
    answer!(BOSTON);
    expect(await p).toMatchObject({ ok: true, city: { city: 'Boston' } });
  });
});

describe('/browse with an ignored location prompt', () => {
  it('Save completes from the JFK default within the bound', async () => {
    jest.useFakeTimers();
    ignoredPrompt();
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(screen.getByText(/Finding your nearest airport/)).toBeInTheDocument();
    expect(saveTrip).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(DETECT_TIMEOUT_MS);
    });
    jest.useRealTimers();
    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    expect((saveTrip as jest.Mock).mock.calls[0][0].origin).toEqual({ city: 'New York', airports: ['JFK'] });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/results?tripId=trip-123'));

    // The late answer changes nothing: no second save, origin still JFK.
    await act(async () => answer!(BOSTON));
    expect(saveTrip).toHaveBeenCalledTimes(1);
  });

  it('"Plan a similar trip" completes from the JFK default within the bound', async () => {
    jest.useFakeTimers();
    ignoredPrompt();
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    fireEvent.click(screen.getByRole('button', { name: /Plan a similar trip/i }));
    expect(mockPush).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(DETECT_TIMEOUT_MS);
    });
    jest.useRealTimers();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/plan?resume=1&autorun=1'));
    const staged = JSON.parse(sessionStorage.getItem('bluemurr-autorun')!);
    expect(staged.origin).toBe('New York');
    expect(staged.originAirports).toEqual(['JFK']);
  });

  it('turning the location switch off while the prompt is up wins over a position that arrives after', async () => {
    ignoredPrompt();
    render(<BrowsePage />);
    fireEvent.click(screen.getByText('Japan Golden Route'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    fireEvent.click(screen.getByRole('switch', { name: /use my location/i }));
    await act(async () => answer!(BOSTON));
    await waitFor(() => expect(saveTrip).toHaveBeenCalled());
    expect((saveTrip as jest.Mock).mock.calls[0][0].origin).toEqual({ city: 'New York', airports: ['JFK'] });
  });
});
