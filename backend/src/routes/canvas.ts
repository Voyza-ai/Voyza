import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/error';
import { getSupabase } from '../services/supabase';
import { compareLeg } from '../services/compareLeg';
import { searchHotels } from '../services/hotels';
import { env } from '../config/env';
import { parseDurationMinutes } from '../utils/duration';

const router = Router();

// Helper: extract user from Supabase JWT
async function getUserFromToken(authHeader?: string) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const supabase = getSupabase();
  const { data } = await supabase.auth.getUser(token);
  return data?.user ?? null;
}

// Helper: check group membership
async function getMemberRole(tripId: string, userId: string) {
  const supabase = getSupabase();

  // Check if user is trip owner
  const { data: trip } = await supabase
    .from('trips')
    .select('user_id')
    .eq('id', tripId)
    .single();

  if (trip?.user_id === userId) return 'owner';

  // Check group_members
  const { data: member } = await supabase
    .from('group_members')
    .select('role')
    .eq('trip_id', tripId)
    .eq('user_id', userId)
    .single();

  return member?.role ?? null;
}

// ─── POST /api/canvas/:tripId/session ────────────────────────
router.post(
  '/:tripId/session',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    if (!role) throw new AppError(403, 'Not a member of this trip');

    const supabase = getSupabase();

    // Find or create session
    const { data: existing } = await supabase
      .from('canvas_sessions')
      .select('*')
      .eq('trip_id', tripId)
      .order('saved_at', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      // Check if the session has the correct frontend shape:
      // cities must be a non-empty array where items have `dates` (not `arrival_date`)
      const cities = (existing.state as any)?.cities;
      const hasCities = Array.isArray(cities) && cities.length > 0;
      const hasCorrectShape = hasCities && cities[0]?.dates !== undefined;
      if (hasCorrectShape) {
        res.json({ session: existing, role });
        return;
      }
      // Stale or empty session — delete and recreate with fresh data below
      await supabase.from('canvas_sessions').delete().eq('id', existing.id);
    }

    // Create new session with current trip state
    const { data: trip } = await supabase
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .single();

    const { data: cities, error: citiesError } = await supabase
      .from('cities')
      .select('*')
      .eq('trip_id', tripId)
      .order('position', { ascending: true });

    // If the frontend passed cities in the request body (fallback for trips
    // saved before the schema fix), use those instead of the empty DB result.
    const clientCities = req.body?.cities;
    const useClientCities = (!cities || cities.length === 0) && Array.isArray(clientCities) && clientCities.length > 0;

    const { data: transports } = await supabase
      .from('transports')
      .select('*')
      .eq('trip_id', tripId);

    // Transform DB rows back into the frontend City shape
    let frontendCities: any[];

    if (useClientCities) {
      // Client sent cities — could be frontend shape or DB shape
      const isDbShape = clientCities[0]?.arrival_date !== undefined;
      if (isDbShape) {
        // Transform from DB shape
        frontendCities = clientCities.map((c: any, idx: number) => {
          const hotel = c.hotel ?? { name: 'Select hotel', rating: 0, pricePerNight: 0, area: '' };
          return {
            name: c.name,
            country: c.country ?? '',
            dates: { arrival: c.arrival_date ?? '', departure: c.departure_date ?? '' },
            hotel,
            hotels: [hotel],
            selectedHotelIndex: 0,
            activities: c.activities ?? [],
            restaurants: c.restaurants ?? [],
            vibes: [],
            colorIndex: c.color_index ?? idx,
            schedule: c.schedule ?? {},
            transportIn: c.transportIn ?? { mode: 'flight', operator: '', duration: '', price: 0 },
            transportOut: c.transportOut ?? { mode: 'flight', operator: '', duration: '', price: 0 },
          };
        });
      } else {
        // Already in frontend shape
        frontendCities = clientCities;
      }
    } else {
      frontendCities = (cities ?? []).map((c: any, idx: number) => {
        const hotel = c.hotel ?? { name: 'Select hotel', rating: 0, pricePerNight: 0, area: '' };
        return {
          name: c.name,
          country: c.country ?? '',
          dates: { arrival: c.arrival_date ?? '', departure: c.departure_date ?? '' },
          hotel,
          hotels: [hotel],
          selectedHotelIndex: 0,
          activities: c.activities ?? [],
          restaurants: c.restaurants ?? [],
          vibes: [],
          colorIndex: c.color_index ?? idx,
          schedule: c.schedule ?? {},
          transportIn: { mode: 'flight', operator: '', duration: '', price: 0 },
          transportOut: { mode: 'flight', operator: '', duration: '', price: 0 },
        };
      });
    }

    // Attach transport data to the correct city's transportOut
    for (const t of transports ?? []) {
      const fromIdx = frontendCities.findIndex((_: any, i: number) => {
        const cityRow = (cities ?? [])[i];
        return cityRow?.id === t.from_city_id;
      });
      if (fromIdx >= 0) {
        frontendCities[fromIdx].transportOut = {
          mode: t.mode ?? 'flight',
          operator: t.operator ?? '',
          duration: t.duration_minutes ? `${Math.floor(t.duration_minutes / 60)}h ${t.duration_minutes % 60}m` : '',
          price: t.price ?? 0,
          departTime: t.depart_time ?? '',
          arriveTime: t.arrive_time ?? '',
          bookingUrl: t.booking_url ?? '',
        };
      }
      const toIdx = frontendCities.findIndex((_: any, i: number) => {
        const cityRow = (cities ?? [])[i];
        return cityRow?.id === t.to_city_id;
      });
      if (toIdx >= 0) {
        frontendCities[toIdx].transportIn = {
          mode: t.mode ?? 'flight',
          operator: t.operator ?? '',
          duration: t.duration_minutes ? `${Math.floor(t.duration_minutes / 60)}h ${t.duration_minutes % 60}m` : '',
          price: t.price ?? 0,
          departTime: t.depart_time ?? '',
          arriveTime: t.arrive_time ?? '',
          bookingUrl: t.booking_url ?? '',
        };
      }
    }

    const state = {
      trip: { ...trip, title: trip.title, totalCost: trip.total_cost },
      cities: frontendCities,
      transports,
    };
    const { data: session } = await supabase
      .from('canvas_sessions')
      .insert({
        trip_id: tripId,
        state,
        last_saved_by: user.id,
      })
      .select()
      .single();

    res.json({ session, role });
  }),
);

// ─── POST /api/canvas/:tripId/save ──────────────────────────
router.post(
  '/:tripId/save',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    // Editors save too (live collaboration). Suggesters go through the
    // propose/approve flow instead; viewers never write.
    if (role !== 'owner' && role !== 'editor') {
      throw new AppError(403, 'You need edit access to save this trip');
    }

    const { state } = req.body;
    if (!state) throw new AppError(400, 'Canvas state is required');

    const supabase = getSupabase();

    // Update canvas session — find existing and update, or insert new
    const { data: existingSession } = await supabase
      .from('canvas_sessions')
      .select('id')
      .eq('trip_id', tripId)
      .order('saved_at', { ascending: false })
      .limit(1)
      .single();

    if (existingSession) {
      // Update existing session
      await supabase
        .from('canvas_sessions')
        .update({
          state,
          last_saved_by: user.id,
          saved_at: new Date().toISOString(),
        })
        .eq('id', existingSession.id);

      // Clean up any duplicate sessions for this trip
      const { data: allSessions } = await supabase
        .from('canvas_sessions')
        .select('id')
        .eq('trip_id', tripId)
        .neq('id', existingSession.id);
      if (allSessions && allSessions.length > 0) {
        for (const s of allSessions) {
          await supabase.from('canvas_sessions').delete().eq('id', s.id);
        }
      }
    } else {
      await supabase
        .from('canvas_sessions')
        .insert({
          trip_id: tripId,
          state,
          last_saved_by: user.id,
          saved_at: new Date().toISOString(),
        });
    }

    // Apply canvas changes to live trip tables
    if (state.cities && Array.isArray(state.cities)) {
      // Auto-generate activities and restaurants for cities that have none
      for (const city of state.cities) {
        if ((!city.activities || city.activities.length === 0) && city.name) {
          city.activities = [
            `Explore ${city.name} old town`,
            `Local food tour in ${city.name}`,
            `${city.name} main museum`,
            `Walking tour of ${city.name}`,
            `${city.name} scenic viewpoint`,
          ];
        }
        if ((!city.restaurants || city.restaurants.length === 0) && city.name) {
          city.restaurants = [
            { name: `${city.name} neighborhood trattoria`, cuisine: 'Local', priceRange: '$$' },
            { name: `${city.name} casual lunch cafe`, cuisine: 'Cafe', priceRange: '$' },
            { name: `${city.name} fine dining`, cuisine: 'International', priceRange: '$$$' },
            { name: `${city.name} street food market`, cuisine: 'Street Food', priceRange: '$' },
            { name: `${city.name} rooftop bar & grill`, cuisine: 'Bar & Grill', priceRange: '$$' },
          ];
        }
      }

      // Fetch hotels for cities that don't have any
      const hotelPromises: Promise<void>[] = [];
      for (const city of state.cities) {
        const hasHotels = (Array.isArray(city.hotels) && city.hotels.length > 0)
          || (city.hotel && city.hotel.name && city.hotel.name !== 'Select hotel' && city.hotel.pricePerNight > 0);
        if (!hasHotels && city.name && city.dates?.arrival && city.dates?.departure) {
          hotelPromises.push(
            searchHotels({
              city: city.name,
              checkin: city.dates.arrival,
              checkout: city.dates.departure,
              adults: state.trip?.travelers ?? 1,
              rooms: 1,
            })
              .then((results) => {
                if (results.length > 0) {
                  city.hotels = results.map((r) => ({
                    name: r.name,
                    rating: r.rating,
                    pricePerNight: r.pricePerNight,
                    area: '',
                    bookingUrl: r.bookingUrl,
                  }));
                  city.hotel = city.hotels[0];
                  city.selectedHotelIndex = 0;
                  console.log(`[canvas save] Found ${results.length} hotels for ${city.name}`);
                }
              })
              .catch((err) => {
                console.warn(`[canvas save] Hotel search failed for ${city.name}:`, err?.message);
              })
          );
        }
      }
      if (hotelPromises.length > 0) {
        await Promise.all(hotelPromises);
      }

      // Delete ALL existing transports first (they have FK to cities)
      const { data: existingTransports } = await supabase.from('transports').select('id').eq('trip_id', tripId);
      if (existingTransports && existingTransports.length > 0) {
        const transportIds = existingTransports.map((t: any) => t.id);
        await supabase.from('transports').delete().in('id', transportIds);
      }

      // Delete ALL existing cities by ID (bulk .eq delete has row limits)
      const { data: existingCities } = await supabase.from('cities').select('id').eq('trip_id', tripId);
      if (existingCities && existingCities.length > 0) {
        const cityIds = existingCities.map((c: any) => c.id);
        const { error: delErr } = await supabase.from('cities').delete().in('id', cityIds);
        if (delErr) console.error('[canvas save] Failed to delete cities:', delErr.message);
        else console.log('[canvas save] Deleted', cityIds.length, 'existing cities');
      }
      const cityRows = state.cities.map((city: any, idx: number) => ({
        trip_id: tripId,
        name: city.name,
        country: city.country ?? '',
        arrival_date: city.dates?.arrival || null,
        departure_date: city.dates?.departure || null,
        color_index: city.colorIndex ?? idx,
        position: idx,
        // Legacy single hotel column + new ranked list so the user's
        // picked hotel and their other 4 options both survive a save.
        hotel: city.hotel ?? null,
        hotels: Array.isArray(city.hotels) ? city.hotels : (city.hotel ? [city.hotel] : []),
        selected_hotel_index: typeof city.selectedHotelIndex === 'number' ? city.selectedHotelIndex : 0,
        custom_hotel: city.customHotel ?? null,
        vibes: Array.isArray(city.vibes) ? city.vibes : [],
        activities: city.activities ?? [],
        restaurants: city.restaurants ?? [],
        schedule: city.schedule ?? {},
      }));
      let insertedCities: any[] = [];
      if (cityRows.length > 0) {
        const { data, error: citiesErr } = await supabase.from('cities').insert(cityRows).select();
        if (citiesErr) {
          console.error('[canvas save] Failed to insert cities:', citiesErr.message);
        }
        insertedCities = data ?? [];
        console.log('[canvas save] Inserted', insertedCities.length, 'cities for trip', tripId);
      }

      // Rebuild transports (already deleted above)
      if (insertedCities.length > 1) {
        // For consecutive city pairs missing transport, auto-compare flights vs trains
        const updatedCities = [...state.cities];
        const comparePromises: Promise<void>[] = [];

        for (let i = 0; i < updatedCities.length - 1; i++) {
          const t = updatedCities[i].transportOut;
          // Re-compare if: no transport, price is 0, or the destination changed
          const currentTo = t?.to ?? '';
          const expectedTo = updatedCities[i + 1]?.name ?? '';
          const needsCompare = !t || t.price <= 0 || (currentTo && expectedTo && currentTo.toLowerCase() !== expectedTo.toLowerCase());
          if (needsCompare) {
            const origin = updatedCities[i].name;
            const dest = updatedCities[i + 1].name;
            const date = updatedCities[i].dates?.departure
              || updatedCities[i + 1].dates?.arrival
              || new Date().toISOString().split('T')[0];
            const idx = i;
            comparePromises.push(
              compareLeg({ origin, destination: dest, date, travelers: 1 })
                .then((result) => {
                  const best = result.recommendation === 'train' && result.trainOption
                    ? { mode: 'train' as const, price: result.trainOption.price ?? 0, duration: result.trainOption.durationMinutes, operator: result.trainOption.operator ?? '' }
                    : result.flightOption
                      ? { mode: 'flight' as const, price: result.flightOption.price ?? 0, duration: result.flightOption.durationMinutes, operator: result.flightOption.carrier ?? '' }
                      : null;
                  if (best) {
                    updatedCities[idx].transportOut = {
                      mode: best.mode,
                      price: best.price,
                      duration: `${Math.floor(best.duration / 60)}h ${best.duration % 60}m`,
                      operator: best.operator,
                      from: origin,
                      to: dest,
                    };
                  }
                })
                .catch(() => {})
            );
          }
        }

        // Wait for all transport comparisons to finish
        if (comparePromises.length > 0) {
          await Promise.all(comparePromises);
          // Update canvas session state with the new transport data
          state.cities = updatedCities;
          await supabase
            .from('canvas_sessions')
            .update({ state, saved_at: new Date().toISOString() })
            .eq('trip_id', tripId);
        }

        const transportRows: any[] = [];
        for (let i = 0; i < insertedCities.length - 1; i++) {
          const city = updatedCities[i];
          const t = city.transportOut;
          if (t && t.price > 0) {
            transportRows.push({
              trip_id: tripId,
              from_city_id: insertedCities[i].id,
              to_city_id: insertedCities[i + 1].id,
              mode: t.mode ?? 'flight',
              operator: t.operator ?? '',
              price: t.price ?? 0,
              // parseDurationMinutes handles "3h 37m" → 217 etc. The old
              // parseInt("3h 37m") returned 3, which is why durations
              // on saved trips showed as single-digit minutes.
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
            console.error('[canvas save] Failed to insert transports:', transportError.message, {
              sample: transportRows[0],
            });
          }
        }
      }
    }

    // Update trip metadata
    const totalCost = (state.cities ?? []).reduce((sum: number, c: any) => {
      const hotelCost = (c.hotel?.pricePerNight ?? 0) * (
        c.dates?.arrival && c.dates?.departure
          ? Math.max(1, Math.round((new Date(c.dates.departure).getTime() - new Date(c.dates.arrival).getTime()) / 86400000))
          : 1
      );
      const transportCost = c.transportOut?.price ?? 0;
      return sum + hotelCost + transportCost;
    }, 0);

    const tripUpdate: Record<string, any> = {
      title: (state.cities ?? []).map((c: any) => c.name).join(' · '),
      total_cost: totalCost,
      updated_at: new Date().toISOString(),
    };
    // Persist home-anchor edits made on the canvas (city/airport changes
    // on the home cards) so the results page and history — which read the
    // trips table, not the canvas session — agree.
    if (state.trip?.origin?.city) {
      tripUpdate.origin_city = state.trip.origin.city;
      tripUpdate.origin_airports = Array.isArray(state.trip.origin.airports)
        ? state.trip.origin.airports
        : [];
      tripUpdate.return_to_home =
        typeof state.trip.returnToHome === 'boolean' ? state.trip.returnToHome : true;
      // Home legs can be re-searched on the canvas — persist them so the
      // results flowchart shows the same flights.
      tripUpdate.outbound_leg = state.trip.origin.outboundLeg ?? null;
      tripUpdate.return_leg = state.trip.origin.returnLeg ?? null;
      // Independent back-home overrides (open-jaw). Only written when the
      // user actually customized the back-home card, so pre-migration DBs
      // aren't touched by trips that never use the feature.
      if (state.trip.origin.returnCity) {
        tripUpdate.return_city = state.trip.origin.returnCity;
      }
      if (Array.isArray(state.trip.origin.returnAirports)) {
        tripUpdate.return_airports = state.trip.origin.returnAirports;
      }
    }

    const { error: tripUpdateError } = await supabase
      .from('trips')
      .update(tripUpdate)
      .eq('id', tripId);

    // Migration 003 not applied yet — retry without the return-anchor
    // columns so the rest of the trip metadata still saves.
    if (tripUpdateError && /return_(city|airports)/.test(tripUpdateError.message ?? '')) {
      console.warn(
        '[canvas save] return_city/return_airports columns missing — run supabase/migrations/003_return_home_anchor.sql',
      );
      delete tripUpdate.return_city;
      delete tripUpdate.return_airports;
      await supabase.from('trips').update(tripUpdate).eq('id', tripId);
    }

    res.json({ saved: true, savedAt: new Date().toISOString() });
  }),
);

// ─── GET /api/canvas/:tripId/suggestions ─────────────────────
router.get(
  '/:tripId/suggestions',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    if (!role) throw new AppError(403, 'Not a member of this trip');

    const supabase = getSupabase();
    const { data } = await supabase
      .from('canvas_suggestions')
      .select('*')
      .eq('trip_id', tripId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    res.json({ suggestions: data ?? [] });
  }),
);

// ─── POST /api/canvas/:tripId/suggestions ────────────────────
const suggestionSchema = z.object({
  type: z.enum(['add_city', 'comment', 'reaction', 'edit']),
  payload: z.any(),
});

router.post(
  '/:tripId/suggestions',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    if (!role || role === 'viewer') {
      throw new AppError(403, 'Viewers cannot submit suggestions');
    }

    const { type, payload } = suggestionSchema.parse(req.body);
    const supabase = getSupabase();

    const { data } = await supabase
      .from('canvas_suggestions')
      .insert({
        trip_id: tripId,
        suggested_by: user.id,
        type,
        payload,
        status: 'pending',
      })
      .select()
      .single();

    res.status(201).json({ suggestion: data });
  }),
);

// ─── PATCH /api/canvas/:tripId/suggestions/:suggestionId ─────
const patchSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

router.patch(
  '/:tripId/suggestions/:suggestionId',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const suggestionId = req.params.suggestionId as string;
    const role = await getMemberRole(tripId, user.id);
    if (role !== 'owner') throw new AppError(403, 'Only the trip owner can approve/reject');

    const { status } = patchSchema.parse(req.body);
    const supabase = getSupabase();

    const { data: suggestion } = await supabase
      .from('canvas_suggestions')
      .update({ status })
      .eq('id', suggestionId)
      .eq('trip_id', tripId)
      .select()
      .single();

    // If approved add_city, add to canvas state
    if (status === 'approved' && suggestion?.type === 'add_city') {
      const { data: session } = await supabase
        .from('canvas_sessions')
        .select('state')
        .eq('trip_id', tripId)
        .order('saved_at', { ascending: false })
        .limit(1)
        .single();

      if (session?.state) {
        const cities = (session.state as any).cities ?? [];
        cities.push(suggestion.payload);
        await supabase
          .from('canvas_sessions')
          .update({ state: { ...session.state, cities } })
          .eq('trip_id', tripId);
      }
    }

    res.json({ suggestion });
  }),
);

// ─── POST /api/canvas/:tripId/invite ─────────────────────────
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['editor', 'suggester', 'viewer']),
});

router.post(
  '/:tripId/invite',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');

    const tripId = req.params.tripId as string;
    const memberRole = await getMemberRole(tripId, user.id);
    if (memberRole !== 'owner') throw new AppError(403, 'Only the trip owner can invite');

    const { email, role } = inviteSchema.parse(req.body);
    const supabase = getSupabase();

    const { data } = await supabase
      .from('group_members')
      .insert({
        trip_id: tripId,
        invited_email: email,
        role,
      })
      .select()
      .single();

    const inviteLink = `${env.FRONTEND_URL}/canvas/join/${data?.invite_token}`;
    res.status(201).json({ member: data, inviteLink });
  }),
);

// ─── GET /api/canvas/join/:token ─────────────────────────────
router.get(
  '/join/:token',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    const { token } = req.params;
    const supabase = getSupabase();

    const { data: member } = await supabase
      .from('group_members')
      .select('*, trip_id')
      .eq('invite_token', token)
      .single();

    if (!member) throw new AppError(404, 'Invalid invite link');

    // Link user if authenticated
    if (user && !member.accepted_at) {
      await supabase
        .from('group_members')
        .update({
          user_id: user.id,
          accepted_at: new Date().toISOString(),
        })
        .eq('id', member.id);
    }

    res.redirect(`${env.FRONTEND_URL}/results?trip=${member.trip_id}&canvas=true`);
  }),
);

// ─── GET /api/canvas/:tripId/members ─────────────────────────
// List all collaborators on a trip, enriched with email + display
// name + avatar so the frontend can actually render a member list
// (transfer-ownership picker, canvas presence chips, etc.). Readable
// by any group member.
//
// Enrichment strategy: for each row that has a `user_id` (accepted
// invites), batch-lookup auth.users (for email) + user_profiles (for
// name + avatar). Rows that are still pending invites (no user_id yet)
// just expose `invited_email` — there's no accepted user to enrich.
router.get(
  '/:tripId/members',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');
    const tripId = req.params.tripId as string;
    const role = await getMemberRole(tripId, user.id);
    if (!role) throw new AppError(403, 'Not a member of this trip');

    const supabase = getSupabase();
    const { data: rows } = await supabase
      .from('group_members')
      .select('id, user_id, invited_email, role, accepted_at, created_at')
      .eq('trip_id', tripId)
      .order('created_at', { ascending: true });

    const members = rows ?? [];
    const userIds = Array.from(
      new Set(members.map((m: any) => m.user_id).filter(Boolean) as string[]),
    );

    // Batch-fetch profile rows in a single query. Service-role has
    // access regardless of RLS, so we get email/name for anyone on
    // the trip without per-row round-trips.
    let profilesById: Record<string, { fullName: string | null; avatarUrl: string | null }> = {};
    let emailsById: Record<string, string | null> = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, full_name, avatar_url')
        .in('id', userIds);
      for (const p of profiles ?? []) {
        profilesById[p.id] = { fullName: p.full_name ?? null, avatarUrl: p.avatar_url ?? null };
      }

      // auth.users is only accessible via the admin API, not a normal
      // query — iterate getUserById for each member. Cheap: typical
      // trip has <10 collaborators, and each call is a single
      // indexed lookup on the service side.
      await Promise.all(
        userIds.map(async (uid) => {
          const { data } = await supabase.auth.admin.getUserById(uid);
          emailsById[uid] = data?.user?.email ?? null;
        }),
      );
    }

    const enriched = members.map((m: any) => {
      const profile = m.user_id ? profilesById[m.user_id] : undefined;
      return {
        id: m.id,
        userId: m.user_id,
        role: m.role,
        acceptedAt: m.accepted_at,
        createdAt: m.created_at,
        // For pending invites (no user_id yet) expose invited_email only.
        // For accepted members expose their real auth.users email.
        email: m.user_id ? emailsById[m.user_id] ?? null : m.invited_email ?? null,
        fullName: profile?.fullName ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        pending: !m.accepted_at,
      };
    });

    res.json({ members: enriched });
  }),
);

// ─── PATCH /api/canvas/:tripId/members/:memberId ─────────────
// Owner-only: change a collaborator's role (e.g. promote viewer → editor).
const patchMemberSchema = z.object({
  role: z.enum(['editor', 'suggester', 'viewer']),
});

router.patch(
  '/:tripId/members/:memberId',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');
    const { tripId, memberId } = req.params as { tripId: string; memberId: string };
    const role = await getMemberRole(tripId, user.id);
    if (role !== 'owner') throw new AppError(403, 'Only the trip owner can change member roles');

    const body = patchMemberSchema.parse(req.body);
    const supabase = getSupabase();

    // Safety: don't let the owner accidentally demote themselves through
    // this endpoint. They'd lose owner access with no way to restore it.
    const { data: target } = await supabase
      .from('group_members')
      .select('role, user_id')
      .eq('id', memberId)
      .eq('trip_id', tripId)
      .single();
    if (!target) throw new AppError(404, 'Member not found');
    if (target.role === 'owner') {
      throw new AppError(400, 'Cannot change the owner role; transfer ownership first');
    }

    const { data, error } = await supabase
      .from('group_members')
      .update({ role: body.role })
      .eq('id', memberId)
      .eq('trip_id', tripId)
      .select()
      .single();
    if (error) throw new AppError(500, error.message);

    res.json({ member: data });
  }),
);

// ─── DELETE /api/canvas/:tripId/members/:memberId ────────────
// Remove a collaborator. Owner can remove anyone (except themselves).
// A collaborator can also remove themselves (equivalent to "leave trip").
router.delete(
  '/:tripId/members/:memberId',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');
    const { tripId, memberId } = req.params as { tripId: string; memberId: string };
    const supabase = getSupabase();

    const { data: target } = await supabase
      .from('group_members')
      .select('user_id, role')
      .eq('id', memberId)
      .eq('trip_id', tripId)
      .single();
    if (!target) throw new AppError(404, 'Member not found');

    const requesterRole = await getMemberRole(tripId, user.id);
    const removingSelf = target.user_id === user.id;

    // Allowed: owner removing anyone (except themselves) OR user removing themselves.
    if (!removingSelf && requesterRole !== 'owner') {
      throw new AppError(403, 'Only the owner can remove other members');
    }
    if (removingSelf && target.role === 'owner') {
      throw new AppError(400, "Owner can't leave their own trip; transfer ownership or delete the trip instead");
    }

    const { error } = await supabase
      .from('group_members')
      .delete()
      .eq('id', memberId)
      .eq('trip_id', tripId);
    if (error) throw new AppError(500, error.message);

    res.json({ success: true });
  }),
);


// ─── Share link ──────────────────────────────────────────────
// One link per trip, backed by share_token/share_mode on the trip's
// canvas session. Joining maps the mode to a membership role:
const SHARE_MODE_TO_ROLE: Record<string, string> = {
  view: 'viewer',
  suggest: 'suggester',
  edit: 'editor',
};
const ROLE_RANK: Record<string, number> = { viewer: 0, suggester: 1, editor: 2, owner: 3 };

/** Latest canvas session for a trip, creating an empty one if missing
 *  (the share dialog can be opened before anything was ever saved). */
async function findOrCreateSession(tripId: string) {
  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('canvas_sessions')
    .select('id, share_mode, share_token')
    .eq('trip_id', tripId)
    .order('saved_at', { ascending: false })
    .limit(1)
    .single();
  if (existing) return existing;
  const { data: created, error } = await supabase
    .from('canvas_sessions')
    .insert({ trip_id: tripId, state: {} })
    .select('id, share_mode, share_token')
    .single();
  if (error || !created) throw new AppError(500, 'Could not create canvas session');
  return created;
}

const shareUrl = (tripId: string, token: string) =>
  `${env.FRONTEND_URL}/canvas/${tripId}?share=${token}`;

// ─── GET /api/canvas/:tripId/share ───────────────────────────
// Owner-only: current share link + mode.
router.get(
  '/:tripId/share',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');
    const tripId = req.params.tripId as string;
    if ((await getMemberRole(tripId, user.id)) !== 'owner') {
      throw new AppError(403, 'Only the trip owner can manage sharing');
    }
    const session = await findOrCreateSession(tripId);
    res.json({ mode: session.share_mode, url: shareUrl(tripId, session.share_token) });
  }),
);

// ─── PATCH /api/canvas/:tripId/share ─────────────────────────
// Owner-only: change the link's mode and/or rotate the token
// (rotation invalidates every previously shared copy of the link).
const sharePatchSchema = z.object({
  mode: z.enum(['view', 'suggest', 'edit']).optional(),
  rotate: z.boolean().optional(),
});
router.patch(
  '/:tripId/share',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');
    const tripId = req.params.tripId as string;
    if ((await getMemberRole(tripId, user.id)) !== 'owner') {
      throw new AppError(403, 'Only the trip owner can manage sharing');
    }
    const { mode, rotate } = sharePatchSchema.parse(req.body);
    const session = await findOrCreateSession(tripId);

    const update: Record<string, unknown> = {};
    if (mode) update.share_mode = mode;
    if (rotate) update.share_token = crypto.randomUUID();
    if (Object.keys(update).length === 0) {
      res.json({ mode: session.share_mode, url: shareUrl(tripId, session.share_token) });
      return;
    }
    const supabase = getSupabase();
    const { data: updated, error } = await supabase
      .from('canvas_sessions')
      .update(update)
      .eq('id', session.id)
      .select('share_mode, share_token')
      .single();
    if (error || !updated) throw new AppError(500, 'Could not update share settings');
    res.json({ mode: updated.share_mode, url: shareUrl(tripId, updated.share_token) });
  }),
);

// ─── POST /api/canvas/:tripId/join-link ──────────────────────
// Signed-in user opens a share link: validate the token against the
// trip's session and upsert a membership at the mode's role. Existing
// members are never DOWNGRADED by a link (the owner may have set them
// a better role individually); they're upgraded if the link grants more.
const joinLinkSchema = z.object({ token: z.string().uuid() });
router.post(
  '/:tripId/join-link',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Sign in to join this trip');
    const tripId = req.params.tripId as string;
    const { token } = joinLinkSchema.parse(req.body);
    const supabase = getSupabase();

    const { data: session } = await supabase
      .from('canvas_sessions')
      .select('share_token, share_mode')
      .eq('trip_id', tripId)
      .order('saved_at', { ascending: false })
      .limit(1)
      .single();
    if (!session || session.share_token !== token) {
      throw new AppError(404, 'This share link is invalid or has been reset');
    }

    const linkRole = SHARE_MODE_TO_ROLE[session.share_mode] ?? 'viewer';
    const existingRole = await getMemberRole(tripId, user.id);

    if (existingRole === 'owner') {
      res.json({ role: 'owner', joined: false });
      return;
    }
    if (existingRole && ROLE_RANK[existingRole] >= ROLE_RANK[linkRole]) {
      res.json({ role: existingRole, joined: false });
      return;
    }
    if (existingRole) {
      // Upgrade the existing membership to the link's role.
      await supabase
        .from('group_members')
        .update({ role: linkRole })
        .eq('trip_id', tripId)
        .eq('user_id', user.id);
    } else {
      await supabase.from('group_members').insert({
        trip_id: tripId,
        user_id: user.id,
        invited_email: user.email ?? null,
        role: linkRole,
        accepted_at: new Date().toISOString(),
      });
    }
    res.json({ role: linkRole, joined: true });
  }),
);

// ─── PATCH /api/canvas/:tripId/members/apply-role ────────────
// Owner-only bulk update: set every collaborator (accepted or pending)
// to the given role — the "give everyone full access" one-click.
const applyRoleSchema = z.object({ role: z.enum(['editor', 'suggester', 'viewer']) });
router.patch(
  '/:tripId/members/apply-role',
  asyncHandler(async (req, res) => {
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) throw new AppError(401, 'Authentication required');
    const tripId = req.params.tripId as string;
    if ((await getMemberRole(tripId, user.id)) !== 'owner') {
      throw new AppError(403, 'Only the trip owner can change roles');
    }
    const { role } = applyRoleSchema.parse(req.body);
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('group_members')
      .update({ role })
      .eq('trip_id', tripId)
      .select('id');
    if (error) throw new AppError(500, 'Could not update member roles');
    res.json({ updated: data?.length ?? 0, role });
  }),
);

export default router;
