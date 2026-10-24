/**
 * The GeoNames credit is a LICENCE TERM, not a label.
 *
 * CC BY 4.0 obliges credit, a licence link and an indication of changes. The
 * exact wording is written down twice by necessity — once in ATTRIBUTION.md,
 * where a human reads it, and once in `src/data/attribution.ts`, where the
 * endpoint and the hot-set generator read it — so this compares them. A
 * paraphrase that drifts out of one of them is a licence problem, and nothing
 * else in the suite would notice.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { attributionLine, LOCATION_DATA_ATTRIBUTION } from '../data/attribution';
import hotSetJson from '../data/generated/locationHotSet.json';

const ATTRIBUTION_MD = readFileSync(join(__dirname, '../../../ATTRIBUTION.md'), 'utf8');

describe('the credit text', () => {
  it('says all three things the licence requires', () => {
    const line = attributionLine();
    expect(line).toContain('GeoNames');
    expect(line).toContain('CC BY 4.0');
    expect(line).toContain('https://creativecommons.org/licenses/by/4.0/');
    // The one people forget. CC BY requires modifications to be indicated,
    // and this data is heavily modified: filtered, joined and reduced.
    expect(line.toLowerCase()).toContain('modified');
  });

  it('matches the required block in ATTRIBUTION.md word for word', () => {
    // The document is the canonical statement of what is owed; the code is
    // what actually ships. Compared on normalised whitespace, because the
    // document hard-wraps and the code does not.
    const required = ATTRIBUTION_MD.split('### Required credit text')[1]
      ?.split('```')[1]
      ?.replace(/\s+/g, ' ')
      .trim();
    expect(required).toBeTruthy();
    expect(attributionLine().replace(/\s+/g, ' ').trim()).toBe(required);
  });

  it('travels with the data into the browser hot set', () => {
    // So the frontend renders the licence's own words rather than a copy.
    expect((hotSetJson as unknown as { attribution: unknown }).attribution).toEqual(
      LOCATION_DATA_ATTRIBUTION,
    );
  });
});
