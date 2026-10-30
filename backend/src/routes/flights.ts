import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { searchFlights, getIataCode } from '../services/flights';
import { clampToFuture } from '../utils/dates';

const router = Router();

const searchSchema = z.object({
  origin: z.string().min(1),
  destination: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  travelers: z.number().int().positive().default(1),
  cabinClass: z
    .enum(['economy', 'premium_economy', 'business', 'first'])
    .default('economy'),
});

router.post(
  '/search',
  asyncHandler(async (req, res) => {
    const input = searchSchema.parse(req.body);

    // Resolve city names to IATA codes (pass-through if already 3-letter codes)
    const [originIata, destIata] = await Promise.all([
      input.origin.length === 3 ? input.origin : getIataCode(input.origin),
      input.destination.length === 3 ? input.destination : getIataCode(input.destination),
    ]);

    const offers = await searchFlights({
      origin: originIata,
      destination: destIata,
      date: input.date,
      travelers: input.travelers,
      cabinClass: input.cabinClass,
    });
    res.json({ offers });
  }),
);

const iataSchema = z.object({
  cityName: z.string().min(1),
  /**
   * The other stops on the trip, when the caller knows them: they decide
   * which `Lagos` is meant. Optional, and bounded exactly as
   * `/api/locations/resolve` bounds the same field.
   */
  tripDestinationNames: z.array(z.string().min(1).max(120)).max(12).optional(),
});

router.post(
  '/iata',
  asyncHandler(async (req, res) => {
    const { cityName, tripDestinationNames } = iataSchema.parse(req.body);
    const iataCode = await getIataCode(
      cityName,
      tripDestinationNames ? { tripDestinationNames } : {},
    );
    res.json({ cityName, iataCode });
  }),
);

// ─── POST /api/flights/home-legs ─────────────────────────────
// Standalone home-leg search for trips that weren't built by the
// optimizer (e.g. Browse marketplace presets). Returns the same
// HomeLeg shape the optimizer produces — main flight + up to 3
// alternatives per direction — so the flowchart home connectors and
// canvas home cards render identically. Either leg can come back
// null (no offers found); callers save the trip without it.
const homeLegsSchema = z.object({
  originAirports: z.array(z.string().min(3)).min(1),
  /** Home city name — lets the search fall back to the metro code when
   *  the specific airports return no offers. */
  originCity: z.string().optional(),
  firstCity: z.string().min(1),
  lastCity: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  /**
   * The first city's departure. When sent, the response also carries
   * `firstCityArrival`: the day the first stay starts given the outbound's
   * landing date — the optimizer's own rule (firstStayArrival), which a trip
   * built here (a Browse preset) otherwise never gets.
   */
  firstCityDeparture: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  travelers: z.number().int().positive().default(1),
  // Direction toggles — callers refreshing a single home card search only
  // that leg instead of paying for both flight searches.
  outbound: z.boolean().default(true),
  returnToHome: z.boolean().default(true),
});

router.post(
  '/home-legs',
  asyncHandler(async (req, res) => {
    const input = homeLegsSchema.parse(req.body);
    const { buildHomeLeg, firstStayArrival } = await import('../services/optimizer');
    // The only trip this route sees: its two ends. Enough for the trip to
    // decide which "Lagos" a Portugal itinerary means.
    const tripCityNames = [input.firstCity, input.lastCity];

    const [outboundLeg, returnLeg] = await Promise.all([
      input.outbound
        ? buildHomeLeg({
            originAirports: input.originAirports,
            destinationCity: input.firstCity,
            date: clampToFuture(input.startDate),
            travelers: input.travelers,
            originCity: input.originCity,
            tripCityNames,
          })
        : Promise.resolve(null),
      input.returnToHome
        ? buildHomeLeg({
            originAirports: input.originAirports,
            destinationCity: input.lastCity,
            date: clampToFuture(input.endDate ?? input.startDate),
            travelers: input.travelers,
            reverse: true,
            originCity: input.originCity,
            tripCityNames,
          })
        : Promise.resolve(null),
    ]);

    // An overnight outbound lands the day after it leaves: the first stay
    // starts then, exactly as optimize() dates it. Only when the caller sent
    // the first city's departure (so the stay can keep a night) and the
    // flight's landing date is known; otherwise the response is unchanged.
    const firstCityArrival =
      outboundLeg?.arriveDate && input.firstCityDeparture
        ? firstStayArrival({
            startDate: input.startDate,
            firstDeparture: input.firstCityDeparture,
            landed: outboundLeg.arriveDate,
            city: input.firstCity,
          })
        : undefined;

    res.json({ outboundLeg, returnLeg, ...(firstCityArrival ? { firstCityArrival } : {}) });
  }),
);

export default router;
