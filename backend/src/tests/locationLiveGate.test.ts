/**
 * The gate for flipping `LOCATION_RESOLVER_MODE` to `live`.
 *
 * There is one Supabase project and it holds real trips, so "the tests pass"
 * is not enough evidence to change which airport someone flies from. This
 * suite is the evidence, and it is runnable on demand rather than a week of
 * waiting: the table being replaced ships with its own test suite, which is a
 * census of 132 real inputs with answers a human chose.
 *
 * Two assertions are hard requirements and fail the build:
 *
 *  1. the resolver never returns NOTHING for an input the table answers. A
 *     regression here means a traveller who could name their origin yesterday
 *     cannot today. It caught `Washington State` and `New York State`.
 *  2. the leading airport matches on every key where the two agree enough to
 *     compare — see `ACCEPTED_LEAD_CHANGES`.
 *
 * The third part is a LEDGER, not a threshold. Every key where the leading
 * airport differs is listed below with the reason it is acceptable. The list
 * is committed so the diff shows movement in either direction: a new entry
 * means the resolver started disagreeing somewhere new and somebody has to
 * look, and a disappearing entry means it stopped. "It seems fine" is not a
 * gate; this is.
 *
 * `airports[0]` is the right thing to compare because it is the airport
 * `estimateHomeLegCost` ranks route permutations from. Extra fallbacks after
 * it are a gain, not a difference — `buildHomeLeg` prices every survivor of
 * the `MAX_HOME_AIRPORTS` cap and takes the cheapest.
 */

import { getOriginAirports, MULTI_AIRPORT_CITY_KEYS } from '../data/originAirports';
import { resolveOriginAirports } from '../services/location/originAirports';

/**
 * Keys where the resolver leads with a different airport than the table, and
 * why that is acceptable. Anything not listed here must match.
 *
 * One entry, and it is the resolver CORRECTING the table. `washington` used
 * to be here too, as the single input where the resolver was worse; it is
 * now a curated decision that reproduces the table's answer, so the gate is
 * 132 of 132 with no regression.
 *
 * To find what belongs here, run this suite: the failure names every
 * unaccounted key as `key: table XXX -> resolver YYY`. A row is only added
 * once somebody has decided the new lead is right.
 */
const ACCEPTED_LEAD_CHANGES: Record<string, { to: string; why: string; asks?: boolean }> = {
  'Vancouver, WA': {
    to: 'PDX',
    why:
      'The resolver CORRECTS the table here. Vancouver, Washington sits 7 km ' +
      'from Portland International; the table answers SEA, about 250 km away ' +
      'in Seattle, because its fallback reads the `WA` qualifier as "the ' +
      'Washington metro" rather than as the state the city is in. Accepted ' +
      'because PDX is right, and recorded rather than silently absorbed ' +
      'because it is a behaviour change a traveller would notice.',
  },
};

/**
 * Qualified input shapes, drawn from the table's own test suite.
 *
 * `MULTI_AIRPORT_CITY_KEYS` is only the table's KEYS, and the table answers
 * far more than its keys: `Newark, NJ` and `Vancouver, WA` are handled by its
 * comma-walking fallback, not by a key. Gating on the key list alone was
 * blind to that whole class, and it hid a real difference — `Vancouver, WA`,
 * where the resolver corrects the table rather than matching it.
 *
 * These are the comma and space forms from `originAirportAliases.test.ts`,
 * which is the closest thing to a record of what real input looks like.
 */
const QUALIFIED_INPUTS = [
  'Newark, NJ',
  'Jersey City, NJ',
  'Brooklyn, NY',
  'Hartford, CT',
  'Portland, Oregon',
  'Vancouver, WA',
  'Washington, DC',
  'Brooklyn, New York, USA',
  'New York State',
  'Washington State',
  'Oregon State',
];

type LeadDiff = { key: string; legacy: string; resolver: string };

function leadDiffs(): { empties: string[]; diffs: LeadDiff[]; compared: number } {
  const empties: string[] = [];
  const diffs: LeadDiff[] = [];
  let compared = 0;

  for (const key of [...MULTI_AIRPORT_CITY_KEYS, ...QUALIFIED_INPUTS]) {
    const legacy = getOriginAirports(key);
    if (legacy.length === 0) continue; // the table refuses it; nothing to compare
    const resolved = resolveOriginAirports(key);

    if (resolved.airports.length === 0) {
      empties.push(key);
      continue;
    }
    compared += 1;
    if (resolved.airports[0] !== legacy[0]) {
      diffs.push({ key, legacy: legacy[0], resolver: resolved.airports[0] });
    }
  }

  return { empties, diffs, compared };
}

describe('gate 1 — the resolver never answers nothing where the table answered', () => {
  it('has no empty answers at all', () => {
    const { empties, compared } = leadDiffs();
    // `Washington State` and `New York State` were here, and they are the
    // reason the resolver has an admin-suffix path.
    expect(empties).toEqual([]);
    // Non-vacuity: if the table stopped answering anything, `empties` would
    // be empty for the wrong reason and this suite would assert nothing.
    expect(compared).toBeGreaterThan(100);
  });
});

describe('gate 2 — the leading airport matches, or the change is accepted', () => {
  it('has no unaccounted lead change', () => {
    const { diffs } = leadDiffs();
    const unaccounted = diffs
      .filter((d) => ACCEPTED_LEAD_CHANGES[d.key]?.to !== d.resolver)
      .map((d) => `${d.key}: table ${d.legacy} -> resolver ${d.resolver}`);

    // If this fails, either fix the resolver or add a reviewed row to
    // ACCEPTED_LEAD_CHANGES. Do not add a row to make a red suite green
    // without deciding the new lead is correct — that is the one move this
    // file exists to prevent.
    expect(unaccounted).toEqual([]);
  });

  it('is really asking, wherever an acceptance claims it asks', () => {
    // Keeps the ledger honest: a row justified by "it asks instead of
    // guessing" is fiction the moment it stops asking. No row claims that
    // today — `washington` used to, and is now a curated decision that
    // matches the table — so this guards the next one.
    for (const [key, accepted] of Object.entries(ACCEPTED_LEAD_CHANGES)) {
      if (!accepted.asks) continue;
      const resolved = resolveOriginAirports(key);
      expect(resolved.needsClarification).toBeDefined();
      expect(resolved.needsClarification?.candidates.length).toBeGreaterThan(1);
    }
  });

  it('has no stale acceptance', () => {
    // An accepted change that no longer happens is a row nobody has to carry
    // any more, and leaving it hides the next real one.
    const { diffs } = leadDiffs();
    const live = new Set(diffs.map((d) => d.key));
    expect(Object.keys(ACCEPTED_LEAD_CHANGES).filter((key) => !live.has(key))).toEqual([]);
  });
});
