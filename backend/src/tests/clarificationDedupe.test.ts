import { resolveOriginAirports } from '../services/location/originAirports';

/**
 * A clarification offers one card per READING. Two cards printing the same
 * string are the same choice to a traveller, so offering both is asking a
 * question with two identical answers.
 *
 * The case that found this: `San Juan` returned eight candidates, of which
 * four were doubles — "San Juan, Argentina" and "San Juan, Puerto Rico" each
 * appeared twice, because the GeoNames dump carries those cities as two rows.
 * Measured across the artifact, 110 city groups share a name+country+admin and
 * 114 rows are redundant; the unambiguous ones match down to the population
 * (San Juan, PR is 418,140 on both rows).
 *
 * This is the UI's own correctness, not a data nicety: the results page
 * renders one button per candidate, so the duplicates were two identical
 * buttons pointing at different place ids.
 */

describe('clarification candidates are one per reading', () => {
  it('offers each label once for San Juan', () => {
    const resolved = resolveOriginAirports('San Juan', {});
    const clarification = resolved.needsClarification;

    // Guard: if San Juan ever stops being ambiguous this test would pass
    // vacuously, so assert the case still exists before asserting about it.
    expect(clarification).toBeDefined();
    expect(clarification!.candidates.length).toBeGreaterThan(1);

    const labels = clarification!.candidates.map((candidate) => candidate.label);
    expect(labels).toEqual([...new Set(labels)]);
    // The specific doubles this was written for.
    expect(labels.filter((l) => /Puerto Rico/.test(l))).toHaveLength(1);
    expect(labels.filter((l) => /Argentina/.test(l))).toHaveLength(1);
  });

  it('keeps the better-attached row when it collapses a double', () => {
    // The survivor must be the FIRST, which is the more prominent row — and
    // for San Juan, PR the leading row carries more airports than the other.
    // A dedupe that kept the last would quietly cost airports here.
    const resolved = resolveOriginAirports('San Juan', {});
    const pr = resolved.needsClarification!.candidates.find((c) =>
      /Puerto Rico/.test(c.label),
    );
    expect(pr).toBeDefined();
    expect(pr!.airports[0]).toBe('SJU');
    expect(pr!.airports.length).toBeGreaterThan(1);
  });

  it('leaves genuinely distinct readings alone', () => {
    // Negative control. If the dedupe were collapsing on something coarser
    // than the printed label — country, say — Portland would lose Maine or
    // Texas, and the whole feature with it.
    const resolved = resolveOriginAirports('Portland', {});
    const labels = resolved.needsClarification!.candidates.map((c) => c.label);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels).toEqual([...new Set(labels)]);
    expect(labels.some((l) => /Oregon/.test(l))).toBe(true);
    expect(labels.some((l) => /Maine/.test(l))).toBe(true);
  });

  it('still answers a qualified San Juan with Puerto Rico', () => {
    // Unaffected by the dedupe, and the thing a traveller can do about it
    // today: naming the territory resolves cleanly.
    expect(resolveOriginAirports('San Juan, Puerto Rico', {}).airports[0]).toBe('SJU');
    expect(resolveOriginAirports('San Juan, PR', {}).airports[0]).toBe('SJU');
  });
});
