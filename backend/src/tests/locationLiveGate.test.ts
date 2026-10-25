/**
 * The resolver against every answer the retired hand-written table gave.
 *
 * This was the gate for flipping `LOCATION_RESOLVER_MODE` to `live`. That
 * flip is made and the table is deleted, so the suite's job has changed from
 * evidence to PERMANENT REGRESSION NET — and it is the only independent one
 * there is. Every other location suite checks the resolver against the same
 * artifact the resolver reads; these 146 inputs are decisions a human made
 * about which airports a traveller flies from, frozen in
 * `src/data/generated/retiredOriginAirports.json` the day the table went.
 *
 * Two assertions are hard requirements:
 *
 *  1. the resolver never returns NOTHING for an input the table answered. A
 *     regression here means someone who could name their origin yesterday
 *     cannot today. It caught `Washington State` and `New York State`.
 *  2. the leading airport matches on every input, unless the change is in the
 *     reviewed ledger below.
 *
 * That ledger is a list, not a threshold. Every differing input is named with
 * the reason it is acceptable, and it is committed so the diff shows movement
 * both ways: a new entry means the resolver started disagreeing somewhere new
 * and somebody has to look at it; a vanished entry means it stopped. "It
 * seems fine" is not a gate; this is. Adding a row to make a red suite green,
 * without deciding the new answer is right, is the one move this file exists
 * to prevent.
 *
 * `airports[0]` is the right thing to compare because it is the airport
 * `estimateHomeLegCost` ranks route permutations from, and it decides which
 * codes survive the `MAX_HOME_AIRPORTS` cap. Extra fallbacks after it are a
 * gain, not a difference — `buildHomeLeg` prices every survivor and takes the
 * cheapest.
 */

import { retiredAnswer, retiredInputs, RETIRED_ORIGIN_AIRPORTS } from '../data/retiredOriginAirports';
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
  'Washington, Utah': {
    to: 'SGU',
    why:
      'The resolver CORRECTS the table. Washington, Utah is 11 km from St ' +
      'George Regional; the table answered SLC, 427 km away in Salt Lake ' +
      'City, because it had no entry for the town and fell back to the ' +
      '`utah` qualifier, which gives the STATE\'s airport. Accepted because ' +
      'SGU is right. Found only once the gate was widened past the table\'s ' +
      'key list to the qualified shapes its comma walk also answered.',
  },
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

type LeadDiff = { key: string; legacy: string; resolver: string };

function leadDiffs(): { empties: string[]; diffs: LeadDiff[]; compared: number } {
  const empties: string[] = [];
  const diffs: LeadDiff[] = [];
  let compared = 0;

  for (const key of retiredInputs()) {
    const legacy = retiredAnswer(key);
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
    // Non-vacuity: if the snapshot were empty, `empties` would be empty for
    // the wrong reason and this suite would assert nothing at all.
    expect(compared).toBeGreaterThan(100);
    expect(RETIRED_ORIGIN_AIRPORTS.entries).toBeGreaterThan(140);
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
