/**
 * `POST /api/locations/resolve` — the long tail of location resolution.
 *
 * The browser carries a hot set for the common cases and answers those
 * synchronously; this is where everything else goes. It is a pure in-memory
 * lookup: no database, no paid API, no AI, and no network call of any kind.
 *
 * POST rather than GET, deliberately, even though a typeahead is the obvious
 * caller and a GET would be cacheable: the context that makes this resolver
 * better than a table includes the traveller's coordinates, and coordinates in
 * a query string end up in access logs and proxy logs. A body keeps them out.
 *
 * The response is a TRIMMED shape rather than the internal `Place`. The
 * browser has no business depending on the artifact's layout, and an ambiguous
 * answer with eight candidates would otherwise ship eight full airport lists.
 */

import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../middleware/asyncHandler';
import { LOCATION_DATA_ATTRIBUTION } from '../data/attribution';
import { DEFAULT_OPTIONS } from '../services/location/options';
import { originIndex } from '../services/location/originAirports';
import { resolve } from '../services/location/resolve';
import { logger } from '../utils/logger';
import type { Candidate, PlaceAirport, Resolution } from '../services/location/types';

const router = Router();

/**
 * Bounded everywhere a caller controls the size. The resolver has its own
 * `maxInputLength`, but a schema that accepts a 10 kB "place name" has already
 * spent the memory by the time the resolver trims it.
 */
const resolveSchema = z.object({
  query: z.string().min(1).max(DEFAULT_OPTIONS.maxInputLength),
  /** The traveller's own position, when the browser has permission for it. */
  userLatLon: z
    .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
    .optional(),
  userCountry: z.string().length(2).optional(),
  /** Destinations already on the trip. The strongest context there is. */
  tripDestinationNames: z.array(z.string().min(1).max(120)).max(12).optional(),
  /** How many airports per answer. The hand-written table always gave 3. */
  max: z.number().int().min(1).max(8).default(3),
});

type WireAirport = { iata: string; km: number; servesPlace: boolean };

function wireAirports(airports: PlaceAirport[], max: number): WireAirport[] {
  return airports.slice(0, max).map((airport) => ({
    iata: airport.iata,
    km: Math.round(airport.km),
    servesPlace: airport.servesPlace,
  }));
}

function wireCandidate(candidate: Candidate, max: number): Record<string, unknown> {
  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    label: candidate.label,
    country: candidate.place.country,
    admin: candidate.place.admin,
    kind: candidate.place.kind,
    airports: wireAirports(candidate.airports, max),
    ...(candidate.distanceKm !== undefined ? { distanceKm: candidate.distanceKm } : {}),
    ...(candidate.editDistance !== undefined ? { editDistance: candidate.editDistance } : {}),
  };
}

function wire(result: Resolution, max: number): Record<string, unknown> {
  if (result.status === 'resolved') {
    return {
      status: 'resolved',
      place: {
        placeId: result.place.id,
        name: result.place.name,
        country: result.place.country,
        admin: result.place.admin,
        kind: result.place.kind,
        lat: result.place.lat,
        lon: result.place.lon,
      },
      airports: wireAirports(result.airports, max),
      via: result.via,
    };
  }
  if (result.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      reason: result.reason,
      candidates: result.candidates.map((c) => wireCandidate(c, max)),
    };
  }
  return {
    status: 'unknown',
    suggestions: result.suggestions.map((c) => wireCandidate(c, max)),
  };
}

router.post(
  '/resolve',
  asyncHandler(async (req, res) => {
    const input = resolveSchema.parse(req.body);
    const result = resolve(
      input.query,
      {
        ...(input.userLatLon ? { userLatLon: input.userLatLon } : {}),
        ...(input.userCountry ? { userCountry: input.userCountry } : {}),
        ...(input.tripDestinationNames
          ? { tripDestinationNames: input.tripDestinationNames }
          : {}),
      },
      originIndex(),
    );

    // The original bug was silent, so every non-answer is written down with
    // the raw input. This is the only way the long tail becomes discoverable:
    // no aggregate would have shown `"New Jersey"` arriving as `"NEW"`.
    if (result.status !== 'resolved') {
      logger.info('location-resolve non-answer', {
        input: input.query,
        status: result.status,
        reason: result.status === 'ambiguous' ? result.reason : undefined,
        // Coordinates are NOT logged. Whether the caller had any is the part
        // that explains the outcome; where they were is not ours to keep.
        hadContext: Boolean(input.userLatLon ?? input.tripDestinationNames?.length),
      });
    }

    // CC BY 4.0 requires credit, a licence link and an indication of changes
    // wherever the data goes. This endpoint is the data leaving the building,
    // so the notice travels with it rather than depending on a caller having
    // read ATTRIBUTION.md. ~100 bytes.
    res.json({ ...wire(result, input.max), attribution: LOCATION_DATA_ATTRIBUTION });
  }),
);

export default router;
