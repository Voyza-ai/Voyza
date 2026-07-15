import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { getSupabase } from '../services/supabase';
import { AppError } from '../middleware/error';
import { parseDurationMinutes } from '../utils/duration';
import { buildTripFromDb } from '../utils/tripShape';

const router = Router();

// ─── POST /api/trips — Save a new trip ──────────────────────
//
// Accepts the complete Trip object from PlanningChat (cities with
// transportIn/transportOut, hotel arrays, schedule, activities, etc.)
// and persists it across three tables (trips, cities, transports).
//
// All new fields are OPTIONAL so old clients keep saving successfully —
// they just get `null` in the new columns. See the matching migration
// in `supabase/migrations/*_extend_trip_schema_for_full_persistence.sql`.
const createTripSchema = z.object({
  title: z.string().min(1),
  travelers: z.number().int().positive().default(1),
  totalCost: z.number().default(0),
  savingsVsAlternative: z.number().default(0),
  cities: z.array(z.any()).default([]),

  // New optional metadata
  budget: z.number().nullable().optional(),
  budgetPerPerson: z.boolean().nullable().optional(),
  vibe: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dateShiftSuggestion: z
    .object({
      dayOffset: z.number(),
      newStartDate: z.string(),
      newTotalCost: z.number(),
      savings: z.number(),
    })
    .nullable()
    .optional(),

  // Home anchor / origin fields (new)
  originCity: z.string().nullable().optional(),
  originAirports: z.array(z.string()).nullable().optional(),
  returnToHome: z.boolean().nullable().optional(),
  // Optional HomeLeg blobs — accept-any because shape is internal and
  // we don't want to break if the frontend sends an extra field.
  outboundLeg: z.any().nullable().optional(),
  returnLeg: z.any().nullable().optional(),
  // Independent back-home anchor (open-jaw) — null means "same as origin".
  returnCity: z.string().nullable().optional(),
  returnAirports: z.array(z.string()).nullable().optional(),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const body = createTripSchema.parse(req.body);
    const supabase = getSupabase();

    // Insert the trip row with all optional metadata columns the
    // migration added. Any field the client didn't send becomes NULL.
    const tripRow: Record<string, any> = {
      user_id: user.id,
      title: body.title,
      travelers: body.travelers,
      total_cost: body.totalCost,
      savings_vs_alternative: body.savingsVsAlternative,
      status: 'active',
      budget: body.budget ?? null,
      budget_per_person: body.budgetPerPerson ?? null,
      vibe: body.vibe ?? null,
      start_date: body.startDate ?? null,
      date_shift_suggestion: body.dateShiftSuggestion ?? null,
      origin_city: body.originCity ?? null,
      origin_airports: body.originAirports ?? [],
      return_to_home: body.returnToHome ?? true,
      outbound_leg: body.outboundLeg ?? null,
      return_leg: body.returnLeg ?? null,
    };
    // Back-home overrides — only written when actually set, so trips that
    // never use the feature don't touch the (migration-003) columns.
    if (body.returnCity) tripRow.return_city = body.returnCity;
    if (Array.isArray(body.returnAirports)) tripRow.return_airports = body.returnAirports;

    let { data: trip, error: tripError } = await supabase
      .from('trips')
      .insert(tripRow)
      .select()
      .single();

    // Migration 003 not applied yet — retry without the return-anchor
    // columns rather than failing the whole save.
    if (tripError && /return_(city|airports)/.test(tripError.message ?? '')) {
      console.warn(
        '[trips] return_city/return_airports columns missing — run supabase/migrations/003_return_home_anchor.sql',
      );
      delete tripRow.return_city;
      delete tripRow.return_airports;
      ({ data: trip, error: tripError } = await supabase
        .from('trips')
        .insert(tripRow)
        .select()
        .single());
    }

    if (tripError || !trip) {
      throw new AppError(500, tripError?.message ?? 'Failed to create trip');
    }

    // Insert cities with the richer hotel data (full ranked list + selection index + custom override)
    if (body.cities.length > 0) {
      const cityRows = body.cities.map((c: any, idx: number) => ({
        trip_id: trip.id,
        name: c.name,
        country: c.country ?? '',
        arrival_date: c.dates?.arrival || null,
        departure_date: c.dates?.departure || null,
        color_index: c.colorIndex ?? idx,
        position: idx,
        // Legacy single-hotel column kept for backward compat with any
        // clients still reading it. Prefer hotels[selected_hotel_index].
        hotel: c.hotel ?? null,
        // NEW columns from the migration — store the full 5-hotel ranked
        // list so the user can cycle between options without a refetch.
        hotels: Array.isArray(c.hotels) ? c.hotels : (c.hotel ? [c.hotel] : []),
        selected_hotel_index: typeof c.selectedHotelIndex === 'number' ? c.selectedHotelIndex : 0,
        custom_hotel: c.customHotel ?? null,
        vibes: Array.isArray(c.vibes) ? c.vibes : [],
        activities: c.activities ?? [],
        restaurants: c.restaurants ?? [],
        schedule: c.schedule ?? {},
      }));

      const { data: insertedCities, error: citiesError } = await supabase
        .from('cities')
        .insert(cityRows)
        .select();

      if (citiesError) {
        // Don't fail hard — trip was created. Log for debugging but keep
        // going so at least the trip row exists for the user to recover.
        console.error('Failed to insert cities:', citiesError.message);
      }

      // Insert transports between consecutive cities. Uses the new
      // columns the migration added (duration_minutes, depart_time,
      // arrive_time, alternatives, etc.) so flight cards render
      // complete data when the results page reloads from the DB.
      //
      // This is the block that was silently failing every write before —
      // the old code wrote to columns that didn't exist, which is why
      // transports has 0 rows despite 24 trips being saved.
      if (insertedCities && insertedCities.length > 1) {
        const transportRows: any[] = [];
        for (let i = 0; i < insertedCities.length - 1; i++) {
          const city = body.cities[i];
          const t = city.transportOut;
          if (t && (t.price ?? 0) > 0) {
            transportRows.push({
              trip_id: trip.id,
              from_city_id: insertedCities[i].id,
              to_city_id: insertedCities[i + 1].id,
              mode: t.mode ?? 'flight',
              operator: t.operator ?? '',
              price: t.price ?? 0,
              // Proper duration parsing — was `parseInt("3h 37m") = 3`
              // before, now correctly resolves to 217 minutes.
              duration_minutes: parseDurationMinutes(t.duration),
              depart_time: t.departTime ?? null,
              arrive_time: t.arriveTime ?? null,
              depart_date: t.departDate ?? null,
              layovers: typeof t.layovers === 'number' ? t.layovers : null,
              stops: typeof t.stops === 'number' ? t.stops : null,
              currency: t.currency ?? 'USD',
              carrier_code: t.carrierCode ?? null,
              flight_number: t.flightNumber ?? t.trainNumber ?? null,
              alternatives: Array.isArray(t.alternatives) ? t.alternatives : null,
              booking_url: t.bookingUrl ?? null,
            });
          }
        }
        if (transportRows.length > 0) {
          const { error: transportError } = await supabase
            .from('transports')
            .insert(transportRows);
          if (transportError) {
            console.error('Failed to insert transports:', transportError.message, {
              sample: transportRows[0],
            });
          }
        }
      }
    }

    // Create owner group_member row so canvas sharing works immediately.
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

    // Return both the assembled frontend Trip shape (new canonical format)
    // AND the raw rows (for backward-compat with existing frontend code
    // that still reads `data.cities` / `data.transports` directly). Once
    // all consumers read `data.trip` as a complete Trip, we can drop the
    // raw arrays.
    const fullTrip = buildTripFromDb(trip, cities ?? [], transports ?? []);
    res.json({
      trip: fullTrip,
      cities: cities ?? [],
      transports: transports ?? [],
    });
  }),
);

// ─── PATCH /api/trips/:id — Partial update ───────────────────
// Rename, change dates, update budget/vibe, or restore an archived trip.
// City/transport mutations should still go through the canvas save flow
// (atomic rewrite) — this endpoint is for trip-level metadata only.
const patchTripSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  travelers: z.number().int().positive().optional(),
  totalCost: z.number().optional(),
  savingsVsAlternative: z.number().optional(),
  budget: z.number().nullable().optional(),
  budgetPerPerson: z.boolean().nullable().optional(),
  vibe: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dateShiftSuggestion: z.any().nullable().optional(),
  // Home legs — the results page backfills these when a trip was saved
  // without searched flights (or the search failed at save time).
  outboundLeg: z.any().nullable().optional(),
  returnLeg: z.any().nullable().optional(),
});

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const body = patchTripSchema.parse(req.body);
    const supabase = getSupabase();

    // Authorization: only the owner can update trip metadata. Canvas editors
    // can modify cities/transports via the canvas save flow, but renaming
    // the trip or changing its status is an owner-only operation.
    const { data: trip } = await supabase
      .from('trips')
      .select('user_id')
      .eq('id', req.params.id)
      .single();
    if (!trip) throw new AppError(404, 'Trip not found');
    if (trip.user_id !== user.id) throw new AppError(403, 'Only the trip owner can edit this trip');

    // Build a sparse update — map camelCase body to snake_case columns.
    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.title !== undefined) update.title = body.title;
    if (body.status !== undefined) update.status = body.status;
    if (body.travelers !== undefined) update.travelers = body.travelers;
    if (body.totalCost !== undefined) update.total_cost = body.totalCost;
    if (body.savingsVsAlternative !== undefined) update.savings_vs_alternative = body.savingsVsAlternative;
    if (body.budget !== undefined) update.budget = body.budget;
    if (body.budgetPerPerson !== undefined) update.budget_per_person = body.budgetPerPerson;
    if (body.vibe !== undefined) update.vibe = body.vibe;
    if (body.startDate !== undefined) update.start_date = body.startDate;
    if (body.dateShiftSuggestion !== undefined) update.date_shift_suggestion = body.dateShiftSuggestion;
    if (body.outboundLeg !== undefined) update.outbound_leg = body.outboundLeg;
    if (body.returnLeg !== undefined) update.return_leg = body.returnLeg;

    const { data, error } = await supabase
      .from('trips')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new AppError(500, error.message);
    res.json({ trip: data });
  }),
);

// ─── PATCH /api/trips/:id/permissions ────────────────────────
// Owner-only toggles that control how the trip shows up elsewhere in
// the product:
//   - allow_clones: can other users make a personal copy?
//   - allow_recommendations: can Voyza use this trip's patterns as
//     training data for the recommender? (No PII used — just cities,
//     dates, budget, vibe.)
//   - is_public: does this trip appear in /explore? Public trips are
//     auto-cloneable regardless of allow_clones (that's what public
//     means), so the RLS policy only checks is_public for read access.
const permissionsSchema = z.object({
  allowClones: z.boolean().optional(),
  allowRecommendations: z.boolean().optional(),
  isPublic: z.boolean().optional(),
});

router.patch(
  '/:id/permissions',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const body = permissionsSchema.parse(req.body);
    const supabase = getSupabase();

    const { data: trip } = await supabase
      .from('trips')
      .select('user_id')
      .eq('id', req.params.id)
      .single();
    if (!trip) throw new AppError(404, 'Trip not found');
    if (trip.user_id !== user.id) {
      throw new AppError(403, 'Only the trip owner can change permissions');
    }

    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.allowClones !== undefined) update.allow_clones = body.allowClones;
    if (body.allowRecommendations !== undefined)
      update.allow_recommendations = body.allowRecommendations;
    if (body.isPublic !== undefined) update.is_public = body.isPublic;

    const { data, error } = await supabase
      .from('trips')
      .update(update)
      .eq('id', req.params.id)
      .select('id, allow_clones, allow_recommendations, is_public')
      .single();

    if (error) throw new AppError(500, error.message);
    res.json({ permissions: data });
  }),
);

// ─── POST /api/trips/:id/clone ───────────────────────────────
// Make a personal copy of a trip. Selective — the client ticks
// checkboxes for which layers to copy:
//   - cities (always true; you can't have a trip with no cities)
//   - hotels: keep hotel picks from the source?
//   - activities: keep activity curation?
//   - restaurants: keep restaurant picks?
//   - schedule: keep the calendar layout?
//   - transports: keep the flights/trains (usually NO — prices stale)
// Whatever's unchecked gets wiped on the cloned row so the new owner
// can run a fresh AI curation / optimizer pass.
//
// Gate: the source trip must have allow_clones = TRUE unless it's also
// is_public = TRUE (public implies shareable) or the caller is already
// a collaborator on it.
//
// Always writes `cloned_from_trip_id` + increments the source's
// `clone_count` for social-proof signals later.
const cloneSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  include: z
    .object({
      hotels: z.boolean().default(true),
      activities: z.boolean().default(true),
      restaurants: z.boolean().default(true),
      schedule: z.boolean().default(true),
      transports: z.boolean().default(false),
    })
    .partial()
    .optional(),
});

router.post(
  '/:id/clone',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const body = cloneSchema.parse(req.body ?? {});
    const include = {
      hotels: true,
      activities: true,
      restaurants: true,
      schedule: true,
      transports: false,
      ...(body.include ?? {}),
    };
    const supabase = getSupabase();

    // Fetch source trip with permission flags so we can gate the clone.
    const { data: source } = await supabase
      .from('trips')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (!source) throw new AppError(404, 'Trip not found');

    // Clone gate: owner always, collaborator always, otherwise the trip
    // must have granted clone permission (public or allow_clones).
    const isOwner = source.user_id === user.id;
    let isCollaborator = false;
    if (!isOwner) {
      const { data: member } = await supabase
        .from('group_members')
        .select('id')
        .eq('trip_id', source.id)
        .eq('user_id', user.id)
        .single();
      isCollaborator = !!member;
    }
    const canClone = isOwner || isCollaborator || source.is_public || source.allow_clones;
    if (!canClone) {
      throw new AppError(403, 'This trip is not available for cloning');
    }

    // 1. Create the new trip row. Reset status/cost/savings so the new
    //    owner starts from a clean slate but inherits the trip shape.
    const newTitle = body.title ?? `${source.title} (copy)`;
    const { data: newTrip, error: newTripErr } = await supabase
      .from('trips')
      .insert({
        user_id: user.id,
        title: newTitle,
        travelers: source.travelers,
        total_cost: include.transports ? source.total_cost : 0,
        savings_vs_alternative: 0,
        status: 'active',
        budget: source.budget,
        budget_per_person: source.budget_per_person,
        vibe: source.vibe,
        start_date: source.start_date,
        date_shift_suggestion: null,
        cloned_from_trip_id: source.id,
        // Cloned trips default to private — the new owner decides if
        // THEY want their copy discoverable.
        allow_clones: true,
        allow_recommendations: true,
        is_public: false,
      })
      .select()
      .single();
    if (newTripErr || !newTrip) {
      throw new AppError(500, newTripErr?.message ?? 'Failed to create cloned trip');
    }

    // 2. Clone cities, filtering optional layers based on `include`.
    const { data: sourceCities } = await supabase
      .from('cities')
      .select('*')
      .eq('trip_id', source.id)
      .order('position', { ascending: true });

    const cityIdMap: Record<string, string> = {}; // old id → new id
    if (sourceCities && sourceCities.length > 0) {
      const cityRows = sourceCities.map((c: any) => ({
        trip_id: newTrip.id,
        name: c.name,
        country: c.country,
        arrival_date: c.arrival_date,
        departure_date: c.departure_date,
        color_index: c.color_index,
        position: c.position,
        vibes: c.vibes,
        hotel: include.hotels ? c.hotel : null,
        hotels: include.hotels ? c.hotels : [],
        selected_hotel_index: include.hotels ? c.selected_hotel_index : 0,
        custom_hotel: include.hotels ? c.custom_hotel : null,
        activities: include.activities ? c.activities : [],
        restaurants: include.restaurants ? c.restaurants : [],
        schedule: include.schedule ? c.schedule : {},
      }));

      const { data: insertedCities, error: citiesErr } = await supabase
        .from('cities')
        .insert(cityRows)
        .select();
      if (citiesErr) {
        throw new AppError(500, `Failed to clone cities: ${citiesErr.message}`);
      }

      // Map old→new city ids by position so we can clone transports.
      for (const sc of sourceCities) {
        const match = (insertedCities ?? []).find((ic: any) => ic.position === sc.position);
        if (match) cityIdMap[sc.id] = match.id;
      }
    }

    // 3. Clone transports only if the caller asked for them. Stale by
    //    default — flight prices move fast — but useful for trip
    //    templates where the exact flights matter.
    if (include.transports) {
      const { data: sourceTransports } = await supabase
        .from('transports')
        .select('*')
        .eq('trip_id', source.id);
      if (sourceTransports && sourceTransports.length > 0) {
        const transportRows = sourceTransports
          .map((t: any) => ({
            trip_id: newTrip.id,
            from_city_id: cityIdMap[t.from_city_id],
            to_city_id: cityIdMap[t.to_city_id],
            mode: t.mode,
            operator: t.operator,
            price: t.price,
            duration_minutes: t.duration_minutes,
            depart_time: t.depart_time,
            arrive_time: t.arrive_time,
            depart_date: t.depart_date,
            layovers: t.layovers,
            stops: t.stops,
            currency: t.currency,
            carrier_code: t.carrier_code,
            flight_number: t.flight_number,
            alternatives: t.alternatives,
            booking_url: t.booking_url,
          }))
          .filter((t: any) => t.from_city_id && t.to_city_id);
        if (transportRows.length > 0) {
          await supabase.from('transports').insert(transportRows);
        }
      }
    }

    // 4. Owner membership row for the NEW trip.
    await supabase.from('group_members').insert({
      trip_id: newTrip.id,
      user_id: user.id,
      role: 'owner',
      accepted_at: new Date().toISOString(),
    });

    // 5. Bump the source's clone_count for social-proof signals
    //    ("100 travelers cloned this"). Non-fatal if it fails.
    await supabase
      .from('trips')
      .update({ clone_count: (source.clone_count ?? 0) + 1 })
      .eq('id', source.id);

    res.status(201).json({ tripId: newTrip.id, trip: newTrip, clonedFrom: source.id });
  }),
);

// ─── POST /api/trips/:id/transfer-ownership ──────────────────
// Hand a trip to another user. Only the current owner can initiate.
// Target must already be a group_members row — you can't transfer to
// someone who isn't on the trip (enforces "invite first, transfer
// second"). After transfer:
//   - trips.user_id = newOwnerId
//   - old owner's group_members row is flipped to 'editor' (not removed —
//     UX assumption is "I'm handing this off but I still want access").
//     A separate DELETE /members call can kick them off entirely.
//   - new owner's group_members row is flipped to 'owner'.
const transferSchema = z.object({
  newOwnerId: z.string().uuid(),
});

router.post(
  '/:id/transfer-ownership',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const { newOwnerId } = transferSchema.parse(req.body);
    const supabase = getSupabase();

    if (newOwnerId === user.id) {
      throw new AppError(400, 'You already own this trip');
    }

    const { data: trip } = await supabase
      .from('trips')
      .select('user_id')
      .eq('id', req.params.id)
      .single();
    if (!trip) throw new AppError(404, 'Trip not found');
    if (trip.user_id !== user.id) {
      throw new AppError(403, 'Only the current owner can transfer ownership');
    }

    // Target must already be a collaborator — prevents accidentally
    // handing the trip to an arbitrary user_id.
    const { data: targetMember } = await supabase
      .from('group_members')
      .select('id, role')
      .eq('trip_id', req.params.id)
      .eq('user_id', newOwnerId)
      .single();
    if (!targetMember) {
      throw new AppError(
        400,
        'Target user must be a collaborator on this trip before ownership can be transferred',
      );
    }

    // 1. Update trips.user_id to the new owner.
    const { error: tripErr } = await supabase
      .from('trips')
      .update({ user_id: newOwnerId, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (tripErr) throw new AppError(500, tripErr.message);

    // 2. Demote the previous owner's membership row to 'editor' so they
    //    still have edit access but no ownership powers.
    await supabase
      .from('group_members')
      .update({ role: 'editor' })
      .eq('trip_id', req.params.id)
      .eq('user_id', user.id);

    // 3. Promote the new owner's membership row.
    await supabase
      .from('group_members')
      .update({ role: 'owner' })
      .eq('id', targetMember.id);

    res.json({
      success: true,
      tripId: req.params.id,
      newOwnerId,
      previousOwnerId: user.id,
    });
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
