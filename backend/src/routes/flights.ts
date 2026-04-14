import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { searchFlights, getIataCode } from '../services/flights';

const router = Router();

const searchSchema = z.object({
  origin: z.string().length(3, 'IATA code required (3 letters)'),
  destination: z.string().length(3, 'IATA code required (3 letters)'),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  passengers: z.number().int().positive().default(1),
  cabinClass: z
    .enum(['economy', 'premium_economy', 'business', 'first'])
    .default('economy'),
});

router.post(
  '/search',
  asyncHandler(async (req, res) => {
    const input = searchSchema.parse(req.body);
    const offers = await searchFlights({
      origin: input.origin,
      destination: input.destination,
      date: input.departureDate,
      travelers: input.passengers,
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
