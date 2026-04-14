import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { searchTrains } from '../services/trains';

const router = Router();

const searchSchema = z.object({
  origin: z.string().min(1),
  destination: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  travelers: z.number().int().positive().default(1),
  originCountry: z.string().optional(),
  destinationCountry: z.string().optional(),
});

router.post(
  '/search',
  asyncHandler(async (req, res) => {
    const input = searchSchema.parse(req.body);
    const offers = await searchTrains({
      origin: input.origin,
      destination: input.destination,
      date: input.date,
      travelers: input.travelers,
      originCountry: input.originCountry,
      destinationCountry: input.destinationCountry,
    });
    res.json({ offers });
  }),
);

export default router;
