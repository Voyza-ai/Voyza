/**
 * Turning what a traveller says about where they live into a place the
 * origin lookup can find.
 *
 * ── THIS FILE IS COPIED, BYTE FOR BYTE ──────────────────────────────────────
 *
 * An identical copy lives at `frontend/lib/originPhrase.ts`, and
 * `originPhraseParity.test.ts` in both packages fails on any difference —
 * the same arrangement, for the same reasons, as `keys.ts`. No imports.
 *
 * ROADMAP: "from New Jersey" / "Long Island" / "Northern Virginia" came back
 * from the AI parse as the literal string, the origin lookup missed, no home
 * flight was searched and day 1 had no transport. The resolver already knows
 * every US state by name and postal code and a few curated regions
 * (Long Island, the Bay Area); what it cannot know is phrasing ("from …",
 * "the … area", "greater …") and the informal regions people say instead of a
 * city. Both are handled here, before the lookup:
 *
 *   1. Filler around the place is stripped: "from New Jersey" -> "New Jersey".
 *   2. An informal region maps to the metro whose airports serve it:
 *      "Northern Virginia" -> "Washington DC", "SoCal" -> "Los Angeles".
 *   3. Old-style state abbreviations map to the state: "Conn." -> "Connecticut".
 *
 * Anything else comes back as it went in (trimmed), so this can only add
 * answers, never change one the resolver already gives.
 */

/** Lowercase, no dots or apostrophes, single spaces. */
function fold(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.'’‘`]/g, '')
    .replace(/[-–—_/\\,;:()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Informal regions -> the place whose airports a traveller there flies from.
 * Keys are folded. Every target resolves on the server; the ones the browser
 * hot set also carries are preferred so the answer comes back offline.
 */
const REGIONS: Record<string, string> = {
  // New York / New Jersey / Connecticut
  'north jersey': 'Newark',
  'northern jersey': 'Newark',
  'northern new jersey': 'Newark',
  'north new jersey': 'Newark',
  'central jersey': 'Newark',
  'central new jersey': 'Newark',
  'jersey shore': 'Newark',
  'south jersey': 'Philadelphia',
  'southern jersey': 'Philadelphia',
  'southern new jersey': 'Philadelphia',
  'south new jersey': 'Philadelphia',
  jersey: 'New Jersey',
  'tri state': 'New York',
  'tri state area': 'New York',
  tristate: 'New York',
  'tristate area': 'New York',
  nyc: 'New York',
  'new york metro': 'New York',
  westchester: 'New York',
  'westchester county': 'New York',
  'rockland county': 'New York',
  'hudson valley': 'New York',
  'the hamptons': 'Long Island',
  hamptons: 'Long Island',
  'nassau county': 'Long Island',
  'suffolk county': 'Long Island',
  'fairfield county': 'New York',
  'upstate new york': 'Albany, New York',
  'upstate ny': 'Albany, New York',
  upstate: 'Albany, New York',
  'western new york': 'Buffalo, New York',
  // Mid-Atlantic
  'northern virginia': 'Washington DC',
  'north virginia': 'Washington DC',
  nova: 'Washington DC',
  dmv: 'Washington DC',
  'dc area': 'Washington DC',
  'dc metro': 'Washington DC',
  'the dmv': 'Washington DC',
  'national capital region': 'Washington DC',
  'lehigh valley': 'Philadelphia',
  'delaware valley': 'Philadelphia',
  // New England
  'greater boston': 'Boston',
  'western mass': 'Hartford',
  'western massachusetts': 'Hartford',
  // California and the West
  'southern california': 'Los Angeles, California',
  socal: 'Los Angeles, California',
  'so cal': 'Los Angeles, California',
  'orange county': 'Santa Ana, California',
  'inland empire': 'Ontario, California',
  'northern california': 'San Francisco, California',
  norcal: 'San Francisco, California',
  'nor cal': 'San Francisco, California',
  'east bay': 'San Francisco, California',
  'south bay': 'San Francisco, California',
  'san fernando valley': 'Los Angeles, California',
  'puget sound': 'Seattle',
  'pacific northwest': 'Seattle',
  pnw: 'Seattle',
  'front range': 'Denver',
  'the front range': 'Denver',
  'phoenix metro': 'Phoenix',
  'the valley of the sun': 'Phoenix',
  'valley of the sun': 'Phoenix',
  // South
  'south florida': 'Miami',
  'central florida': 'Orlando, Florida',
  'north florida': 'Jacksonville, Florida',
  'tampa bay': 'Tampa, Florida',
  'the triangle': 'Raleigh, North Carolina',
  'research triangle': 'Raleigh, North Carolina',
  'triangle area': 'Raleigh, North Carolina',
  'north texas': 'Dallas',
  dfw: 'Dallas',
  'dallas fort worth': 'Dallas',
  'dallas ft worth': 'Dallas',
  metroplex: 'Dallas',
  'the metroplex': 'Dallas',
  'south texas': 'San Antonio, Texas',
  'gulf coast': 'Houston',
  atl: 'Atlanta',
  // Midwest
  chicagoland: 'Chicago',
  'twin cities': 'Minneapolis',
  'the twin cities': 'Minneapolis',
  'metro detroit': 'Detroit',
  'quad cities': 'Moline, Illinois',
};

/** Pre-postal abbreviations people still write. Postal codes ("NJ") the resolver already knows. */
const STATE_ABBREVIATIONS: Record<string, string> = {
  ala: 'Alabama',
  ariz: 'Arizona',
  ark: 'Arkansas',
  calif: 'California',
  cali: 'California',
  colo: 'Colorado',
  conn: 'Connecticut',
  del: 'Delaware',
  fla: 'Florida',
  ill: 'Illinois',
  ind: 'Indiana',
  kan: 'Kansas',
  kans: 'Kansas',
  mass: 'Massachusetts',
  mich: 'Michigan',
  minn: 'Minnesota',
  miss: 'Mississippi',
  mont: 'Montana',
  neb: 'Nebraska',
  nebr: 'Nebraska',
  nev: 'Nevada',
  okla: 'Oklahoma',
  ore: 'Oregon',
  penn: 'Pennsylvania',
  penna: 'Pennsylvania',
  tenn: 'Tennessee',
  tex: 'Texas',
  wash: 'WA',
  wis: 'Wisconsin',
  wisc: 'Wisconsin',
  wyo: 'Wyoming',
  'n j': 'New Jersey',
  'n y': 'New York',
};

/** Words in front of the place: "from", "I live in", "flying out of", "near". */
const LEADING =
  /^(?:(?:i\s+am|im|i'm|we\s+are|were|we're|i\s+live|we\s+live|i\s+m|living|based|currently|flying|leaving|departing|travell?ing|coming|starting|heading\s+out)\s+)*(?:from|in|out\s+of|outside(?:\s+of)?|near|around|close\s+to|just\s+outside(?:\s+of)?|the\s+suburbs\s+of|suburbs\s+of)\s+/i;

/** Words after the place: "… area", "… metro area", "… region", "… suburbs". */
const TRAILING = /\s+(?:metro(?:politan)?\s+area|metro|area|region|suburbs|vicinity|and\s+surrounding\s+areas?)$/i;

/** "Greater Boston" -> "Boston", "the Bay Area" stays (the resolver has it). */
const GREATER = /^(?:greater|metro|metropolitan)\s+/i;

/**
 * The phrase with the filler words taken off, case preserved. For cleaning
 * the AI parse's `origin` before it is shown or stored: "from New Jersey"
 * reads as "New Jersey".
 */
export function stripOriginFiller(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  for (let i = 0; i < 3; i++) {
    const next = s.replace(LEADING, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * The strings to try in the origin lookup, best first, deduped. A caller
 * takes the first one that resolves to airports.
 *
 *   - An informal region or old-style abbreviation wins outright, ahead of
 *     the raw text: "Westchester" alone resolves to Westchester, FLORIDA (the
 *     more populous one), which is not what a New Yorker means.
 *   - Otherwise the text as given comes first, so anything the resolver
 *     already answers is answered exactly as before — "Bay Area" is never
 *     cut down to "Bay".
 *   - Then the text without its leading filler ("from New Jersey"), then
 *     without a trailing "area" / "metro" and a leading "greater".
 */
export function originQueries(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const original = String(raw).replace(/\s+/g, ' ').trim();
  if (!original) return [];
  const stripped = stripOriginFiller(original);
  const noThe = stripped.replace(/^the\s+/i, '');
  const noTrail = noThe.replace(TRAILING, '');
  const noGreater = noTrail.replace(GREATER, '');

  const out: string[] = [];
  const add = (q: string | null | undefined) => {
    const t = (q ?? '').trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const variant of [original, stripped, noThe, noTrail, noGreater]) {
    const k = fold(variant);
    const hit = REGIONS[k] ?? STATE_ABBREVIATIONS[k];
    if (hit) {
      add(hit);
      break;
    }
  }
  add(original);
  add(stripped);
  add(noThe);
  add(noTrail);
  add(noGreater);
  return out;
}
