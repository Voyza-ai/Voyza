import { searchPresets } from '@/lib/marketplaceSearch';
import { PRESET_ITINERARIES } from '@/data/presetItineraries';

describe('marketplace search', () => {
  test('empty query returns the full marketplace', () => {
    const results = searchPresets('', PRESET_ITINERARIES);
    expect(results).toHaveLength(PRESET_ITINERARIES.length);
  });

  test('filler-only query returns the full marketplace', () => {
    const results = searchPresets('I want to go on a trip somewhere', PRESET_ITINERARIES);
    expect(results).toHaveLength(PRESET_ITINERARIES.length);
  });

  test('natural-language Italy + architecture query ranks the Italy trip first', () => {
    const results = searchPresets(
      "I'm looking for a trip in Italy where I can see a lot of architecture",
      PRESET_ITINERARIES,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].preset.slug).toBe('italian-renaissance-trail');
  });

  test('country adjective matches via prefix (japanese → Japan)', () => {
    const results = searchPresets('japanese temples and food', PRESET_ITINERARIES);
    expect(results[0].preset.slug).toBe('japan-golden-route');
  });

  test('concept expansion: beach finds island escapes without the literal word', () => {
    const results = searchPresets('relaxing beach vacation', PRESET_ITINERARIES);
    const slugs = results.map((r) => r.preset.slug);
    expect(slugs).toContain('greek-island-escape');
  });

  test('train travel query favors the rail circuit', () => {
    const results = searchPresets('europe by train', PRESET_ITINERARIES);
    expect(results[0].preset.slug).toBe('imperial-europe-rail');
  });

  test('city name matches directly', () => {
    const results = searchPresets('machu picchu and cusco', PRESET_ITINERARIES);
    expect(results[0].preset.slug).toBe('south-america-grand-tour');
  });

  test('nonsense query returns no results (drives the AI-planner handoff)', () => {
    const results = searchPresets('zzqx flurbish', PRESET_ITINERARIES);
    expect(results).toHaveLength(0);
  });

  test('results are excluded when nothing meaningful matches', () => {
    const results = searchPresets('italian architecture', PRESET_ITINERARIES);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
    // Southeast Asia has neither Italy nor architecture-adjacent content
    // strong enough to outrank the real match.
    expect(results[0].preset.slug).toBe('italian-renaissance-trail');
  });
});
