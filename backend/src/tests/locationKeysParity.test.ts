/**
 * Drift guard for the shared key normaliser.
 *
 * `backend/src/services/location/keys.ts` and `frontend/lib/locationKeys.ts`
 * are the same file. The frontend copy is WRITTEN BY
 * `backend/scripts/build-location-hotset.ts`, so it is a build output rather
 * than something a person maintains — but a build output still drifts if
 * someone edits the copy, or forgets to re-run the build after editing the
 * source. This fails in both cases.
 *
 * Why a copy at all: the two packages have no workspace root, backend's
 * tsconfig pins `rootDir: ./src` so it refuses to compile anything outside
 * src/, and Next's bundler scope stops at frontend/. The same reasoning is
 * recorded in `originAirportsParity.test.ts`, for the hand-written table this
 * replaces.
 *
 * Why the drift matters more than it looks: the browser normalises the
 * traveller's input and the generator normalised the artifact's keys. A
 * divergence does not fail loudly — it silently makes whichever spellings it
 * touches unreachable from the browser, so `Köln` or `Đà Nẵng` would simply
 * stop being found while every test that does not compare the two files
 * passes.
 *
 * An identical copy of this test lives in the other package, so drift fails
 * whichever suite you run.
 */

import * as fs from 'fs';
import * as path from 'path';

const BACKEND_FILE = path.resolve(__dirname, '../services/location/keys.ts');
const FRONTEND_FILE = path.resolve(__dirname, '../../../frontend/lib/locationKeys.ts');

function read(file: string, label: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(
      `location keys parity test could not find the ${label} copy at ${file}. ` +
        `Both packages must be present in the same checkout for this guard to run.`,
    );
  }
  return fs.readFileSync(file, 'utf8');
}

describe('keys.ts is the same file in both packages', () => {
  it('is byte-for-byte identical', () => {
    const backend = read(BACKEND_FILE, 'backend');
    const frontend = read(FRONTEND_FILE, 'frontend');
    // Compared as whole text, not structurally: the whole point is that this
    // is a copy, so any difference at all is drift. If this fails, re-run
    // `npm run build:location-hotset` in backend/ rather than hand-editing
    // the frontend copy.
    expect(frontend).toBe(backend);
  });

  it('has no imports, which is what makes the copy safe', () => {
    // The file can only be copied verbatim while it depends on nothing. The
    // moment it imports a type or a helper, the copy stops compiling in the
    // other package and this guard stops being able to compare them at all.
    const backend = read(BACKEND_FILE, 'backend');
    const importLines = backend
      .split('\n')
      .filter((line) => /^\s*(import|export)\s+.*\bfrom\b/.test(line));
    expect(importLines).toEqual([]);
    expect(backend).not.toMatch(/\brequire\s*\(/);
  });

  it('still exports what the browser resolver needs', () => {
    // Non-vacuity. A parity test over an empty or renamed file passes while
    // asserting nothing about the normalisation both sides depend on.
    const backend = read(BACKEND_FILE, 'backend');
    // Either form counts: `keysForQuery` is an alias (`export const`), the
    // others are `export function`.
    for (const symbol of ['normalizeKeys', 'keysForQuery', 'splitSegments', 'hasLatinForm']) {
      expect(backend).toMatch(new RegExp(`export (function|const) ${symbol}\\b`));
    }
    expect(backend.length).toBeGreaterThan(2_000);
  });
});
