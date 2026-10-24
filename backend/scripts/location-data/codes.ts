/**
 * ISO 3166-1 and USPS code lists, DERIVED FROM SOURCE on every build.
 *
 * Why this is a generated artifact and not a constant: 31 of the 56 US state
 * and territory codes are also ISO 3166-1 alpha-2 country codes — CA
 * California/Canada, DE Delaware/Germany, IN Indiana/India, MA
 * Massachusetts/Morocco, LA three ways between Los Angeles, Louisiana and
 * Laos. The architecture document's own copy of that list was written from
 * memory, which is exactly how `Berlin, DE` ends up pricing from Philadelphia.
 * Derive it, assert it, and let the test fail when upstream moves.
 *
 * Sources:
 *   ISO 3166-1 alpha-2   GeoNames countryInfo.txt   (CC BY 4.0)
 *   US admin1 codes      GeoNames admin1CodesASCII.txt (CC BY 4.0)
 *   USPS abbreviations   US Census state.txt, STUSAB column (public domain)
 */

import { parseTsv } from './text';

export type CountryRow = {
  iso2: string;
  iso3: string;
  name: string;
  continent: string;
  geonameId: string;
};

export type Admin1Row = {
  /** "US.NY" */
  code: string;
  country: string;
  /** "NY" */
  admin1: string;
  name: string;
  asciiName: string;
  geonameId: string;
};

export type CodeLists = {
  /** Every ISO 3166-1 alpha-2 code GeoNames publishes, sorted. */
  iso3166Alpha2: string[];
  /**
   * The 56 USPS two-letter state and territory abbreviations.
   *
   * Census `state.txt` carries 57 rows; `UM` (U.S. Minor Outlying Islands) is
   * excluded because it is an ISO 3166-2:US subdivision with no USPS mailing
   * abbreviation. That subtraction is the one judgement call in this file and
   * it is asserted by a test on the count.
   */
  uspsStateCodes: string[];
  /** USPS codes that are ALSO ISO 3166-1 country codes. The dangerous set. */
  collidingCodes: string[];
  /** USPS codes with no country-code twin. */
  cleanStateCodes: string[];
};

/** Census `state.txt` rows that are subdivisions but not postal destinations. */
const NON_POSTAL_CENSUS_CODES = new Set(['UM']);

export function parseCountryInfo(text: string): CountryRow[] {
  const out: CountryRow[] = [];
  for (const f of parseTsv(text)) {
    if (f.length < 17) continue;
    const iso2 = f[0].trim();
    if (!/^[A-Z]{2}$/.test(iso2)) continue;
    out.push({
      iso2,
      iso3: f[1].trim(),
      name: f[4].trim(),
      continent: f[8].trim(),
      geonameId: f[16].trim(),
    });
  }
  return out;
}

export function parseAdmin1(text: string): Admin1Row[] {
  const out: Admin1Row[] = [];
  for (const f of parseTsv(text)) {
    if (f.length < 4) continue;
    const code = f[0].trim();
    const dot = code.indexOf('.');
    if (dot < 0) continue;
    out.push({
      code,
      country: code.slice(0, dot),
      admin1: code.slice(dot + 1),
      name: f[1].trim(),
      asciiName: f[2].trim(),
      geonameId: f[3].trim(),
    });
  }
  return out;
}

/** Census state.txt is `STATE|STUSAB|STATE_NAME|STATENS`. */
export function parseCensusStates(text: string): Array<{ usps: string; name: string }> {
  const out: Array<{ usps: string; name: string }> = [];
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].replace(/\r$/, '').split('|');
    if (f.length < 3) continue;
    const usps = f[1].trim();
    if (!/^[A-Z]{2}$/.test(usps)) continue;
    out.push({ usps, name: f[2].trim() });
  }
  return out;
}

export function deriveCodeLists(
  countries: CountryRow[],
  censusStates: Array<{ usps: string; name: string }>,
): CodeLists {
  const iso = new Set(countries.map((c) => c.iso2));
  const usps = censusStates
    .map((s) => s.usps)
    .filter((code) => !NON_POSTAL_CENSUS_CODES.has(code));
  const uspsSorted = [...new Set(usps)].sort();
  return {
    iso3166Alpha2: [...iso].sort(),
    uspsStateCodes: uspsSorted,
    collidingCodes: uspsSorted.filter((code) => iso.has(code)),
    cleanStateCodes: uspsSorted.filter((code) => !iso.has(code)),
  };
}
