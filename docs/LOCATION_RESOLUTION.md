# Location resolution architecture

Status: **proposed, pending review.** Nothing here is built yet.

Turning free text into airports, without ever silently guessing wrong.

---

## The problem

Every location the user gives us arrives as free text, from them or from an AI
parser: `New Jersey`, `Paris`, `Paris, France`, `Buffalo, NY`, `the bay area`,
`Paros`. Today a hand-written table of 68 keys handles a few of these and
silently returns nothing for the rest — and "nothing" means the home flight
search never runs and day 1 of the trip shows no transport, with no error.

Three failures, in order of how badly they hurt:

1. **Silently wrong.** `"New Jersey"` resolved to the junk IATA code `"NEW"`.
   The traveller gets priced from somewhere they never asked about.
2. **Silently empty.** `"Paris, France"` returns nothing. No flight, no
   explanation.
3. **Coarse.** `"Buffalo, NY"` matches the state and prices from New York City,
   400 miles from Buffalo's own airport.

## The principle everything follows from

**Three outcomes, never two.**

```
resolved   — we are confident. Here are the airports.
ambiguous  — we found several real places. Ask the traveller which.
unknown    — we found nothing. Ask, and offer near-misses.
```

A silent empty result and a confident wrong result are both bugs. The system is
allowed to not know; it is not allowed to pretend. Every path ends in one of
these three, and two of them are questions.

## `Paros` is not a typo

The brief suggested `"Paros"` should be corrected to `"Paris"`. It must not be.
**Paros is a real Greek island with its own airport (PAS)**, and a traveller
planning Santorini and Mykonos who types Paros means Paros.

This is the whole design in one example:

- Exact matches always beat fuzzy ones. `Paros` matches a real place, so no
  correction is considered.
- Context decides the rest. With Santorini already in the trip, Paros outranks
  Paris on geography alone.
- Fuzzy matching only runs when the exact pass found **nothing**, and even then
  it proposes rather than substitutes.

A system that "helpfully" corrects Paros to Paris is worse than one that asks.

---

## Data

Two generated artifacts, built from open data and checked in as a snapshot so a
build is reproducible and offline:

| Artifact | Holds |
|---|---|
| `airports.json` | IATA, name, city, country, admin region, lat/lon, scheduled-service flag |
| `places.json` | cities, metros, regions, states and countries, each with aliases, lat/lon, a prominence weight, and its airports |

```ts
type Place = {
  id: string;                 // stable across rebuilds, e.g. "geonames:2988507"
  name: string;               // display form: "Paris"
  kind: 'city' | 'metro' | 'region' | 'state' | 'country';
  country: string;            // ISO 3166-1 alpha-2
  admin: string | null;       // state / province code where it applies
  lat: number;
  lon: number;
  weight: number;             // prominence, normalised 0..1
  airports: string[];         // IATA, most relevant first
};
```

**Sources and licensing are being confirmed before anything is committed.** The
likely pair is OurAirports (public domain) for airports and GeoNames (CC-BY 4.0,
attribution required, commercial use permitted) for cities and population. Any
source that turns out to be non-commercial or share-alike is disqualified —
this ships in a product. If GeoNames attribution is required, it goes in the
repo and in the app's credits.

**Size is a budget, not an afterthought.** Only airports with scheduled
commercial service, and only places above a population floor, except where a
small place has an airport of its own. Target under 5 MB on disk. The artifact
never ships to the browser (see Serving).

## Indexes

Built once per process at startup, from the artifact.

| Index | Shape | For |
|---|---|---|
| `exact` | `Map<normalized, PlaceId[]>` | the common path, O(1) |
| `qualifier` | `Map<normalized, PlaceId>` | country/state names and codes after a comma |
| `fuzzy` | bucketed, see below | typos, only on an exact miss |

Normalisation: lowercase, strip diacritics (`sãopaulo` → `saopaulo`), collapse
punctuation and whitespace. Aliases (`nyc`, `bay area`, `the city`) are rows in
`exact`, not a special case.

**Fuzzy index choice is deferred to measurement.** Candidates are SymSpell-style
deletion indexing, a BK-tree, a trigram inverted index, or the cheapest option —
bucket by term length ±1 and run bounded Levenshtein within the bucket. Memory
is the deciding axis, and the numbers are being measured before the choice is
made. The cheap option is the default unless something beats it on evidence.

## Abbreviations are the hardest input, not the easiest

Two-letter codes look like the simple case and are the opposite. **31 of the 56
US state and territory codes are also ISO 3166-1 country codes:**

| Code | Reads as | or as |
|---|---|---|
| `CA` | California | **Canada** |
| `LA` | Los Angeles *or* Louisiana | **Laos** |
| `DE` | Delaware | **Germany** |
| `IN` | Indiana | **India** |
| `MA` | Massachusetts | **Morocco** |
| `ID` | Idaho | **Indonesia** |
| `IL` `CO` `AZ` `GA` `MD` `MN` `MS` `MT` `NE` `NC` `PA` `SC` `SD` `TN` `VA` `AL` `AR` `KY` `ME` `MO` | US states | Israel, Colombia, Azerbaijan, Gabon, Moldova, Mongolia, Montserrat, Malta, Niger, New Caledonia, Panama, Seychelles, Sudan, Tunisia, Vatican, Albania, Argentina, Cayman Is, Montenegro, Macao |
| `PR` `VI` `GU` `AS` `MP` | US territories | the same places as countries — harmless, same answer |

Only 25 are unambiguous: `AK CT DC FL HI IA KS MI ND NH NJ NM NV NY OH OK OR RI
TX UT VT WA WI WV WY`.

**This is where the old bugs lived.** `Berlin, DE` resolved to Philadelphia.
`Tel Aviv, IL` to Chicago. `Baton Rouge, LA` to Los Angeles — and `la` is a
*city* alias in the current table, so that one is a three-way collision between
a city, a state and a country.

### How the design handles it

No special-case list. Three existing mechanisms do the work:

1. **Position.** After a comma the qualifier reading dominates — `Austin, TX`
   is a state, `Berlin, DE` is a country. Standalone, both readings compete.
   This is why the qualifier index is separate from the place index.
2. **Prominence.** A bare `LA` almost certainly means Los Angeles: LAX is a
   top-five world airport, while Laos and Louisiana are rare trip origins. The
   score settles it without a question. The collision list is **not** 31 forced
   questions — it is 31 cases where the scoring has to earn its answer.
3. **Context.** A trip already holding Rome and Florence makes `CA` → Canada
   implausible on distance alone, and vice versa for a trip holding Vancouver.

What stays genuinely ambiguous — `CA` with no trip context and no comma — asks.
That is correct behaviour, not a gap.

### Non-negotiable test cases

These go in the must-never set, because each one shipped as a real bug or is
one keystroke from it:

```
Berlin, DE      -> Germany, never Delaware
Tel Aviv, IL    -> Israel, never Illinois
Casablanca, MA  -> Morocco, never Massachusetts
Baton Rouge, LA -> Louisiana, never Los Angeles and never Laos
Vancouver, WA   -> Washington state, never Vancouver BC
Bogota, CO      -> Colombia, never Colorado
```

The lists above were derived programmatically but from **memory of both code
sets**, so they must be regenerated from the authoritative ISO 3166 and USPS
sources during the data build and asserted by a test. Do not hand-maintain them.

## Resolution

```ts
resolve(input: string, ctx: Context): Resolution

type Context = {
  tripDestinations?: Place[];   // cities already in this trip
  userCountry?: string;
  userLatLon?: { lat: number; lon: number };
};
```

1. **Normalise.**
2. **Split on commas.** `"Buffalo, NY, USA"` → `["buffalo", "ny", "usa"]`.
3. **Qualifier pass, right to left.** Resolve trailing segments against
   `qualifier` only. A city key can never act as a qualifier — that is what
   stops `Paris, Texas` resolving to CDG, and `Berlin, DE` to Delaware.
4. **Exact lookup** of the head segment, narrowed by any qualifier found.
5. **Fuzzy pass only if step 4 found nothing**, within the same narrowing.
6. **Score** the surviving candidates.
7. **Decide** — `resolved`, `ambiguous`, or `unknown`.

### Scoring

Deterministic, explainable, no model call:

```
score = w_prominence · prominence
      + w_context    · contextProximity
      + w_qualifier  · qualifierMatch
      + w_exactness  · exactness
```

- **prominence** — population or passenger volume, log-scaled. Paris FR ≫ Paris TX.
- **contextProximity** — distance from the centroid of cities already in the
  trip. This is the "they are planning Europe, not Australia" signal, and it is
  pure geometry. A trip containing Rome and Florence resolves a bare `Paris` to
  France without anyone asking.
- **qualifierMatch** — an explicit `, France` is near-decisive.
- **exactness** — an exact hit outranks a fuzzy one, penalised by edit distance.

### The margin is the safety knob

A candidate is only `resolved` when it beats the runner-up by at least
`AMBIGUITY_MARGIN`. Below that, we ask.

**It starts deliberately high** — ask more, guess less — and only comes down
against a measured golden set. Tuning it down is a decision with evidence
attached, not a default.

## Serving: one source of truth

The resolver lives in the **backend only**, behind `POST /api/locations/resolve`.
The frontend calls it and keeps nothing but a thin client and the types.

This is deliberate and solves two problems at once:

- The duplicated `originAirports.ts` disappears. Today the same table exists in
  both packages and is kept honest by a drift test; the right fix is for it to
  exist once.
- A multi-megabyte dataset never reaches the browser bundle.

A shared package was considered and rejected: there is no root `package.json`,
the backend's `rootDir: ./src` breaks on cross-package imports, and Next's
bundler does not reach outside `frontend/`. Making the resolver a service is
less work and a better boundary than restructuring the build.

## Asking the traveller

`ambiguous` returns candidates with human distinguishers, not raw rows:

```
Paris, Île-de-France, France        CDG, ORY
Paris, Texas, United States         DFW — 2 hr drive
```

`unknown` returns near-misses the same way: *did you mean Paris, or Paros?*

The picker is a small frontend addition. Its **visual treatment needs design
approval** per CLAUDE.md before it ships; the data contract above does not.

## Caching

- Artifact parsed once per process.
- Resolutions cached by normalised input plus a context hash, LRU bounded.
  Context is part of the key because the same string resolves differently in
  different trips — that is the point of the context signal, and a cache that
  ignored it would quietly defeat it.

## Budgets, asserted by tests rather than hoped for

| | Target |
|---|---|
| Exact hit | < 0.1 ms |
| Fuzzy path | < 5 ms |
| Index memory | < 50 MB |
| Artifact on disk | < 5 MB |
| AI calls | **zero** on every path above |

An AI fallback is explicitly **out of scope for v1**. The set of airports,
cities, states and countries is finite and changes slowly; a table is faster,
cheaper, reproducible and testable. If a residual class of input genuinely
cannot be handled by data, that is a finding to bring back with examples — not
an assumption to design around now.

## Testing

- **Golden set** of real inputs with expected outcomes, including every example
  from this document.
- **Must-ask set** — inputs that must return `ambiguous` and never resolve.
  `Paris` with no context belongs here.
- **Must-never set** — an explicit qualifier must never resolve to a different
  continent. This is the property that would have caught `Berlin, DE` → PHL.
- **Negative controls** — tests must fail against the current implementation,
  so we know they test something. This has caught vacuous tests here before.
- **Performance** assertions against the budgets above.

## Phases

| Phase | Deliverable | Gate |
|---|---|---|
| 1 | Data pipeline, artifact, resolver core, tests | backend only, nothing wired up |
| 2 | `/api/locations/resolve`, frontend switched to it | old table still present |
| 3 | Clarification UI | design approval |
| 4 | Delete both copies of `originAirports.ts` | all callers migrated |

Each phase lands on `feat/location-resolver` and merges to `dev` only on
Satwik's approval.

## Open questions for review

1. **Where does asking happen in the planning flow?** Mid-conversation in
   PlanningChat, or deferred to the results page? Affects how disruptive the
   question feels.
2. **Do we have the user's location at all?** The brief assumes we might.
   `userCountry` is in the Context type but nothing populates it yet.
3. **How coarse is too coarse?** `Buffalo, NY` resolving to BUF is clearly
   right. Is a bare `NY` → New York City right, or should that also ask?
