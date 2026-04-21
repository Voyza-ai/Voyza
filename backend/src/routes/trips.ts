import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { getSupabase } from '../services/supabase';
import { AppError } from '../middleware/error';

const router = Router();

// ─── POST /api/trips — Save a new trip ──────────────────────
const createTripSchema = z.object({
  title: z.string().min(1),
  travelers: z.number().int().positive().default(1),
  totalCost: z.number().default(0),
  savingsVsAlternative: z.number().default(0),
  cities: z.array(z.any()).default([]),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const body = createTripSchema.parse(req.body);
    const supabase = getSupabase();

    // Insert trip
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .insert({
        user_id: user.id,
        title: body.title,
        travelers: body.travelers,
        total_cost: body.totalCost,
        savings_vs_alternative: body.savingsVsAlternative,
        status: 'active',
      })
      .select()
      .single();

    if (tripError || !trip) {
      throw new AppError(500, tripError?.message ?? 'Failed to create trip');
    }

    // Insert cities
    if (body.cities.length > 0) {
      const cityRows = body.cities.map((c: any, idx: number) => ({
        trip_id: trip.id,
        name: c.name,
        country: c.country ?? '',
        arrival_date: c.dates?.arrival || null,
        departure_date: c.dates?.departure || null,
        color_index: c.colorIndex ?? idx,
        position: idx,
        hotel: c.hotel ?? null,
        activities: c.activities ?? [],
        restaurants: c.restaurants ?? [],
        schedule: c.schedule ?? {},
      }));

      const { data: insertedCities, error: citiesError } = await supabase
        .from('cities')
        .insert(cityRows)
        .select();

      if (citiesError) {
        // Don't fail hard — trip was created
        console.error('Failed to insert cities:', citiesError.message);
      }

      // Insert transports between consecutive cities
      if (insertedCities && insertedCities.length > 1) {
        const transportRows: any[] = [];
        for (let i = 0; i < insertedCities.length - 1; i++) {
          const city = body.cities[i];
          const t = city.transportOut;
          if (t) {
            transportRows.push({
              trip_id: trip.id,
              from_city_id: insertedCities[i].id,
              to_city_id: insertedCities[i + 1].id,
              mode: t.mode ?? 'flight',
              operator: t.operator ?? '',
              price: t.price ?? 0,
              duration_minutes: t.duration ? parseInt(t.duration) || 0 : 0,
              depart_time: t.departTime ?? null,
              arrive_time: t.arriveTime ?? null,
              booking_url: t.bookingUrl ?? null,
            });
          }
        }
        if (transportRows.length > 0) {
          const { error: transportError } = await supabase
            .from('transports')
            .insert(transportRows);
          if (transportError) {
            console.error('Failed to insert transports:', transportError.message);
          }
        }
      }
    }

    // Create owner group_member row
    await supabase.from('group_members').insert({
      trip_id: trip.id,
      user_id: user.id,
      role: 'owner',
      accepted_at: new Date().toISOString(),
    });

    res.status(201).json({ tripId: trip.id, trip });
  }),
);

// ─── GET /api/trips — List user's trips ─────────────────────
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const { data: trips, error } = await supabase
      .from('trips')
      .select('id, title, status, travelers, total_cost, savings_vs_alternative, created_at')
      .eq('user_id', user.id)
      .neq('status', 'archived')
      .order('created_at', { ascending: false });

    if (error) {
      throw new AppError(500, error.message);
    }

    // Fetch city names for each trip
    const tripIds = (trips ?? []).map((t: any) => t.id);
    const { data: cities } = tripIds.length > 0
      ? await supabase
          .from('cities')
          .select('trip_id, name, arrival_date, departure_date')
          .in('trip_id', tripIds)
          .order('position', { ascending: true })
      : { data: [] };

    const citiesByTrip: Record<string, any[]> = {};
    for (const c of cities ?? []) {
      if (!citiesByTrip[c.trip_id]) citiesByTrip[c.trip_id] = [];
      citiesByTrip[c.trip_id].push(c);
    }

    const enriched = (trips ?? []).map((t: any) => {
      const tripCities = citiesByTrip[t.id] ?? [];
      const firstCity = tripCities[0];
      const lastCity = tripCities[tripCities.length - 1];
      return {
        ...t,
        city_count: tripCities.length,
        cities: tripCities.map((c: any) => c.name),
        date_range:
          firstCity && lastCity
            ? { start: firstCity.arrival_date, end: lastCity.departure_date }
            : undefined,
      };
    });

    res.json({ trips: enriched });
  }),
);

// ─── GET /api/trips/:id — Get full trip ─────────────────────
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const { data: trip, error } = await supabase
      .from('trips')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !trip) {
      throw new AppError(404, 'Trip not found');
    }

    // RLS handles access control, but verify ownership/membership
    if (trip.user_id !== user.id) {
      const { data: member } = await supabase
        .from('group_members')
        .select('id')
        .eq('trip_id', trip.id)
        .eq('user_id', user.id)
        .single();
      if (!member) {
        throw new AppError(403, 'Access denied');
      }
    }

    // Fetch cities and transports
    const { data: cities } = await supabase
      .from('cities')
      .select('*')
      .eq('trip_id', trip.id)
      .order('position', { ascending: true });

    const { data: transports } = await supabase
      .from('transports')
      .select('*')
      .eq('trip_id', trip.id);

    res.json({ trip, cities: cities ?? [], transports: transports ?? [] });
  }),
);

// ─── DELETE /api/trips/:id — Archive trip ────────────────────
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const { error } = await supabase
      .from('trips')
      .update({ status: 'archived' })
      .eq('id', req.params.id)
      .eq('user_id', user.id);

    if (error) {
      throw new AppError(500, error.message);
    }

    res.json({ success: true });
  }),
);

export default router;
