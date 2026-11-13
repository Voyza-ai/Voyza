/**
 * ROADMAP bug: origin lookup missed non-city inputs. "from New Jersey",
 * "Newark", "Long Island", "Connecticut" came back from the AI parse as the
 * literal string, the lookup found nothing, no home flight was searched and
 * day 1 had no transport. Covers the phrase layer and the lookup end to end.
 */
import * as fs from 'fs';
import * as path from 'path';
import { originQueries, stripOriginFiller } from '../services/location/originPhrase';
import { resolveOriginAirports } from '../services/location/originAirports';

const STATES: Array<[string, string]> = [
  ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'], ['California', 'CA'],
  ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'], ['Florida', 'FL'], ['Georgia', 'GA'],
  ['Hawaii', 'HI'], ['Idaho', 'ID'], ['Illinois', 'IL'], ['Indiana', 'IN'], ['Iowa', 'IA'],
  ['Kansas', 'KS'], ['Kentucky', 'KY'], ['Louisiana', 'LA'], ['Maine', 'ME'], ['Maryland', 'MD'],
  ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'], ['Mississippi', 'MS'], ['Missouri', 'MO'],
  ['Montana', 'MT'], ['Nebraska', 'NE'], ['Nevada', 'NV'], ['New Hampshire', 'NH'], ['New Jersey', 'NJ'],
  ['New Mexico', 'NM'], ['New York', 'NY'], ['North Carolina', 'NC'], ['North Dakota', 'ND'], ['Ohio', 'OH'],
  ['Oklahoma', 'OK'], ['Oregon', 'OR'], ['Pennsylvania', 'PA'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
  ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'], ['Vermont', 'VT'],
  ['Virginia', 'VA'], ['Washington', 'WA'], ['West Virginia', 'WV'], ['Wisconsin', 'WI'], ['Wyoming', 'WY'],
];

describe('stripOriginFiller', () => {
  it.each([
    ['from New Jersey', 'New Jersey'],
    ["I'm in Tokyo", 'Tokyo'],
    ['flying out of London', 'London'],
    ['I live in Connecticut.', 'Connecticut'],
    ['near Newark', 'Newark'],
    ['just outside of Boston', 'Boston'],
    ['Indiana', 'Indiana'],
    ['Newark', 'Newark'],
  ])('%s -> %s', (raw, want) => expect(stripOriginFiller(raw)).toBe(want));
});

describe('originQueries', () => {
  it('puts a region alias first and keeps the raw text as a fallback', () => {
    expect(originQueries('Northern Virginia')[0]).toBe('Washington DC');
    expect(originQueries('from North Jersey')[0]).toBe('Newark');
    expect(originQueries('Conn.')[0]).toBe('Connecticut');
  });

  it('never trims a name the resolver already knows', () => {
    expect(originQueries('Bay Area')[0]).toBe('Bay Area');
    expect(originQueries('Long Island')[0]).toBe('Long Island');
  });
});

describe('resolveOriginAirports on non-city inputs', () => {
  it.each([
    ['from New Jersey', 'EWR'],
    ['New Jersey', 'EWR'],
    ['NJ', 'EWR'],
    ['Newark', 'EWR'],
    ['Long Island', 'JFK'],
    ['Connecticut', 'BDL'],
    ['CT', 'BDL'],
    ['Northern Virginia', 'IAD'],
    ['NoVA', 'IAD'],
    ['the DMV', 'IAD'],
    ['Westchester', 'JFK'],
    ['Tri-State Area', 'JFK'],
    ['SoCal', 'LAX'],
    ['Orange County', 'SNA'],
    ['South Florida', 'MIA'],
    ['Upstate New York', 'ALB'],
    ['Greater Boston', 'BOS'],
    ['Chicagoland', 'ORD'],
    ['the Twin Cities', 'MSP'],
    ['Boston area', 'BOS'],
    ['I live in Connecticut', 'BDL'],
    ['Mass.', 'BOS'],
  ])('%s -> %s first', (raw, iata) => {
    expect(resolveOriginAirports(raw).airports[0]).toBe(iata);
  });

  it('a region alias does not raise a "which one?" question', () => {
    for (const q of ['SoCal', 'Northern Virginia', 'from New Jersey', 'Westchester']) {
      expect(resolveOriginAirports(q).needsClarification).toBeUndefined();
    }
  });

  it.each(STATES)('every US state resolves: %s / %s', (name, code) => {
    expect(resolveOriginAirports(name).airports.length).toBeGreaterThan(0);
    expect(resolveOriginAirports(code).airports.length).toBeGreaterThan(0);
    expect(resolveOriginAirports(`from ${name}`).airports.length).toBeGreaterThan(0);
  });
});

describe('originPhrase.ts is the same file in both packages', () => {
  it('is byte-for-byte identical', () => {
    const be = fs.readFileSync(path.resolve(__dirname, '../services/location/originPhrase.ts'), 'utf8');
    const fe = fs.readFileSync(path.resolve(__dirname, '../../../frontend/lib/originPhrase.ts'), 'utf8');
    expect(fe).toBe(be);
  });
});
