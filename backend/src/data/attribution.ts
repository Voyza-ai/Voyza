/**
 * Attribution for the generated location data. THE single source of this text.
 *
 * GeoNames is CC BY 4.0, which requires credit, a licence link, and an
 * indication of changes. All three are obligations, not courtesies, and the
 * licence version is checked at build time — `build-location-data.ts` fails
 * the build if GeoNames' own `readme.txt` stops saying Creative Commons
 * Attribution 4.0.
 *
 * It lives here, in `src/data/`, rather than in the build scripts because two
 * things need the same words and must not paraphrase them independently:
 *
 *   - `routes/locations.ts` returns it on every resolve response
 *   - `build-location-hotset.ts` emits it into the browser hot set, which is
 *     how the frontend gets it without a second copy to keep in step
 *
 * The full story, including where it still has to appear in the UI, is in
 * ATTRIBUTION.md at the repository root. Read that before changing anything
 * here: the wording is a licence term, not a label.
 */

export type DataAttribution = {
  /** Human-readable credit. Render this verbatim; do not paraphrase. */
  text: string;
  /** The licence, so a reader can check the terms. */
  license: string;
  url: string;
  /** CC BY 4.0 requires that modifications be indicated. */
  modified: string;
};

export const LOCATION_DATA_ATTRIBUTION: DataAttribution = {
  text: 'City, region and country data © GeoNames',
  license: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  modified: 'Filtered, joined to airport data, and reduced.',
};

/**
 * One line, for a surface with no room for the structured form.
 *
 * Matches the "Required credit text" block in ATTRIBUTION.md; the test
 * `locationAttribution.test.ts` compares the two so the document and the code
 * cannot drift apart.
 */
export function attributionLine(): string {
  const { text, license, url, modified } = LOCATION_DATA_ATTRIBUTION;
  return `${text}, licensed under ${license} (${url}). Modified: ${modified.toLowerCase().replace(/\.$/, '')}.`;
}
