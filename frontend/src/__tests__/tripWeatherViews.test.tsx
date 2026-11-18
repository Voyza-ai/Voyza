import './mocks';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import CalendarView from '@/components/results/CalendarView';
import ScheduleView from '@/components/results/ScheduleView';
import { fetchTripWeather, type DayWeather, type TripWeather } from '@/lib/api';
import { __resetTripWeather, weatherEmoji, weatherTemps, weatherTitle } from '@/lib/tripWeather';
import { useTripStore } from '@/store/tripStore';
import { buildTrip } from './fixtures';

/**
 * Weather on the Calendar and Schedule (owner, 2026-11-18: "have the weather
 * showing up on the calendar and schedule page as well … with the small
 * emojis"). The numbers are the backend's (services/weather.ts); a typical
 * day is marked "avg" and never reads as a forecast.
 */

const mocked = fetchTripWeather as jest.MockedFunction<typeof fetchTripWeather>;
const f = (date: string, summary: string, highC: number, lowC: number, precipMm = 0): DayWeather => ({ date, kind: 'forecast', summary, highC, lowC, precipMm });
const typ = (date: string, highC: number, lowC: number, wetDayShare: number): DayWeather => ({ date, kind: 'typical', highC, lowC, wetDayShare, source: 'NOAA station' });

// buildTrip: Rome Jun 15–18, Florence Jun 18–20.
const WEATHER: TripWeather = {
  fahrenheit: true,
  cities: [
    { city: 'Rome', days: [f('2026-06-15', 'sunny', 30, 19), f('2026-06-16', 'rain', 24, 18, 6.2), f('2026-06-17', 'thunderstorms', 26, 20, 12)], missing: [], typicalYears: null },
    { city: 'Florence', days: [typ('2026-06-18', 29.6, 16.4, 0.2), typ('2026-06-19', 30.1, 17, 0.55), typ('2026-06-20', 31, 18, 0.1)], missing: [], typicalYears: '2016–2025' },
  ],
};

beforeEach(() => {
  __resetTripWeather();
  mocked.mockReset();
  useTripStore.setState({ currentTrip: null });
});

describe('a day as an emoji and high/low', () => {
  it('a forecast by its own words', () => {
    expect(weatherEmoji(f('d', 'sunny', 20, 10))).toBe('☀️');
    expect(weatherEmoji(f('d', 'mostly sunny', 20, 10))).toBe('🌤️');
    expect(weatherEmoji(f('d', 'partly cloudy', 20, 10))).toBe('⛅');
    expect(weatherEmoji(f('d', 'cloudy', 20, 10))).toBe('☁️');
    expect(weatherEmoji(f('d', 'showers', 20, 10))).toBe('🌦️');
    expect(weatherEmoji(f('d', 'rain', 20, 10))).toBe('🌧️');
    expect(weatherEmoji(f('d', 'heavy rain', 20, 10))).toBe('🌧️');
    expect(weatherEmoji(f('d', 'snow', 0, -3))).toBe('🌨️');
    expect(weatherEmoji(f('d', 'thunderstorms', 25, 18))).toBe('⛈️');
    expect(weatherEmoji(f('d', 'fog', 8, 4))).toBe('🌫️');
  });

  it('a typical day by how often the date was wet in past years', () => {
    expect(weatherEmoji(typ('d', 20, 10, 0.1))).toBe('🌤️');
    expect(weatherEmoji(typ('d', 20, 10, 0.39))).toBe('🌦️');
    expect(weatherEmoji(typ('d', 20, 10, 0.6))).toBe('🌧️');
    expect(weatherEmoji(typ('d', 0, -5, 0.4))).toBe('🌨️');
  });

  it('°F for a US home, °C otherwise; the hover says forecast or typical, and from where', () => {
    expect(weatherTemps(f('d', 'rain', 9.2, 4.3), true)).toBe('49°/40°');
    expect(weatherTemps(f('d', 'rain', 9.2, 4.3), false)).toBe('9°/4°');
    expect(weatherTitle(f('d', 'rain', 9.2, 4.3, 4.5), true)).toBe('Forecast: rain, high 49°F, low 40°F, 4.5 mm rain (MET Norway)');
    expect(weatherTitle(typ('d', 8.7, 2.6, 0.39), false, '2016–2025')).toBe(
      'Typical for this date (2016–2025 average), not a forecast: high 9°C, low 3°C, rain on 39% of past years',
    );
  });
});

describe('Calendar', () => {
  it('each city day shows its weather on its bottom line; a typical day is marked avg; the grey fly-home day shows none', async () => {
    mocked.mockResolvedValue(WEATHER);
    render(<CalendarView trip={buildTrip()} />);
    await waitFor(() => expect(screen.getAllByTestId('weather-chip').length).toBe(5));
    const chips = screen.getAllByTestId('weather-chip');
    // Rome Jun 15–17, Florence Jun 18–19; Jun 20 (fly home) has Florence's weather but no city cell.
    expect(chips.map((c) => c.textContent)).toEqual(['☀️86°/66°', '🌧️75°/64°', '⛈️79°/68°', '🌤️85°/62°avg', '🌧️86°/63°avg']);
    expect(chips.filter((c) => c.getAttribute('data-kind') === 'typical')).toHaveLength(2);
    expect(screen.getByTestId('weather-typical-note').textContent).toBe('Weather marked avg: typical for the date (2016–2025 average), not a forecast');
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][0].cities.map((c) => c.name)).toEqual(['Rome', 'Florence']);
  });

  it('a day no weather service covered shows nothing — never a guess', async () => {
    mocked.mockResolvedValue({ ...WEATHER, cities: [{ ...WEATHER.cities[0], days: WEATHER.cities[0].days.filter((d) => d.date !== '2026-06-16'), missing: ['2026-06-16'] }, WEATHER.cities[1]] });
    render(<CalendarView trip={buildTrip()} />);
    await waitFor(() => expect(screen.getAllByTestId('weather-chip').length).toBe(4));
    expect(screen.getAllByTestId('weather-chip').map((c) => c.textContent)).not.toContain('🌧️75°/64°');
  });

  it('shows the calendar as before when the weather does not come', async () => {
    mocked.mockRejectedValue(new Error('down'));
    render(<CalendarView trip={buildTrip()} />);
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(screen.queryAllByTestId('weather-chip')).toHaveLength(0);
    expect(screen.getAllByText('Rome').length).toBeGreaterThan(0);
  });
});

describe('Schedule', () => {
  it('each day card has its weather beside the date', async () => {
    mocked.mockResolvedValue(WEATHER);
    const trip = buildTrip();
    useTripStore.setState({ currentTrip: trip });
    render(<ScheduleView trip={trip} />);
    await waitFor(() => expect(screen.getAllByTestId('weather-chip').length).toBeGreaterThanOrEqual(5));
    const texts = screen.getAllByTestId('weather-chip').map((c) => c.textContent);
    expect(texts).toContain('🌧️75°/64°');
    expect(texts).toContain('🌤️85°/62°avg');
  });
});
