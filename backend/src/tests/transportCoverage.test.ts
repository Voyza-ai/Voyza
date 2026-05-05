/**
 * Live transport-coverage probe — hits Duffel + Deutsche Bahn for real.
 *
 * The other test files in this folder mock everything; this one
 * deliberately does not. The point is to surface real-world coverage
 * gaps (regions where neither flights nor trains come back, currencies
 * mis-converting, sandbox pricing leaking through) by running 10
 * representative routes end-to-end.
 *
 * Why this lives here vs as a CI integration suite:
 *   - Slow (~30–60s for 10 routes)
 *   - Hits paid APIs — running on every PR would burn rate limits and
 *     give flaky failures
 *   - Designed for human review, not green/red gating
 *
 * Run on demand:
 *   cd backend && npx jest transportCoverage --runInBand
 *
 * Each route asserts ONE of three outcomes:
 *   1. Flight available (price > 0)
 *   2. Train available (price > 0 OR price === null with limitedCoverage)
 *   3. Explicitly unavailable (recommendation === 'unavailable')
 *
 * The "explicitly unavailable" branch is a passing outcome — the point
 * of the fix is to surface that to the user instead of silently rendering
 * a $0 leg. Each route logs its outcome so the human reviewer can decide
 * if a region the user cares about is silently uncovered.
 */

import 'dotenv/config';
import { compareLeg } from '../services/compareLeg';

// Six months out so dates are always in Duffel's bookable window.
const futureDate = (() => {
  const d = new Date();
  d.setMonth(d.getMonth() + 6);
  return d.toISOString().split('T')[0];
})();

type RouteCase = {
  label: string;
  origin: string;
  destination: string;
  originCountry?: string;
  destinationCountry?: string;
  /** Where we expect coverage to come from — informational. */
  expect: 'flight+train' | 'flight-only' | 'train-only' | 'maybe-none';
};

const routes: RouteCase[] = [
  {
    label: 'Florence → Rome (intra-Italy)',
    origin: 'Florence',
    destination: 'Rome',
    originCountry: 'IT',
    destinationCountry: 'IT',
    expect: 'flight+train',
  },
  {
    label: 'Rome → Venice (intra-Italy)',
    origin: 'Rome',
    destination: 'Venice',
    originCountry: 'IT',
    destinationCountry: 'IT',
    expect: 'flight+train',
  },
  {
    label: 'Paris → London (Eurostar territory)',
    origin: 'Paris',
    destination: 'London',
    originCountry: 'FR',
    destinationCountry: 'GB',
    expect: 'flight+train',
  },
  {
    label: 'Berlin → Prague (DB REST coverage)',
    origin: 'Berlin',
    destination: 'Prague',
    originCountry: 'DE',
    destinationCountry: 'CZ',
    expect: 'flight+train',
  },
  {
    label: 'London → Athens (long EU)',
    origin: 'London',
    destination: 'Athens',
    originCountry: 'GB',
    destinationCountry: 'GR',
    expect: 'flight-only',
  },
  {
    label: 'New York → Los Angeles (US domestic, no rail)',
    origin: 'New York',
    destination: 'Los Angeles',
    originCountry: 'US',
    destinationCountry: 'US',
    expect: 'flight-only',
  },
  {
    label: 'Tokyo → Osaka (Asia, static train table)',
    origin: 'Tokyo',
    destination: 'Osaka',
    originCountry: 'JP',
    destinationCountry: 'JP',
    expect: 'flight+train',
  },
  {
    label: 'Bangkok → Chiang Mai (Asia, possible coverage gap)',
    origin: 'Bangkok',
    destination: 'Chiang Mai',
    originCountry: 'TH',
    destinationCountry: 'TH',
    expect: 'maybe-none',
  },
  {
    label: 'New York → Rome (transatlantic)',
    origin: 'New York',
    destination: 'Rome',
    originCountry: 'US',
    destinationCountry: 'IT',
    expect: 'flight-only',
  },
  {
    label: 'Reykjavik → Faroe Islands (edge case)',
    origin: 'Reykjavik',
    destination: 'Torshavn',
    originCountry: 'IS',
    destinationCountry: 'FO',
    expect: 'maybe-none',
  },
];

describe('transport coverage — live API probe', () => {
  // 90s per route is generous; Duffel offer requests routinely take 5–15s.
  jest.setTimeout(90_000);

  // Skip the whole suite if Duffel isn't configured — running with a missing
  // token would fail every case for the wrong reason.
  const haveDuffel = !!process.env.DUFFEL_ACCESS_TOKEN;
  if (!haveDuffel) {
    test.skip('skipping live probes — DUFFEL_ACCESS_TOKEN not set', () => {});
    return;
  }

  for (const route of routes) {
    test(route.label, async () => {
      const cmp = await compareLeg({
        origin: route.origin,
        destination: route.destination,
        date: futureDate,
        travelers: 2,
        originCountry: route.originCountry,
        destinationCountry: route.destinationCountry,
      });

      const flightOk = cmp.flightOption && cmp.flightOption.price > 0;
      const trainOk =
        cmp.trainOption &&
        (cmp.trainOption.price === null || cmp.trainOption.price > 0);
      const explicitlyUnavailable = cmp.recommendation === 'unavailable';

      // Log the outcome so a human reviewer can spot regions where
      // we're silently uncovered even though the test technically passes.
      // eslint-disable-next-line no-console
      console.log(
        `[${route.label}] flight=${cmp.flightOption ? `$${cmp.flightOption.price}` : 'null'}` +
          ` train=${cmp.trainOption ? `$${cmp.trainOption.price ?? '?'}` : 'null'}` +
          ` rec=${cmp.recommendation}` +
          ` (expected: ${route.expect})`,
      );

      // Acceptable outcomes:
      //   - At least one mode came back with a real price, OR
      //   - Both came back null AND recommendation === 'unavailable'
      //     (the user-facing "no transport" card will render).
      // What's NOT acceptable: both null but recommendation is something
      // other than 'unavailable' — that means the comparison is lying
      // about coverage and a $0 pill would render in the UI.
      if (!flightOk && !trainOk) {
        expect(explicitlyUnavailable).toBe(true);
      } else {
        // At least one option exists; recommendation should reflect that.
        expect(['flight', 'train']).toContain(cmp.recommendation);
      }
    });
  }
});
