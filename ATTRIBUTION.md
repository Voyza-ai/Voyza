# Third-party data attribution

Voyza ships generated data derived from the sources below. Two of them carry
obligations. Read this before changing anything in `backend/src/data/generated/`
or `backend/scripts/location-data/`.

## GeoNames — attribution is REQUIRED

> This work is licensed under a Creative Commons Attribution 4.0 License,
> see <https://creativecommons.org/licenses/by/4.0/>

Source: <https://download.geonames.org/export/dump/> — `cities1000.zip`,
`cities15000.zip`, `cities5000.zip`, `admin1CodesASCII.txt`, `countryInfo.txt`.

CC BY 4.0 requires **credit, a licence link, and an indication of changes**.
The licence version is pinned in GeoNames' own `readme.txt`, not on their web
page, so `scripts/build-location-data.ts` downloads that file and **fails the
build** if the licence line stops saying Creative Commons Attribution 4.0.

### Required credit text

```
City, region and country data © GeoNames, licensed under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). Modified: filtered, joined to
airport data, and reduced.
```

### Where it has to appear in the app

**The trigger condition is now MET.** This section used to say the resolver
shipped dark and nothing imported the artifact. That changed: the frontend's
origin lookup falls through to the resolver wherever the hand-written table is
silent, which is 18 of the table's own 132 keys — `Paris, Texas`,
`Baton Rouge, LA`, `Berlin, DE` and the rest. Those answers are GeoNames-derived
and a user can see them today, in `HomeEditModal`'s suggested airports among
other places. The credit is owed now, not at some later phase.

The wording lives in exactly one place in the code,
`backend/src/data/attribution.ts`, and `locationAttribution.test.ts` compares
it to the block above word for word so the two cannot drift.

| Where | State |
|---|---|
| **Public API responses** (`POST /api/locations/resolve`) | **DONE.** Every response carries an `attribution` object — credit, licence, link and the modification note. |
| **The browser** | **DONE as far as code can take it.** The generator emits the same object into the hot set, and `frontend/lib/locationResolver.ts` re-exports it as `LOCATION_DATA_ATTRIBUTION`, so the UI renders the licence's own words with no second copy. |
| **App credits / about page** (`frontend/`) | **OUTSTANDING, and it is a design decision.** There is no credits surface in the app and adding one is a visible change, which this repo's rules say gets approved before it is committed. Importing the constant is not compliance; rendering it somewhere a user can reach is. |
| **Anywhere the resolver's output is rendered** — the origin picker, the airport list on a trip, the clarification UI | **OUTSTANDING.** Needs a link to that credits page once it exists, not the full notice inline. |

Checking this off is part of the phase that wires the resolver into the app, not
part of generating the data.

## OurAirports — public domain

Source: <https://davidmegginson.github.io/ourairports-data/airports.csv>

Released into the public domain. No attribution obligation. Credited anyway
because the data is good and the project is volunteer-run:

```
Airport data from OurAirports (https://ourairports.com/), public domain.
```

## US Census Bureau — public domain

Source: <https://www2.census.gov/geo/docs/reference/state.txt>

A work of the US federal government, so not subject to copyright in the US. Used
for the `STUSAB` column — the USPS two-letter state and territory abbreviations.

## Deliberately NOT used

Kept here so nobody re-adds one of them.

| Source | Why not |
|---|---|
| `country-state-city` (npm) | **GPL-3.0.** Disqualifying for this codebase. |
| OpenFlights | **ODbL** (share-alike) *and* frozen since June 2014. Fine to measure against, never to ship. |
| Wikipedia airport lists | **CC BY-SA** (share-alike). Wikidata is CC0 and would be fine. |
| `node-symspell` | **No licence field at all**, which means all rights reserved. |
| `airports`, `airport-codes`, `airport-data` (npm) | Abandoned 2015–2017 and missing airports that opened years ago. |

## Regenerating

```
cd backend && npm run build:location-data            # uses the download cache
cd backend && npm run build:location-data -- --refresh
```

The artifact records `generatedAt` and each upstream dataset's date, so a stale
build is visible in the diff.
