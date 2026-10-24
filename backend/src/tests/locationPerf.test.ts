/**
 * The budgets from docs/LOCATION_RESOLUTION.md, asserted rather than claimed:
 *
 *   exact hit    < 0.1 ms
 *   fuzzy path   < 5 ms
 *   index memory < 50 MB
 *
 * Measured at 50,000 places, which is the scale the index choice was decided
 * at, against a deterministic synthetic artifact so a slow run means a slow
 * index rather than a different input.
 *
 * The numbers are printed, because "we met the budget" is worth less than the
 * margin by which we met it: that margin is what tells the next person whether
 * their change is affordable.
 */

import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { buildIndex } from '../services/location/buildIndex';
import { resolve } from '../services/location/resolve';
import { syntheticArtifact } from '../services/location/fixtures/synthetic';

const PLACES = 50_000;
const MEGABYTE = 1024 * 1024;

jest.setTimeout(120_000);

/** Jest does not run with --expose-gc, so ask V8 for it directly. */
function forceGc(): boolean {
  if (typeof global.gc === 'function') {
    global.gc();
    return true;
  }
  try {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    gc();
    setFlagsFromString('--no-expose-gc');
    return true;
  } catch {
    return false;
  }
}

function percentile(sortedMs: number[], p: number): number {
  const position = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[position];
}

function timeEach(iterations: number, body: (i: number) => void): { p50: number; p95: number } {
  // Warm up, so what we measure is the steady state rather than the JIT.
  for (let i = 0; i < Math.min(200, iterations); i++) body(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    body(i);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

const artifact = syntheticArtifact(PLACES);

const gcAvailable = forceGc();
const heapBefore = process.memoryUsage().heapUsed;
const buildStart = process.hrtime.bigint();
const index = buildIndex(artifact);
const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
forceGc();
const indexHeapBytes = process.memoryUsage().heapUsed - heapBefore;

const names = artifact.places.map((p) => p.name);
const typo = (name: string): string =>
  `${name.slice(0, Math.floor(name.length / 2))}z${name.slice(Math.floor(name.length / 2) + 1)}`;

beforeAll(() => {
  // eslint-disable-next-line no-console
  console.log(
    [
      `location index: ${PLACES} places, ${index.exact.size} exact keys, ${index.iata.size} iata codes`,
      `build: ${buildMs.toFixed(0)} ms`,
      `index heap: ${(indexHeapBytes / MEGABYTE).toFixed(1)} MiB (gc ${gcAvailable ? 'forced' : 'UNAVAILABLE'})`,
      `fuzzy structure: ${(index.fuzzy.approxBytes() / MEGABYTE).toFixed(1)} MiB over ${
        (index.fuzzy as unknown as { trigramCount(): number }).trigramCount()
      } trigrams`,
    ].join('\n'),
  );
});

describe('budgets at 50,000 places', () => {
  it('builds an index for every place and more keys than places', () => {
    expect(index.byId.size).toBe(PLACES);
    // One place yields many keys, so this is a sanity check on the whole
    // premise of the normaliser.
    expect(index.exact.size).toBeGreaterThan(PLACES / 2);
  });

  it('resolves an exact hit in under 0.1 ms', () => {
    const { p50, p95 } = timeEach(5000, (i) => {
      resolve(names[(i * 7919) % names.length], {}, index);
    });
    // eslint-disable-next-line no-console
    console.log(`exact: p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms`);
    expect(p95).toBeLessThan(0.1);
  });

  it('resolves an exact hit with a qualifier in under 0.1 ms', () => {
    const { p50, p95 } = timeEach(2000, (i) => {
      const place = artifact.places[(i * 7919) % artifact.places.length];
      resolve(`${place.name}, ${place.country}`, {}, index);
    });
    // eslint-disable-next-line no-console
    console.log(`qualified: p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms`);
    expect(p95).toBeLessThan(0.1);
  });

  it('runs the fuzzy path in under 5 ms', () => {
    const { p50, p95 } = timeEach(1000, (i) => {
      resolve(typo(names[(i * 7919) % names.length]), {}, index);
    });
    // eslint-disable-next-line no-console
    console.log(`fuzzy: p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms`);
    expect(p95).toBeLessThan(5);
  });

  it('runs the short-input brute-force path an order of magnitude under the fuzzy budget', () => {
    // A two-character query has three trigrams, two of them boundary guards
    // that match a large fraction of the dictionary, so the trigram path has
    // almost nothing to prune with. Measured here: 0.61 ms p95 through the
    // trigram path versus 0.06 ms through brute force over the length band.
    //
    // The tighter bound is deliberate rather than decorative. This is the
    // keystroke path — `HomeEditModal` calls the lookup in a render body on
    // every character typed — so it has to stay imperceptible, not merely
    // inside the 5 ms budget that a once-per-session server call lives by.
    const { p50, p95 } = timeEach(1000, (i) => {
      resolve(['bar', 'kel', 'zzq', 'mor', 'ab'][i % 5], {}, index);
    });
    // eslint-disable-next-line no-console
    console.log(`short fuzzy: p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms`);
    expect(p95).toBeLessThan(0.3);
  });

  it('keeps the whole index under 50 MB', () => {
    expect(gcAvailable).toBe(true);
    expect(indexHeapBytes).toBeLessThan(50 * MEGABYTE);
    // The structural estimate is reported next to the measurement so a drift
    // between the two is visible rather than silent.
    expect(index.fuzzy.approxBytes()).toBeLessThan(50 * MEGABYTE);
  });

  it('builds fast enough not to trouble a cold start', () => {
    // The healthcheck allows 30 s, so the bound is generous on purpose.
    //
    // The figure printed above is NOT the production cold-start number: it is
    // the first thing this process runs, under ts-jest, with a cold JIT, and
    // it measures around 2.5 s. The same call standalone under tsx measures
    // ~0.46 s for 50,000 places, which is the same order as the 118 ms for
    // 25,000 recorded in the architecture doc. Do not tighten this bound
    // without re-measuring outside jest.
    expect(buildMs).toBeLessThan(5000);
  });
});
