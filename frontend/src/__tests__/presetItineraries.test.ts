import {
  PRESET_ITINERARIES,
  presetNights,
  presetDurationBucket,
  presetBudgetBucket,
  presetVibes,
  buildPresetTrip,
} from '@/data/presetItineraries';

describe('preset itineraries catalog', () => {
  test('slugs are unique', () => {
    const slugs = PRESET_ITINERARIES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('every preset has at least one city with nights and a hotel', () => {
    for (const p of PRESET_ITINERARIES) {
      expect(p.cities.length).toBeGreaterThan(0);
      for (const c of p.cities) {
        expect(c.nights).toBeGreaterThan(0);
        expect(c.hotel.name).toBeTruthy();
      }
    }
  });

  test('duration buckets classify by total nights', () => {
    const bySlug = (slug: string) =>
      PRESET_ITINERARIES.find((p) => p.slug === slug)!;
    expect(presetDurationBucket(bySlug('paris-long-weekend'))).toBe('short');
    expect(presetDurationBucket(bySlug('japan-golden-route'))).toBe('medium');
    expect(presetDurationBucket(bySlug('grand-asia-expedition'))).toBe('long');
  });

  test('catalog covers all three duration buckets (filter chips depend on it)', () => {
    const buckets = new Set(PRESET_ITINERARIES.map(presetDurationBucket));
    expect(buckets.has('short')).toBe(true);
    expect(buckets.has('medium')).toBe(true);
    expect(buckets.has('long')).toBe(true);
  });

  test('catalog covers all budget buckets (filter chips depend on it)', () => {
    const buckets = new Set(PRESET_ITINERARIES.map(presetBudgetBucket));
    expect(buckets.has('budget')).toBe(true);
    expect(buckets.has('mid')).toBe(true);
    expect(buckets.has('premium')).toBe(true);
  });

  test('every preset exposes at least one vibe for the vibe filter', () => {
    for (const p of PRESET_ITINERARIES) {
      expect(presetVibes(p).length).toBeGreaterThan(0);
    }
  });

  test('built trips chain dates city-to-city with no gaps', () => {
    for (const p of PRESET_ITINERARIES) {
      const trip = buildPresetTrip(p);
      for (let i = 1; i < trip.cities.length; i++) {
        expect(trip.cities[i].dates.arrival).toBe(trip.cities[i - 1].dates.departure);
      }
      expect(presetNights(p)).toBeGreaterThan(0);
    }
  });
});
