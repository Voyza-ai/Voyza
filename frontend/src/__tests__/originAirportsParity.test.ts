/**
 * Drift guard for the duplicated origin-airport lookup.
 *
 * backend/src/data/originAirports.ts and frontend/lib/originAirports.ts are
 * two copies of the same table. They cannot import each other: the two
 * packages have no workspace root, backend's tsconfig pins `rootDir: ./src`
 * (so it refuses to compile a file outside src/), and Next's bundler scope
 * stops at frontend/. So the copies are kept honest by reading BOTH files
 * off disk here and comparing them.
 *
 * An identical copy of this test lives at
 * backend/src/tests/originAirportsParity.test.ts, so drift fails
 * whichever suite you run.
 */

import * as fs from 'fs';
import * as path from 'path';

const BACKEND_FILE = path.resolve(
  __dirname,
  '../../../backend/src/data/originAirports.ts',
);
const FRONTEND_FILE = path.resolve(__dirname, '../../lib/originAirports.ts');

function read(file: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(
      `originAirports parity test could not find ${file}. Both packages must ` +
        `be present in the same checkout for this guard to run.`,
    );
  }
  return fs.readFileSync(file, 'utf8');
}

/** The `MULTI_AIRPORT_CITIES` object literal, as source text. */
function tableLiteral(src: string): string {
  const anchor = src.indexOf('MULTI_AIRPORT_CITIES');
  expect(anchor).toBeGreaterThan(-1);
  const start = src.indexOf('{', anchor);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated MULTI_AIRPORT_CITIES literal');
}

/** Evaluate the literal. It is plain JS (comments and all) once sliced. */
function tableOf(src: string): Record<string, string[]> {
  // eslint-disable-next-line no-new-func
  return new Function(`return ${tableLiteral(src)};`)();
}

/** Everything from the table to EOF — table plus the exported functions. */
function codeRegion(src: string): string {
  return src.slice(src.indexOf('const MULTI_AIRPORT_CITIES'));
}

/** Entry keys in source order, so duplicates are still visible. */
function rawKeys(literal: string): string[] {
  return literal
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => /^'?[^':]+'?\s*:/.test(l))
    .map((l) => l.match(/^'?([^':]+?)'?\s*:/)![1]);
}

describe('originAirports: backend/frontend parity', () => {
  const backendSrc = read(BACKEND_FILE);
  const frontendSrc = read(FRONTEND_FILE);

  it('has the same keys, in the same order, in both copies', () => {
    expect(Object.keys(tableOf(frontendSrc))).toEqual(
      Object.keys(tableOf(backendSrc)),
    );
  });

  it('maps every key to the same airports in both copies', () => {
    expect(tableOf(frontendSrc)).toEqual(tableOf(backendSrc));
  });

  it('keeps the table source byte-identical', () => {
    // Stronger than the deep-equal above: catches a comment or ordering
    // edit applied to only one copy, which is how drift normally starts.
    expect(tableLiteral(frontendSrc)).toBe(tableLiteral(backendSrc));
  });

  it('keeps the lookup functions byte-identical too', () => {
    // The tables agreed before this test existed; what had actually
    // drifted was behaviour — the frontend copy was missing
    // isMultiAirportCity and the backend copy was missing the falsy
    // cityName guard. Compare the whole code region so that cannot recur.
    expect(codeRegion(frontendSrc)).toBe(codeRegion(backendSrc));
  });

  it('exports the same lookup surface from both copies', () => {
    for (const src of [backendSrc, frontendSrc]) {
      expect(src).toContain('export function getOriginAirports');
      expect(src).toContain('export function isMultiAirportCity');
    }
  });

  it('has no duplicate keys in either copy', () => {
    // A repeated key is valid JS and silently wins, so deep-equal alone
    // would not notice it.
    for (const src of [backendSrc, frontendSrc]) {
      const keys = rawKeys(tableLiteral(src));
      expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
      expect(keys).toHaveLength(Object.keys(tableOf(src)).length);
    }
  });

  it('maps every state alias to the same list as its dominant metro', () => {
    // A state alias must inherit its metro's FULL list, not a subset:
    // mapping Illinois to ORD alone would silently drop Midway for anyone
    // who types the state instead of the city.
    const table = tableOf(backendSrc);
    const STATE_TO_METRO: Array<[string, string]> = [
      ['illinois', 'chicago'], ['il', 'chicago'],
      ['new york state', 'new york'], ['ny', 'new york'],
      ['connecticut', 'hartford'], ['ct', 'hartford'],
      ['rhode island', 'providence'], ['ri', 'providence'],
      ['massachusetts', 'boston'], ['ma', 'boston'],
      ['delaware', 'philadelphia'], ['de', 'philadelphia'],
      ['maryland', 'baltimore'], ['md', 'baltimore'],
      ['georgia', 'atlanta'], ['ga', 'atlanta'],
      ['arizona', 'phoenix'], ['az', 'phoenix'],
      ['nevada', 'las vegas'], ['nv', 'las vegas'],
      ['utah', 'salt lake city'], ['ut', 'salt lake city'],
      ['colorado', 'denver'], ['co', 'denver'],
      ['minnesota', 'minneapolis'], ['mn', 'minneapolis'],
      ['michigan', 'detroit'], ['mi', 'detroit'],
      ['hawaii', 'honolulu'],
      ['washington state', 'seattle'], ['wa', 'seattle'],
    ];
    for (const [state, metro] of STATE_TO_METRO) {
      expect(table[state]).toBeDefined();
      expect(table[metro]).toBeDefined();
      expect([...table[state]].sort()).toEqual([...table[metro]].sort());
    }
  });

  it('keys New Jersey to the NYC metro with Newark first', () => {
    // Same set as 'new york', reordered so the traveller's own state
    // airport is the primary.
    const table = tableOf(backendSrc);
    expect(table['new jersey']).toEqual(['EWR', 'JFK', 'LGA']);
    expect([...table['new jersey']].sort()).toEqual([...table['new york']].sort());
  });

  it('never lets Washington the state collapse onto Washington DC', () => {
    const table = tableOf(backendSrc);
    expect(table['washington']).toEqual(['IAD', 'DCA', 'BWI']);
    expect(table['washington state']).toEqual(['SEA']);
  });

  it('keeps every airport list within the documented cap of 3', () => {
    for (const [city, codes] of Object.entries(tableOf(backendSrc))) {
      expect(codes.length).toBeGreaterThan(0);
      expect(codes.length).toBeLessThanOrEqual(3);
      // Every entry is a bare uppercase IATA code.
      codes.forEach((c) => expect(c).toMatch(/^[A-Z]{3}$/));
      expect(new Set(codes).size).toBe(codes.length);
      expect(city).toBe(city.toLowerCase());
    }
  });
});
