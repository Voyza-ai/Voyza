/**
 * The OurAirports `name` column, shortened to what a card can show.
 *
 * ── Why this is in src/ and not in scripts/location-data/ ───────────────────
 *
 * It is a build-time rule and it would sit naturally beside the generator.
 * It cannot: backend's tsconfig pins `rootDir: ./src`, so anything under
 * src/ that imports from scripts/ fails `tsc --noEmit` with TS6059 — and the
 * rule needs a test, which lives in src/tests/. The generator imports INTO
 * src/ freely (it already takes `types.ts` from here), so this direction is
 * the one that compiles. Same constraint that forced the hot set's keys.ts
 * copy; see `locationKeysParity.test.ts`.
 *
 * ── Why shorten at all, and why THIS shortening ─────────────────────────────
 *
 * Measured on the places that render one, the name sits under the city in a
 * 200 px card at 12 px: `CanvasHomeCard`, `Flowchart`'s `HomeCard`, and a
 * tooltip in `HomeEditModal`. All three render ONE string and none renders a
 * formal name, and `getAirportFullName` had no callers at all, so only one
 * form is derived: keeping the old table's short/full pair measured +16.1 KiB
 * gzipped for a field nothing reads.
 *
 * Three rules, each about the SHAPE of the column rather than about any
 * particular airport, because a per-airport exception is the hand-maintained
 * table this replaces:
 *
 *  1. Take the part before " / ". OurAirports joins co-located facilities
 *     with it — "Minneapolis-Saint Paul International Airport /
 *     Wold-Chamberlain Field", "Anshan Teng'ao Airport / Anshan Air Base".
 *     The first is the civil name a passenger flies under.
 *  2. Drop trailing decoration UNTIL THERE IS NONE LEFT, where decoration is
 *     a parenthetical or a generic facility noun — Airport, Airfield,
 *     Airstrip, Aerodrome, Airpark, Air Base, Air Station. Every row ends in
 *     one of those nouns (3,817 of 4,008 end in the literal word "Airport")
 *     and it carries no information: the card is already a flight card. The
 *     parenthetical cleanup is the one `syntheticName` already does to
 *     `municipality`.
 *
 *     The loop is not tidiness. The column puts the two in both orders —
 *     "Antwerp International Airport (Deurne)" and "Marka International
 *     (Amman Civil) Airport" — so a single pass in either order leaves the
 *     other kind behind on 23 rows, and the function stops being idempotent:
 *     re-deriving an already-derived name would shorten it again. Running to
 *     a fixed point makes `derive(derive(x)) === derive(x)` true by
 *     construction, which `airportNames.test.ts` asserts over all 4,008.
 *
 *     Note "Field" is deliberately NOT decoration: it is load-bearing in
 *     "Dallas Love Field" and "Sardy Field".
 *  3. Abbreviate "International" to "Intl." — and only abbreviate it, never
 *     drop it. Dropping the whole "International Airport" tail reads well for
 *     JFK but turns PDX into a bare "Portland", LAX into "Los Angeles" and
 *     DXB into "Dubai", directly under a card that already says the city.
 *     Keeping "Intl." is also what the hand-written table did, and it
 *     reproduces that table's own string for PDX, LAX, SFO, EWR, DEN, MIA,
 *     SLC, PHL and the rest of its "<City> Intl." entries exactly.
 *
 * The one thing deliberately NOT done is a length cap. After the rules above
 * the median name is 13 characters and the 90th percentile 26, but 56 of
 * 4,008 still exceed 40 — "Rio Grande do Norte/Sao Goncalo do
 * Amarante-Governador Aluizio Alves Intl." is 74. Truncating mid-word in the
 * data would be a guess about one layout baked into every consumer; the
 * string is honest and clamping it is the renderer's business.
 */
const TRAILING_PARENTHETICAL = /\s*\([^()]*\)\s*$/;
const TRAILING_FACILITY_NOUN =
  /[\s,-]*\b(Airport|Airfield|Airstrip|Aerodrome|Airpark|Airbase|Air\s+Base|Air\s+Station)\b\s*$/i;

export function deriveAirportDisplayName(ourAirportsName: string): string {
  const raw = ourAirportsName.trim();
  let out = raw.split(' / ')[0].trim();

  // Rule 2, to a fixed point. Bounded by construction: each pass that changes
  // anything removes characters, so it cannot run longer than the string.
  for (;;) {
    const trimmed = out.replace(TRAILING_PARENTHETICAL, '').replace(TRAILING_FACILITY_NOUN, '').trim();
    if (trimmed === out) break;
    out = trimmed;
  }

  out = out.replace(/\bInternational\b/g, 'Intl.').replace(/\bIntl\b(?!\.)/g, 'Intl.');
  out = out.replace(/\s{2,}/g, ' ').replace(/^[\s,\-\u2013/]+|[\s,\-\u2013/]+$/g, '');
  // A rule that empties a name has not shortened it, it has lost it. Falling
  // back to the raw column keeps the guarantee this whole file rests on:
  // every scheduled-IATA airport has a non-empty name.
  return out || raw;
}
