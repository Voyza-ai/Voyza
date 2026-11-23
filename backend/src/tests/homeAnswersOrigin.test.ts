/**
 * "Where are you flying from?" answered with dates must not become the home
 * city. An audit (2026-11-18) typed "January 12 to 19, 2027" there and the
 * planner took it as the origin. guardHomeAnswers now refuses an origin that
 * is clearly not a place (dates, a bare number) and re-asks, keeping any
 * dates the model read from the same message.
 */
import { originNotAPlace } from '../services/homeAnswers';

describe('originNotAPlace', () => {
  it.each([
    ['January 12 to 19, 2027', 'dates'],
    ['Jan 12 - Jan 19', 'dates'],
    ['12/01/2027', 'dates'],
    ['2027-01-12', 'dates'],
    ['next week', 'dates'],
    ['2', 'number'],
    ['$3,000', 'number'],
  ])('%p → %p', (text, reason) => {
    expect(originNotAPlace(text)).toBe(reason);
  });

  it.each(['New York', 'Paris', 'São Paulo', 'Marseille', 'St. Petersburg', 'Mayo', 'Saint-Martin', 'Washington DC', 'Area 51'])(
    'a place is not refused: %p',
    (text) => {
      expect(originNotAPlace(text)).toBeNull();
    },
  );
});

