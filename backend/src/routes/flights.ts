import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { searchFlights, getIataCode } from '../services/flights';

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
});

router.post(
  '/iata',
  asyncHandler(async (req, res) => {
    const { cityName } = iataSchema.parse(req.body);
    const iataCode = await getIataCode(cityName);
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
  firstCity: z.string().min(1),
  lastCity: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
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
    const { buildHomeLeg, clampToFuture } = await import('../services/optimizer');

    const [outboundLeg, returnLeg] = await Promise.all([
      input.outbound
        ? buildHomeLeg({
            originAirports: input.originAirports,
            destinationCity: input.firstCity,
            date: clampToFuture(input.startDate),
            travelers: input.travelers,
          })
        : Promise.resolve(null),
      input.returnToHome
        ? buildHomeLeg({
            originAirports: input.originAirports,
            destinationCity: input.lastCity,
            date: clampToFuture(input.endDate ?? input.startDate),
            travelers: input.travelers,
            reverse: true,
          })
        : Promise.resolve(null),
    ]);

    res.json({ outboundLeg, returnLeg });
  }),
);

export default router;
