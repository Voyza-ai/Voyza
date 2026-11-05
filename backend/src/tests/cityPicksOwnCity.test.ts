/**
 * ROADMAP bug: duplicate AI suggestions across nearby cities (the Uffizi
 * recommended for Rome as well as Florence). Each city's picks are now asked
 * knowing the trip's other stops, and anything that says it is in one of them
 * is dropped from this city's list.
 */
import { keepOwnCity, otherStops, otherStopsHint } from '../utils/cityPicks';

describe('otherStops / otherStopsHint', () => {
  it('lists the other stops, not this one, once each', () => {
    expect(otherStops('Rome', ['Rome', 'Florence', 'florence', 'Venice'])).toEqual(['Florence', 'Venice']);
  });

  it('tells the model the picks must be in this city', () => {
    const hint = otherStopsHint('Rome', ['Rome', 'Florence']);
    expect(hint).toContain('also stops in Florence');
    expect(hint).toContain('physically located in Rome');
    expect(otherStopsHint('Rome', ['Rome'])).toBe('');
    expect(otherStopsHint('Rome', undefined)).toBe('');
  });
});

describe('keepOwnCity', () => {
  const rome = [
    { name: 'Colosseum', placeQuery: 'Colosseo' },
    { name: 'Uffizi Gallery', placeQuery: 'Galleria degli Uffizi, Florence' },
    { name: 'Day trip to Florence', placeQuery: null },
    { name: 'Dinner on Via Firenze', placeQuery: 'Via Firenze, Rome' },
    { name: 'Romeo e Giulietta wine bar', placeQuery: 'Trastevere' },
  ];

  it('drops picks placed in another stop and keeps the rest', () => {
    const kept = keepOwnCity(rome, 'Rome', ['Rome', 'Florence', 'Firenze']).map((x) => x.name);
    expect(kept).toEqual(['Colosseum', 'Dinner on Via Firenze', 'Romeo e Giulietta wine bar']);
  });

  it('matches whole words, ignoring accents and case', () => {
    const items = [{ name: 'Musée de Montréal', placeQuery: null }, { name: 'Parisian cafe', placeQuery: null }];
    expect(keepOwnCity(items, 'Quebec City', ['Montreal', 'Paris']).map((x) => x.name)).toEqual(['Parisian cafe']);
  });

  it('is a no-op for a one-city trip', () => {
    expect(keepOwnCity(rome, 'Rome', undefined)).toHaveLength(rome.length);
  });
});
