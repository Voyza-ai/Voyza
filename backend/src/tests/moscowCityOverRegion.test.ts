import { resolveOriginAirports } from '../services/location/originAirports';
import { retiredAnswer } from '../data/retiredOriginAirports';

/**
 * When a city and the area around it print the SAME label, the city wins.
 *
 * `Moscow` is the case that found this. The artifact holds two rows that both
 * render "Moscow, Russia": the federal-city REGION (adm:RU.48, population
 * 11,100,779) and the CITY (gn:524901, 10,381,222). Population alone put the
 * region first, and a region carries no metro code and orders its airports
 * against a centroid rather than a centre — so the origin answer was SVO with
 * Vnukovo and Zhukovsky behind it, while Domodedovo, Russia's second airport,
 * was pushed out of the three-airport fan-out entirely.
 *
 * WHY THIS AND NOT A CURATED ALIAS. An alias `moscow -> Moscow, RU` would
 * also answer correctly, and would break Moscow, Idaho: coordinates there
 * resolve to PUW 9 km away today, and an alias would hand them Sheremetyevo.
 * That is the exact rescue `servesPlace` was added to the pipeline for. A
 * label-collision rule cannot reach Idaho, because Idaho's label is
 * "Moscow, Idaho, United States" — a different string, so no collision.
 */

describe('a city beats the region that shares its label', () => {
  it('answers Moscow with the triple the retired table gave', () => {
    const resolved = resolveOriginAirports('Moscow', {});
    expect(resolved.airports).toEqual(['SVO', 'DME', 'VKO']);
    // The retired hand-written table is the independent check here: this is
    // not a number chosen to match the code, it is the answer that shipped.
    expect(resolved.airports).toEqual(retiredAnswer('moscow'));
  });

  it('puts Domodedovo in the fan-out, where it was being cut', () => {
    // The regression this exists for. DME is Russia's second airport; the
    // region's order buried it behind Zhukovsky and the cap dropped it.
    const resolved = resolveOriginAirports('Moscow', {});
    expect(resolved.airports).toContain('DME');
    expect(resolved.airports).not.toContain('ZIA');
  });

  it('leaves Moscow, Idaho alone — the case an alias would have broken', () => {
    // THE GUARD. If someone later "simplifies" this into a curated alias,
    // this fails. Pullman-Moscow is 9 km away and must keep winning.
    const idaho = resolveOriginAirports('Moscow, Idaho', {});
    expect(idaho.airports[0]).toBe('PUW');
    expect(idaho.airports).not.toContain('SVO');
  });

  it('still asks about Moscow when nothing says which one', () => {
    // The rule must not collapse a real question. Russia and Idaho have
    // different labels, so both survive and the traveller is still asked.
    const resolved = resolveOriginAirports('Moscow', {});
    expect(resolved.needsClarification).toBeDefined();
    const labels = resolved.needsClarification!.candidates.map((c) => c.label);
    expect(labels.some((l) => /Russia/.test(l))).toBe(true);
    expect(labels.some((l) => /Idaho/.test(l))).toBe(true);
  });

  it('prefers a city over a region generally, not just for Moscow', () => {
    // San Juan, Argentina has the same shape: the province outranks the city
    // on population, and the province's order led with Mendoza 145 km away
    // over the city's own airport at 10 km. Same rule, same fix.
    const resolved = resolveOriginAirports('San Juan', {});
    expect(resolved.airports[0]).toBe('UAQ');
  });

  it('does not disturb a label that collides between two cities', () => {
    // Two cities sharing a label keep the first, which is the more prominent
    // row — the rule only lets a point-like place displace an area-like one.
    const portland = resolveOriginAirports('Portland', {});
    expect(portland.airports[0]).toBe('PDX');
  });
});
