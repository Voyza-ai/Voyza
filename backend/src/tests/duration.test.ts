import { parseIsoDuration, parseDurationMinutes } from '../utils/duration';

describe('parseIsoDuration', () => {
  it('parses the forms Duffel actually sends', () => {
    expect(parseIsoDuration('PT7H35M')).toBe(455);
    expect(parseIsoDuration('PT45M')).toBe(45);
    expect(parseIsoDuration('PT7H')).toBe(420);
    expect(parseIsoDuration('PT1H30M0S')).toBe(90);
  });

  it('counts the day part instead of dropping it', () => {
    // An itinerary with an overnight layover exceeds 24h. The old
    // hours+minutes regex read this as 150 minutes.
    expect(parseIsoDuration('P1DT2H30M')).toBe(1590);
    expect(parseIsoDuration('P1D')).toBe(1440);
    expect(parseIsoDuration('P1W')).toBe(10080);
  });

  it('returns null for anything that is not an ISO duration', () => {
    expect(parseIsoDuration('3h 37m')).toBeNull();
    expect(parseIsoDuration('P')).toBeNull();
    expect(parseIsoDuration('garbage')).toBeNull();
    expect(parseIsoDuration('')).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
    // Calendar-ambiguous — no start date, so no minute count.
    expect(parseIsoDuration('P1M')).toBeNull();
    expect(parseIsoDuration('P1Y')).toBeNull();
  });

  it('distinguishes a real zero from unknown', () => {
    expect(parseIsoDuration('PT0S')).toBe(0);
    expect(parseIsoDuration('PT0M')).toBe(0);
  });
});

describe('parseDurationMinutes', () => {
  it('still handles the frontend strings it was written for', () => {
    expect(parseDurationMinutes('3h 37m')).toBe(217);
    expect(parseDurationMinutes('4h')).toBe(240);
    expect(parseDurationMinutes('15m')).toBe(15);
    expect(parseDurationMinutes('102')).toBe(102);
    expect(parseDurationMinutes(217)).toBe(217);
    expect(parseDurationMinutes('')).toBe(0);
    expect(parseDurationMinutes(undefined)).toBe(0);
  });

  it('accepts ISO 8601 durations from provider payloads', () => {
    // "PT45M" used to fall through every branch and return 0.
    expect(parseDurationMinutes('PT45M')).toBe(45);
    expect(parseDurationMinutes('PT7H35M')).toBe(455);
    expect(parseDurationMinutes('P1DT2H30M')).toBe(1590);
  });

  it('reads verbose unit spellings (regression: "3 hours 15 minutes" was 180)', () => {
    expect(parseDurationMinutes('3 hours 15 minutes')).toBe(195);
    expect(parseDurationMinutes('1 hour 1 minute')).toBe(61);
    expect(parseDurationMinutes('2 hrs 5 mins')).toBe(125);
    expect(parseDurationMinutes('1 hr 30 min')).toBe(90);
    expect(parseDurationMinutes('3 hours and 15 minutes')).toBe(195);
    expect(parseDurationMinutes('3 hours, 15 minutes')).toBe(195);
    expect(parseDurationMinutes('4 hours')).toBe(240);
    expect(parseDurationMinutes('45 minutes')).toBe(45);
    expect(parseDurationMinutes('1 day 2 hours')).toBe(1560);
    expect(parseDurationMinutes('3 h 37 m')).toBe(217);
    expect(parseDurationMinutes('3h37m')).toBe(217);
    expect(parseDurationMinutes('1.5 hours')).toBe(90);
  });
});
