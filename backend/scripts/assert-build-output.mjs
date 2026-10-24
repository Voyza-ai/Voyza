/**
 * Post-build assertion: the generated location data reached `dist/`.
 *
 * WHY THIS EXISTS — verified by experiment, do not rediscover.
 *
 * `tsc` does not copy non-TS files. An artifact referenced as
 * `fs.readFileSync(__dirname + '/places.json')` is never emitted: it works
 * under `npm run dev`, where tsx reads from `src/`, and the process dies at
 * boot on Railway, where only `dist/` ships. `src/data/locationArtifact.ts`
 * therefore uses `import ... from './generated/places.json'`, which tsc does
 * emit — and this script checks that it actually did, on every build, rather
 * than finding out from a failed healthcheck.
 *
 * Plain .mjs on purpose: it runs after `tsc` with no compile step of its own
 * and no dependency on tsx being present.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(backendRoot, 'dist');

const required = [
  { path: join(dist, 'index.js'), minBytes: 1 },
  { path: join(dist, 'data', 'locationArtifact.js'), minBytes: 1 },
  // The artifact is ~13 MiB of places; anything tiny means an empty or
  // truncated emit, which a bare existence check would wave through.
  { path: join(dist, 'data', 'generated', 'places.json'), minBytes: 1_000_000 },
  { path: join(dist, 'data', 'generated', 'codes.json'), minBytes: 500 },
];

const problems = [];
for (const { path, minBytes } of required) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    problems.push(`missing from the build output: ${path}`);
    continue;
  }
  if (size < minBytes) {
    problems.push(`${path} is ${size} bytes, expected at least ${minBytes}`);
  }
}

if (!problems.length) {
  const artifact = JSON.parse(
    readFileSync(join(dist, 'data', 'generated', 'places.json'), 'utf8'),
  );
  if (!Array.isArray(artifact.places) || artifact.places.length < 1000) {
    problems.push(
      `dist places.json holds ${artifact.places?.length ?? 0} places; the artifact is not a stub`,
    );
  }
}

if (problems.length) {
  console.error('build output assertion FAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\n`tsc` only emits a JSON file that is IMPORTED from TypeScript inside rootDir. ' +
      'If the artifact is now read with fs.readFileSync, it will not be emitted and ' +
      'the server will crash at boot in production. Either import it, or add an ' +
      'explicit copy step to `npm run build`.',
  );
  process.exit(1);
}

console.log('build output assertion passed: dist/ carries the location artifact');
