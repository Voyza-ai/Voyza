import { summarizeCanvasChanges } from '@/lib/canvasDiff';

const city = (name: string, arrival: string, departure: string, hotel = 'Base Hotel') => ({
  name,
  dates: { arrival, departure },
  hotels: [{ name: hotel }],
  selectedHotelIndex: 0,
});

const state = (cities: any[], origin: string | null = null) => ({
  cities,
  trip: origin ? { origin: { city: origin } } : {},
});

describe('summarizeCanvasChanges', () => {
  const before = state(
    [city('Rome', '2026-08-01', '2026-08-03'), city('Florence', '2026-08-03', '2026-08-05')],
    'New York',
  );

  it('reports added and removed cities', () => {
    const after = state(
      [city('Rome', '2026-08-01', '2026-08-03'), city('Venice', '2026-08-03', '2026-08-05')],
      'New York',
    );
    const lines = summarizeCanvasChanges(before, after);
    expect(lines).toContain('Add Venice');
    expect(lines).toContain('Remove Florence');
  });

  it('reports night changes', () => {
    const after = state(
      [city('Rome', '2026-08-01', '2026-08-04'), city('Florence', '2026-08-04', '2026-08-06')],
      'New York',
    );
    const lines = summarizeCanvasChanges(before, after);
    expect(lines).toContain('Rome: 2 → 3 nights');
  });

  it('reports hotel swaps', () => {
    const after = state(
      [
        city('Rome', '2026-08-01', '2026-08-03', 'Palazzo Nuovo'),
        city('Florence', '2026-08-03', '2026-08-05'),
      ],
      'New York',
    );
    expect(summarizeCanvasChanges(before, after)).toContain('Rome: hotel → Palazzo Nuovo');
  });

  it('reports reorders', () => {
    const after = state(
      [city('Florence', '2026-08-01', '2026-08-03'), city('Rome', '2026-08-03', '2026-08-05')],
      'New York',
    );
    expect(
      summarizeCanvasChanges(before, after).some((l) => l.startsWith('Reorder to Florence → Rome')),
    ).toBe(true);
  });

  it('reports origin changes and falls back for no-ops', () => {
    const after = state(before.cities, 'Boston');
    expect(summarizeCanvasChanges(before, after)).toContain('Home city → Boston');
    expect(summarizeCanvasChanges(before, before)).toEqual([
      'Small tweaks (no structural changes)',
    ]);
  });
});
