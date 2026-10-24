/**
 * Upstream downloads for the location data pipeline.
 *
 * Licensing is settled and is NOT to be re-litigated here:
 *
 *   OurAirports  airports.csv            PUBLIC DOMAIN
 *   GeoNames     cities*, admin1, countryInfo   CC BY 4.0 — ATTRIBUTION REQUIRED
 *   US Census    state.txt (USPS codes)  US Government work, public domain
 *
 * The GeoNames licence version is pinned in their `readme.txt`, not on the web
 * page, so `readme.txt` is downloaded and its licence line asserted on every
 * build. If upstream changes the licence the build fails loudly instead of
 * shipping under the wrong terms.
 *
 * Deliberately NOT used, with the reasons kept so nobody re-adds them:
 *   - `country-state-city` (npm)  GPL-3.0. Disqualifying.
 *   - OpenFlights                 ODbL (share-alike) AND frozen since 2014.
 *   - Wikipedia airport lists     CC BY-SA.
 *   - any airport npm package     abandoned (2015-2017) or unverifiable.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export type Fetched = {
  /** Decoded file contents. */
  text: string;
  /** Upstream `Last-Modified`, ISO date (YYYY-MM-DD), or 'unknown'. */
  upstreamDate: string;
  bytes: number;
  sha256: string;
};

export const OURAIRPORTS_AIRPORTS_URL =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';
export const GEONAMES_DUMP_BASE = 'https://download.geonames.org/export/dump/';
/**
 * USPS two-letter state and territory abbreviations, from the Census Bureau's
 * `STUSAB` column. Used instead of a hand-typed list: 31 of the 56 codes are
 * also ISO 3166-1 country codes, and that collision set has to be derived.
 */
export const CENSUS_STATE_URL = 'https://www2.census.gov/geo/docs/reference/state.txt';

function lastModifiedToDate(headers: Headers): string {
  const raw = headers.get('last-modified');
  if (!raw) return 'unknown';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  return parsed.toISOString().slice(0, 10);
}

/**
 * Download a file, caching it under `cacheDir` so re-running the build while
 * iterating does not re-pull 30 MB. `--refresh` bypasses the cache.
 */
export async function fetchCached(
  url: string,
  cacheDir: string,
  opts: { refresh: boolean },
): Promise<{ buffer: Buffer; upstreamDate: string }> {
  mkdirSync(cacheDir, { recursive: true });
  const name = url.split('/').pop() || 'download';
  const file = join(cacheDir, name);
  const meta = join(cacheDir, `${name}.meta.json`);
  if (!opts.refresh && existsSync(file) && existsSync(meta)) {
    const cached = JSON.parse(readFileSync(meta, 'utf8')) as { upstreamDate: string };
    return { buffer: readFileSync(file), upstreamDate: cached.upstreamDate };
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const upstreamDate = lastModifiedToDate(response.headers);
  writeFileSync(file, buffer);
  writeFileSync(meta, JSON.stringify({ url, upstreamDate, bytes: buffer.length }, null, 2));
  return { buffer, upstreamDate };
}

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function fetchText(
  url: string,
  cacheDir: string,
  opts: { refresh: boolean },
): Promise<Fetched> {
  const { buffer, upstreamDate } = await fetchCached(url, cacheDir, opts);
  return {
    text: buffer.toString('utf8'),
    upstreamDate,
    bytes: buffer.length,
    sha256: digest(buffer),
  };
}

/**
 * Read the single data member out of a GeoNames zip.
 *
 * Hand-rolled rather than shelled out to `unzip`, which is not guaranteed to
 * exist on a CI image, and rather than taking a dependency for one call.
 * GeoNames zips contain one deflated or stored member plus `readme.txt`.
 */
export function unzipMember(buffer: Buffer, wantedName: string): Buffer {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file: no end-of-central-directory record');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < entryCount; entry++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('corrupt zip central directory');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === wantedName) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip member not found: ${wantedName}`);
}

export async function fetchGeoNamesZip(
  zipName: string,
  memberName: string,
  cacheDir: string,
  opts: { refresh: boolean },
): Promise<Fetched> {
  const { buffer, upstreamDate } = await fetchCached(
    `${GEONAMES_DUMP_BASE}${zipName}`,
    cacheDir,
    opts,
  );
  const member = unzipMember(buffer, memberName);
  return {
    text: member.toString('utf8'),
    upstreamDate,
    bytes: buffer.length,
    sha256: digest(buffer),
  };
}

/**
 * Fail the build if GeoNames has moved off CC BY 4.0, rather than silently
 * shipping data under terms the repo's attribution file no longer states.
 */
export function assertGeoNamesLicence(readme: string): string {
  const line = readme
    .split('\n')
    .find((l) => /creative commons/i.test(l) && /attribution/i.test(l));
  if (!line) {
    throw new Error(
      'GeoNames readme.txt no longer states a Creative Commons Attribution licence. ' +
        'Stop and re-check the terms before shipping this data.',
    );
  }
  if (!/4\.0/.test(line)) {
    throw new Error(`GeoNames licence line is no longer 4.0: ${line.trim()}`);
  }
  return line.trim();
}
