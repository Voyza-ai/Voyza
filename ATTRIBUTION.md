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

### Where it still has to appear in the app — NOT YET DONE

Phase 1 of the location resolver ships dark: the artifact is generated and
checked in, and nothing in the running app imports it yet. The moment any user
can see a place name that came from GeoNames, the credit above has to be
reachable from the UI. The places it belongs, in the order they will be needed:

| Where | Why |
|---|---|
| **App credits / about page** (`frontend/`) | The canonical home for the notice. There is no credits surface today; one has to be added. |
| **Anywhere the resolver's output is rendered** — the origin picker, the airport list on a trip, the clarification UI | Needs a link to the credits page, not the full notice. |
| **Public API responses** that return resolved places (`POST /api/locations/resolve`) | An `attribution` field, or a documented link, if the endpoint is ever consumed by anything other than our own frontend. |

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
