/**
 * The text bot applies a YES with the website's own functions, bundled from
 * frontend/lib (scripts/build-trip-edits.mjs). This fails when the bundle is
 * older than those frontend files — then run `npm run build:trip-edits`.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';

describe('trip-edits bundle', () => {
  it('is up to date with frontend/lib', () => {
    const out = execFileSync('node', [join(__dirname, '..', '..', 'scripts', 'build-trip-edits.mjs'), '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/up to date/);
  }, 60_000);

  it('exports the functions the bot uses', () => {
    const t = require('../services/textbot/tripEdits');
    for (const k of ['applyCityEdit', 'applyTransportChange', 'transportChangeApplies', 'liveTripTotalFrontend']) {
      expect(typeof t[k]).toBe('function');
    }
  });
});
