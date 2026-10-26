import { allPlaces } from '../data/locationArtifact';
import { resolveOriginAirports } from '../services/location/originAirports';

/**
 * A traveller's own airport has to survive into the priced fan-out.
 *
 * Only the first three codes reach `buildHomeLeg`, which prices every one and
 * takes the cheapest. An airport at position four is therefore never priced —
 * the traveller cannot be quoted from it however obvious a choice it is. The
 * artifact's sort is (servesPlace, type ordinal, distance), and the ordinal
 * term alone put a city's own field behind airports 60-90 km away: Worcester,
 * Massachusetts led with Boston while Worcester Regional sat 6 km out and
 * fourth.
 *
 * `promoteDoorstepAirport` in the pipeline lifts such an airport into the last
 * fan-out slot. It is narrow on purpose, and the second threshold is the one
 * that makes it safe rather than reckless — see the London case below.
 */

const CITY_FANOUT = 3;
const DOORSTEP_KM = 25;
const DISTANT_LEAD_KM = 60;

describe('a city keeps its own airport in the priced fan-out', () => {
  it('prices Worcester from Worcester Regional, not only Boston', () => {
    // The case this was built for. BOS stays the lead — it is the better
    // airport and the lead drives permutation ranking — but ORH is now priced
    // alongside it instead of being cut.
    const resolved = resolveOriginAirports('Worcester, Massachusetts', {});
    expect(resolved.airports[0]).toBe('BOS');
    expect(resolved.airports).toContain('ORH');
  });

  it.each([
    ['Stockton, California', 'SCK'],
    ['Newburgh, New York', 'SWF'],
    ['Heidelberg, Germany', 'MHG'],
  ])('keeps %s reachable from %s', (query, iata) => {
    expect(resolveOriginAirports(query, {}).airports).toContain(iata);
  });

  it('leaves London on Heathrow and does not force City Airport in', () => {
    // THE GUARD THAT MATTERS. LCY is 13 km from the centre against Heathrow's
    // 24, so a naive "nearest wins" rule would promote it — and `curated.ts`
    // exists precisely because measurement put LCY ahead of LHR and a human
    // decided otherwise. The lead-distance threshold is what keeps this rule
    // away from the hand-ordered metros: at 24 km Heathrow is not distant, so
    // London never qualifies. Inner-London boroughs inherit the same shape.
    const london = resolveOriginAirports('London', {});
    expect(london.airports[0]).toBe('LHR');
    expect(london.airports).not.toContain('LCY');

    const islington = resolveOriginAirports('Islington', {});
    expect(islington.airports[0]).toBe('LHR');
    expect(islington.airports).not.toContain('LCY');
  });

  it('holds across the whole artifact', () => {
    // No city may both have a doorstep airport and fail to price it.
    const stranded: string[] = [];
    let cities = 0;
    for (const place of allPlaces()) {
      if (place.kind !== 'city') continue;
      const airports = place.airports;
      if (airports.length < 2) continue;
      cities++;
      const lead = airports[0];
      if (lead.km < DISTANT_LEAD_KM) continue;

      let nearest = airports[0];
      for (const a of airports) if (a.servesPlace && a.km < nearest.km) nearest = a;
      if (nearest.km > DOORSTEP_KM) continue;

      const priced = airports.slice(0, CITY_FANOUT).some((a) => a.iata === nearest.iata);
      if (!priced && stranded.length < 10) {
        stranded.push(`${place.name}, ${place.country}: ${nearest.iata}@${nearest.km}km cut`);
      }
    }
    expect(stranded).toEqual([]);
    // Non-vacuous: the sweep has to have actually walked the artifact.
    expect(cities).toBeGreaterThan(20_000);
  });

  it('does not apply the rule to regions', () => {
    // A region's airports are ordered against its CENTROID, so "nearest"
    // means nearest to an arbitrary interior point rather than to a traveller.
    // Applying it there reordered 13 regions on a distance nobody stands at,
    // Saarland and Jiangsu among them, so the pipeline gates it to cities.
    const saarland = allPlaces().find((p) => p.id === 'adm:DE.09');
    expect(saarland).toBeDefined();
    // SCN is Saarbrücken's own airport and the nearest to the centroid; the
    // derived order puts the larger FRA ahead of it and must keep doing so.
    const codes = saarland!.airports.map((a) => a.iata);
    expect(codes.indexOf('FRA')).toBeLessThan(codes.indexOf('SCN'));
  });
});
