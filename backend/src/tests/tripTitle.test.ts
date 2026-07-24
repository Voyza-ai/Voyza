import { resolveTripTitle } from '../utils/tripShape';

/**
 * Regression cover for a bug that made trip names impossible to keep: the
 * canvas save wrote a derived city chain into trips.title on EVERY save, so
 * a trip the owner named was silently renamed back to "Rome · Florence"
 * within seconds of the canvas autosaving — and the owner never saw why.
 */
describe('resolveTripTitle', () => {
  const cities = [{ name: 'Rome' }, { name: 'Florence' }];

  it('keeps the name the owner chose', () => {
    expect(resolveTripTitle('Anniversary Italy Escape', cities)).toBe(
      'Anniversary Italy Escape',
    );
  });

  it('does not let a canvas save overwrite a name with the city chain', () => {
    // The exact regression: a named trip saved from the canvas must not come
    // back out as its route.
    expect(resolveTripTitle('Honeymoon 2027', cities)).not.toBe('Rome · Florence');
  });

  it('derives a label from the cities when the trip is unnamed', () => {
    expect(resolveTripTitle('', cities)).toBe('Rome · Florence');
    expect(resolveTripTitle(undefined, cities)).toBe('Rome · Florence');
    expect(resolveTripTitle(null, cities)).toBe('Rome · Florence');
  });

  it('treats a whitespace-only name as unnamed', () => {
    expect(resolveTripTitle('   ', cities)).toBe('Rome · Florence');
  });

  it('trims the stored name', () => {
    expect(resolveTripTitle('  Spring Break  ', cities)).toBe('Spring Break');
  });

  it('survives missing or malformed city lists', () => {
    expect(resolveTripTitle('', undefined)).toBe('');
    expect(resolveTripTitle('', [])).toBe('');
    expect(resolveTripTitle('', [{ name: 'Rome' }, {}] as any)).toBe('Rome');
  });

  it('keeps a custom name even when there are no cities', () => {
    expect(resolveTripTitle('Someday Trip', [])).toBe('Someday Trip');
  });
});
