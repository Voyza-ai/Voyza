import {
  elapsedSeconds,
  listCities,
  searchSteps,
  startSearchProgress,
  type OptimizeProgress,
  type SearchProgressState,
} from '@/lib/searchProgress';

const CITIES = ['Munich', 'Vienna', 'Prague'];

const opt = (patch: Partial<OptimizeProgress>): OptimizeProgress => ({
  stage: 'routes',
  orderings: 6,
  legsAsked: 0,
  legsPriced: 0,
  flightSearches: 0,
  updatedAt: 0,
  ...patch,
});

const at = (patch: Partial<SearchProgressState>): SearchProgressState => ({
  ...startSearchProgress(CITIES, 'New York', 0),
  ...patch,
});

const byKey = (s: SearchProgressState) => Object.fromEntries(searchSteps(s).map((x) => [x.key, x]));

describe('searchSteps', () => {
  it('before any counts arrive: the first two steps run, no numbers are shown', () => {
    const steps = byKey(at({}));
    expect(steps.places.status).toBe('active');
    expect(steps.compare.status).toBe('active');
    expect(steps.compare.detail).toBeUndefined();
    expect(steps.best.status).toBe('pending');
    expect(steps.hotels.status).toBe('pending');
    expect(steps.places.detail).toBe('Munich, Vienna, Prague and New York');
  });

  it('shows the optimizer’s own counts while it compares legs', () => {
    const steps = byKey(at({ optimize: opt({ legsAsked: 12, legsPriced: 9 }) }));
    expect(steps.places.status).toBe('done');
    expect(steps.compare.status).toBe('active');
    expect(steps.compare.detail).toBe('9 of 12 train-vs-flight comparisons done · 6 possible orders');
  });

  it('names the best order once ranking is done, and the home city it prices flights from', () => {
    const steps = byKey(
      at({ optimize: opt({ stage: 'finishing', legsAsked: 12, legsPriced: 12, bestOrder: ['Prague', 'Munich', 'Vienna'] }) }),
    );
    expect(steps.compare.status).toBe('done');
    expect(steps.best.status).toBe('active');
    expect(steps.best.label).toBe('Pricing the best order and flights from New York');
    expect(steps.best.detail).toBe('Prague → Munich → Vienna');
  });

  it('names the cities whose hotels are being priced right now', () => {
    const steps = byKey(at({ phase: 'hotels', hotelsActive: ['Prague', 'Munich'], hotelsDone: [] }));
    expect(steps.best.status).toBe('done');
    expect(steps.hotels.status).toBe('active');
    expect(steps.hotels.label).toBe('Pricing hotels in Prague and Munich');
    expect(steps.hotels.detail).toBe('0 of 3 cities done');

    const later = byKey(at({ phase: 'hotels', hotelsActive: ['Vienna'], hotelsDone: ['Prague', 'Munich'] }));
    expect(later.hotels.label).toBe('Pricing hotels in Vienna');
    expect(later.hotels.detail).toBe('2 of 3 cities done');
  });

  it('marks everything done when the trip opens', () => {
    expect(searchSteps(at({ phase: 'opening' })).every((s) => s.status === 'done')).toBe(true);
  });

  it('without a home city it does not claim to price flights from one', () => {
    const s = startSearchProgress(['Rome', 'Florence'], undefined, 0);
    expect(byKey(s).best.label).toBe('Pricing the best order');
    expect(byKey(s).places.detail).toBe('Rome and Florence');
  });
});

describe('helpers', () => {
  it('lists cities in plain English', () => {
    expect(listCities(['A'])).toBe('A');
    expect(listCities(['A', 'B'])).toBe('A and B');
    expect(listCities(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('counts whole elapsed seconds', () => {
    expect(elapsedSeconds({ startedAt: 1000 }, 4999)).toBe(3);
    expect(elapsedSeconds({ startedAt: 5000 }, 1000)).toBe(0);
  });
});
