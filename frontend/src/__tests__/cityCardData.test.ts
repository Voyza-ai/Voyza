import { countryForCity } from '@/data/worldCities';
import { vibesFromAnswer } from '@/lib/vibeMap';

// AI-planned trips must render city cards with the same data presets have:
// a country line under the name and vibe chips. These helpers fill both.
describe('countryForCity', () => {
  test('resolves well-known cities', () => {
    expect(countryForCity('Osaka')).toBe('Japan');
    expect(countryForCity('Kyoto')).toBe('Japan');
    expect(countryForCity('Paris')).toBe('France');
  });

  test('is case-insensitive', () => {
    expect(countryForCity('osaka')).toBe('Japan');
    expect(countryForCity('BARCELONA')).toBe('Spain');
  });

  test('unknown or empty input returns empty string', () => {
    expect(countryForCity('Notarealcityville')).toBe('');
    expect(countryForCity('')).toBe('');
  });
});

describe('vibesFromAnswer', () => {
  test('maps direct vibe words', () => {
    expect(vibesFromAnswer('food')).toEqual(['food']);
    expect(vibesFromAnswer('beach')).toEqual(['beach']);
  });

  test('maps synonyms onto canonical chips', () => {
    expect(vibesFromAnswer('culture')).toEqual(['history', 'art']);
    expect(vibesFromAnswer('adventure')).toEqual(['nature']);
    expect(vibesFromAnswer('romantic getaway')).toEqual(['romance']);
  });

  test('handles multi-word answers and caps at two chips', () => {
    const out = vibesFromAnswer('city food and nightlife');
    expect(out).toHaveLength(2);
    expect(out).toEqual(['city', 'food']);
  });

  test('unmapped or missing answers return no chips', () => {
    expect(vibesFromAnswer('vibey vibes')).toEqual([]);
    expect(vibesFromAnswer(undefined)).toEqual([]);
    expect(vibesFromAnswer(null)).toEqual([]);
  });
});
