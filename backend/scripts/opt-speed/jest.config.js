/**
 * Jest config for the optimizer speed harness. NOT part of `npm test` (the
 * main config's roots are src/ only): these runs take minutes.
 *
 *   cd backend
 *   npx jest -c scripts/opt-speed/jest.config.js gate        # quality gate
 *   npx jest -c scripts/opt-speed/jest.config.js timing      # requests + modelled time
 *
 * OPT_SPEED_BASELINE=1 runs the same harness against the optimizer as it was
 * on dev (332b564), kept in baseline/optimizer.dev.ts.
 */
module.exports = {
  testEnvironment: 'node',
  // tsconfig.scripts.json: rootDir is the backend, so scripts/ may import src/.
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.scripts.json' }] },
  rootDir: '../..',
  roots: ['<rootDir>/scripts/opt-speed'],
  testMatch: ['**/*.harness.ts'],
  testTimeout: 60 * 60 * 1000,
};
