import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { hotelSearchLimiter } from '../middleware/rateLimit';
import { searchHotels } from '../services/hotels';
import { hotelPhotos } from '../services/hotelPhotos';

const router = Router();

const searchSchema = z.object({
  city: z.string().min(1),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  adults: z.number().int().positive().default(2),
  // No default here: an omitted room count is decided by `searchHotels`
  // (two adults to a room), so the canvas route and anything else that calls
  // the service directly get the same answer as this endpoint.
  rooms: z.number().int().positive().optional(),
  maxPrice: z.number().positive().optional(),
  // A later page of the same search — the city guide's "Find more hotels".
  // Capped: each page is a metered RapidAPI call.
  page: z.number().int().min(0).max(5).optional(),
});

router.post(
  '/search',
  // Its own cap on top of the shared expensive one: every search spends
  // RapidAPI quota (see hotelSearchLimiter for the sizing).
  hotelSearchLimiter,
  asyncHandler(async (req, res) => {
    const input = searchSchema.parse(req.body);
    const hotels = await searchHotels(input);
    res.json({ hotels });
  }),
);

// A hotel's photo gallery for the city guide. Booking hotel ids are numeric;
// anything else is refused before it reaches the metered API.
const photosSchema = z.object({ hotelId: z.string().regex(/^\d{1,12}$/, 'Booking hotel id') });

router.get(
  '/photos',
  hotelSearchLimiter,
  asyncHandler(async (req, res) => {
    const { hotelId } = photosSchema.parse(req.query);
    const photos = await hotelPhotos(hotelId);
    // Photos of a hotel change rarely; let the browser keep them for an hour.
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ photos });
  }),
);

export default router;
