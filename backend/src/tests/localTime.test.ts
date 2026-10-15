import {
  hasUtcOffset,
  localTimestampToEpochMs,
  elapsedMinutesBetween,
} from '../utils/localTime';

describe('hasUtcOffset', () => {
  it('recognizes timestamps that pin an instant', () => {
    expect(hasUtcOffset('2026-06-01T08:00:00Z')).toBe(true);
    expect(hasUtcOffset('2026-06-01T08:00:00+02:00')).toBe(true);
    expect(hasUtcOffset('2026-06-01T08:00:00-0500')).toBe(true);
  });

  it('recognizes the offset-free shape Duffel actually sends', () => {
    expect(hasUtcOffset('2026-06-01T08:00:00')).toBe(false);
    expect(hasUtcOffset('2026-06-01T08:00')).toBe(false);
  });
});

describe('localTimestampToEpochMs', () => {
  it('anchors a wall-clock time in its own zone', () => {
    expect(localTimestampToEpochMs('2026-06-01T21:00:00', 'Asia/Tokyo')).toBe(
      Date.parse('2026-06-01T12:00:00Z'),
    );
    expect(
      localTimestampToEpochMs('2026-06-01T09:00:00', 'Pacific/Honolulu'),
    ).toBe(Date.parse('2026-06-01T19:00:00Z'));
  });

  it('applies the offset in effect on that date, not a fixed one', () => {
    // Europe/London is UTC in winter and UTC+1 in summer.
    expect(localTimestampToEpochMs('2026-01-15T12:00:00', 'Europe/London')).toBe(
      Date.parse('2026-01-15T12:00:00Z'),
    );
    expect(localTimestampToEpochMs('2026-07-15T12:00:00', 'Europe/London')).toBe(
      Date.parse('2026-07-15T11:00:00Z'),
    );
  });

  it('handles a timestamp on a DST changeover day', () => {
    // The US springs forward at 02:00 local on 2026-03-08.
    expect(
      localTimestampToEpochMs('2026-03-08T01:30:00', 'America/New_York'),
    ).toBe(Date.parse('2026-03-08T06:30:00Z')); // still EST (-5)
    expect(localTimestampToEpochMs('2026-03-08T03:00:00', 'America/Chicago')).toBe(
      Date.parse('2026-03-08T08:00:00Z'), // already CDT (-5)
    );
  });

  it('handles sub-hour zone offsets', () => {
    expect(localTimestampToEpochMs('2026-06-01T12:00:00', 'Asia/Kathmandu')).toBe(
      Date.parse('2026-06-01T06:15:00Z'), // +05:45
    );
  });

  it('returns null rather than guessing', () => {
    expect(localTimestampToEpochMs('not a timestamp', 'Asia/Tokyo')).toBeNull();
    expect(localTimestampToEpochMs('2026-06-01T12:00:00', 'Not/AZone')).toBeNull();
  });
});

describe('elapsedMinutesBetween', () => {
  it('crosses the date line westbound without going negative', () => {
    // NRT 21:00 JST → HNL 09:00 HST, same calendar day. Subtracting these
    // naively gave -720; it is really a 7h flight.
    expect(
      elapsedMinutesBetween(
        '2026-06-01T21:00:00',
        '2026-06-01T09:00:00',
        'Asia/Tokyo',
        'Pacific/Honolulu',
      ),
    ).toBe(420);
  });

  it('does not inflate an eastbound flight', () => {
    // JFK 22:00 → LHR 10:00 next day reads as 12h on the clock; it is 7h.
    expect(
      elapsedMinutesBetween(
        '2026-06-01T22:00:00',
        '2026-06-02T10:00:00',
        'America/New_York',
        'Europe/London',
      ),
    ).toBe(420);
  });

  it('handles an arrival that appears earlier than departure', () => {
    // SYD 10:00 → LAX 06:30, arriving "before" it left in clock terms.
    expect(
      elapsedMinutesBetween(
        '2026-06-02T10:00:00',
        '2026-06-02T06:30:00',
        'Australia/Sydney',
        'America/Los_Angeles',
      ),
    ).toBe(810);
  });

  it('trusts timestamps that already carry an offset', () => {
    expect(
      elapsedMinutesBetween('2026-06-01T08:00:00Z', '2026-06-01T10:30:00Z'),
    ).toBe(150);
    expect(
      elapsedMinutesBetween(
        '2026-06-01T08:00:00+02:00',
        '2026-06-01T12:30:00+02:00',
      ),
    ).toBe(270);
  });

  it('returns null when offset-free timestamps have no zone to anchor them', () => {
    // Subtracting these would be the original bug.
    expect(
      elapsedMinutesBetween('2026-06-01T21:00:00', '2026-06-01T09:00:00'),
    ).toBeNull();
  });

  it('returns null instead of a non-positive duration', () => {
    expect(
      elapsedMinutesBetween(
        '2026-06-01T10:00:00',
        '2026-06-01T10:00:00',
        'Europe/Rome',
        'Europe/Rome',
      ),
    ).toBeNull();
    expect(elapsedMinutesBetween(null, '2026-06-01T10:00:00')).toBeNull();
    expect(elapsedMinutesBetween('2026-06-01T10:00:00', undefined)).toBeNull();
  });
});
