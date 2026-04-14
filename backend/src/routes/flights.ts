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

export default router;
