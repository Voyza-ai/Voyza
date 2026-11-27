/**
 * lib/optimizeRequest.ts builds the trip half of the optimize request — the
 * one body both the plan and the chat's home-flight pre-search send
 * (prototype, exp/optimizer-speed). Same rules the planner used inline.
 */
import { optimizeTripRequest, totalNightsFor } from '@/lib/optimizeRequest';

describe('optimizeTripRequest', () => {
  const answers = {
    origin: 'New York',
    originAirports: ['JFK', 'EWR', 'LGA'],
    returnToHome: true,
    nights: 7,
    dateRange: { start: '2027-01-12', end: '2027-01-19' },
  };

  it('the plan and the pre-search get the same trip', () => {
    const req = optimizeTripRequest({
      destinations: ['Paris', 'Amsterdam', 'Berlin'],
      travelers: 2,
      startRaw: '2027-01-12',
      answers,
    });
    expect(req).toEqual({
      cities: [{ name: 'Paris' }, { name: 'Amsterdam' }, { name: 'Berlin' }],
      startDate: '2027-01-12',
      travelers: 2,
      origin: 'New York',
      originAirports: ['JFK', 'EWR', 'LGA'],
      returnToHome: true,
      totalNights: 7,
      cityNights: undefined,
    });
  });

  it('staged countries and per-city nights travel with the cities', () => {
    const req = optimizeTripRequest({
      destinations: ['Lisbon', 'Sintra'],
      travelers: 2,
      startRaw: '2027-01-12',
      answers: {
        ...answers,
        nights: 4,
        cityCountries: { Sintra: 'PT' },
        cityNights: { Lisbon: 3, Sintra: 1 },
      },
    });
    expect(req.cities).toEqual([{ name: 'Lisbon' }, { name: 'Sintra', country: 'PT' }]);
    expect(req.cityNights).toEqual({ Lisbon: 3, Sintra: 1 });
  });

  it('round trip unless the traveller said one-way', () => {
    const base = { destinations: ['Rome'], travelers: 1, startRaw: '2027-03-01' };
    expect(optimizeTripRequest({ ...base, answers: { origin: 'Boston' } }).returnToHome).toBe(true);
    expect(optimizeTripRequest({ ...base, answers: { origin: 'Boston', returnToHome: false } }).returnToHome).toBe(false);
  });
});

describe('totalNightsFor', () => {
  it('an explicit nights pick first, then a concrete date range, else none', () => {
    expect(totalNightsFor({ nights: 5, dateRange: { start: '2027-01-12', end: '2027-01-20' } })).toBe(5);
    expect(totalNightsFor({ dateRange: { start: '2027-01-12', end: '2027-01-20' } })).toBe(8);
    expect(totalNightsFor({ dateRange: { start: 'next month', end: '' } })).toBeUndefined();
    expect(totalNightsFor({})).toBeUndefined();
  });
});
