/**
 * ROADMAP bug: origin lookup missed non-city inputs ("from New Jersey",
 * "Long Island", "Northern Virginia"), so `originAirports` went out empty.
 * The browser's offline lookup now answers them; the phrase file is shared
 * byte for byte with the backend.
 */
import * as fs from 'fs';
import * as path from 'path';
import { originAirportsForCity } from '@/lib/locationResolver';
import { stripOriginFiller } from '@/lib/originPhrase';

it.each([
  ['from New Jersey', 'EWR'],
  ['New Jersey', 'EWR'],
  ['NJ', 'EWR'],
  ['Newark', 'EWR'],
  ['Long Island', 'JFK'],
  ['Connecticut', 'BDL'],
  ['CT', 'BDL'],
  ['Northern Virginia', 'IAD'],
  ['the DMV', 'IAD'],
  ['Westchester', 'JFK'],
  ['Tri-State Area', 'JFK'],
  ['SoCal', 'LAX'],
  ['South Florida', 'MIA'],
  ['north jersey', 'EWR'],
  ['Chicagoland', 'ORD'],
  ['Boston area', 'BOS'],
  ['Conn.', 'BDL'],
])('%s -> %s first, offline', (raw, iata) => {
  expect(originAirportsForCity(raw)[0]).toBe(iata);
});

it('shows the place, not the phrase', () => {
  expect(stripOriginFiller('from New Jersey')).toBe('New Jersey');
});

it('originPhrase.ts is the same file in both packages', () => {
  const fe = fs.readFileSync(path.resolve(__dirname, '../../lib/originPhrase.ts'), 'utf8');
  const be = fs.readFileSync(path.resolve(__dirname, '../../../backend/src/services/location/originPhrase.ts'), 'utf8');
  expect(fe).toBe(be);
});
