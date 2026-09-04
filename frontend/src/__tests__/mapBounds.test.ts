import { shortSpanWest, unwrapLons, spanDegrees, centroid } from '@/lib/mapBounds';

// Real coordinates from trips that exposed the bug.
const PHILADELPHIA = -75.16;
const TOKYO = 139.76;
const NARA = 135.8;
const KYOTO = 135.77;
const PARIS = 2.35;
const AMSTERDAM = 4.9;
const PRAGUE = 14.44;
const LOS_ANGELES = -118.24;
const AUCKLAND = 174.76;
const HONOLULU = -157.86;

describe('spanDegrees', () => {
  it('takes the Pacific route for a US → Japan trip, not the Atlantic one', () => {
    // Naive west-to-east-through-zero is 215° (Philadelphia to Tokyo the long
    // way). The short way runs from Kyoto, the westernmost city, east across
    // the Pacific to Philadelphia at 284.84 — 149°.
    expect(Math.round(spanDegrees([PHILADELPHIA, TOKYO, NARA, KYOTO]))).toBe(149);
  });

  it('leaves an ordinary same-hemisphere trip alone', () => {
    expect(Math.round(spanDegrees([PARIS, AMSTERDAM, PRAGUE]))).toBe(12);
  });

  it('spans the antimeridian for a Los Angeles → Auckland trip', () => {
    // Going east through zero would be 293°; the short way is 67°.
    expect(Math.round(spanDegrees([LOS_ANGELES, AUCKLAND]))).toBe(67);
  });

  it('handles a single point', () => {
    expect(spanDegrees([TOKYO])).toBe(0);
  });

  it('handles no points', () => {
    expect(spanDegrees([])).toBe(0);
  });
});

describe('unwrapLons', () => {
  it('produces a contiguous increasing range across the antimeridian', () => {
    const out = unwrapLons([PHILADELPHIA, TOKYO, KYOTO]);
    // Philadelphia is pushed past 180 so the range runs Japan → Americas.
    expect(Math.min(...out)).toBeCloseTo(KYOTO, 2);
    expect(Math.max(...out)).toBeCloseTo(PHILADELPHIA + 360, 2);
    expect(Math.max(...out)).toBeGreaterThan(180);
  });

  it('leaves longitudes untouched when no wrap is needed', () => {
    expect(unwrapLons([PARIS, AMSTERDAM, PRAGUE])).toEqual([PARIS, AMSTERDAM, PRAGUE]);
  });

  it('preserves input order', () => {
    const input = [TOKYO, PHILADELPHIA, KYOTO];
    const out = unwrapLons(input);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeCloseTo(TOKYO, 2);
    expect(out[2]).toBeCloseTo(KYOTO, 2);
  });

  it('keeps a trip that already straddles the antimeridian together', () => {
    const out = unwrapLons([AUCKLAND, HONOLULU]);
    expect(Math.max(...out) - Math.min(...out)).toBeCloseTo(27.38, 1);
  });
});

describe('shortSpanWest', () => {
  it('starts the span at the first city east of the widest gap', () => {
    // Widest gap is the Pacific-free stretch from Philadelphia east to Kyoto,
    // so the span begins in Japan.
    expect(shortSpanWest([PHILADELPHIA, TOKYO, KYOTO])).toBeCloseTo(KYOTO, 2);
  });

  it('starts at the westernmost point for a compact trip', () => {
    expect(shortSpanWest([PARIS, AMSTERDAM, PRAGUE])).toBeCloseTo(PARIS, 2);
  });

  it('returns 0 for no points', () => {
    expect(shortSpanWest([])).toBe(0);
  });
});

describe('centroid', () => {
  it('averages an ordinary cluster', () => {
    const c = centroid([
      { lat: 35.01, lon: 135.77 }, // Kyoto
      { lat: 34.69, lon: 135.50 }, // Osaka
    ]);
    expect(c.lat).toBeCloseTo(34.85, 1);
    expect(c.lon).toBeCloseTo(135.64, 1);
  });

  it('stays in the Pacific across the antimeridian', () => {
    // Naive averaging puts Auckland + Suva at lon ≈ -1.5, off Africa.
    const c = centroid([
      { lat: -36.85, lon: 174.76 }, // Auckland
      { lat: -18.14, lon: -178.44 }, // Suva
    ]);
    expect(Math.abs(c.lon)).toBeGreaterThan(170);
    expect(c.lat).toBeCloseTo(-27.5, 0);
  });

  it('always returns a longitude inside -180..180', () => {
    const c = centroid([
      { lat: 0, lon: 179 },
      { lat: 0, lon: -179 },
    ]);
    expect(c.lon).toBeGreaterThanOrEqual(-180);
    expect(c.lon).toBeLessThanOrEqual(180);
    expect(Math.abs(c.lon)).toBeCloseTo(180, 0);
  });

  it('returns the point itself for one point', () => {
    expect(centroid([{ lat: 48.85, lon: 2.35 }])).toEqual({ lat: 48.85, lon: 2.35 });
  });

  it('handles an empty list', () => {
    expect(centroid([])).toEqual({ lat: 0, lon: 0 });
  });
});
