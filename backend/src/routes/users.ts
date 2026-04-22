import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { getSupabase } from '../services/supabase';
import { AppError } from '../middleware/error';

const router = Router();

/**
 * User profile CRUD. Backed by:
 *   - auth.users (Supabase-managed) — email, created_at, etc.
 *   - public.user_profiles (our table) — full_name, avatar_url,
 *     preferences, stripe ids, is_premium.
 *
 * The `handle_new_user()` trigger auto-creates the user_profiles row
 * when someone signs up. This router only reads/updates existing rows.
 */

// ─── GET /api/users/me ───────────────────────────────────────
// Returns the authenticated user's combined profile (auth + public).
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    // Fetch the profile row. If the trigger didn't fire for some reason
    // (legacy user, migration gap, etc.), lazily create the row so GET
    // always succeeds rather than 404-ing on an older account.
    let { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!profile) {
      const { data: inserted } = await supabase
        .from('user_profiles')
        .insert({
          id: user.id,
          full_name: user.user_metadata?.full_name ?? null,
        })
        .select()
        .single();
      profile = inserted;
    }

    // Derive the current lifecycle state from the two timestamps the
    // cron job + delete endpoint flip:
    //   anonymized_at → 'anonymized' (irreversible, PII cleared)
    //   deleted_at    → 'pending_deletion' (grace period, reversible via
    //                    POST /api/users/me/cancel-deletion)
    //   neither       → 'active'
    // scheduledDeletionAt is deleted_at + 30 days so the UI can show
    // "Your account will be deleted on X" without hard-coding the window.
    let accountStatus: 'active' | 'pending_deletion' | 'anonymized' = 'active';
    let scheduledDeletionAt: string | null = null;
    if (profile?.anonymized_at) {
      accountStatus = 'anonymized';
    } else if (profile?.deleted_at) {
      accountStatus = 'pending_deletion';
      const d = new Date(profile.deleted_at);
      d.setDate(d.getDate() + 30);
      scheduledDeletionAt = d.toISOString();
    }

    res.json({
      id: user.id,
      email: user.email,
      emailConfirmed: !!user.email_confirmed_at,
      createdAt: user.created_at,
      fullName: profile?.full_name ?? user.user_metadata?.full_name ?? null,
      avatarUrl: profile?.avatar_url ?? null,
      isPremium: profile?.is_premium ?? false,
      preferences: profile?.preferences ?? {},
      accountStatus,
      scheduledDeletionAt,
    });
  }),
);

// ─── PATCH /api/users/me ─────────────────────────────────────
// Partial update of the user's profile. Only fields the client sends
// are updated. Email changes go through Supabase (requires verification);
// password changes go through Supabase (/auth/v1/user with new password).
const updateProfileSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  preferences: z
    .object({
      homeAirport: z.string().optional(),
      homeCity: z.string().optional(),
      preferredCurrency: z.string().length(3).optional(),
      defaultTravelers: z.number().int().positive().optional(),
      emailNotifications: z.boolean().optional(),
    })
    .partial()
    .optional(),
});

router.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const body = updateProfileSchema.parse(req.body);
    const supabase = getSupabase();

    // Build a sparse update object — only touch columns the client
    // actually sent, so we don't accidentally reset avatar_url to null
    // when the client is only updating full_name.
    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.fullName !== undefined) update.full_name = body.fullName;
    if (body.avatarUrl !== undefined) update.avatar_url = body.avatarUrl;
    if (body.preferences !== undefined) {
      // Merge on top of existing preferences so a partial update doesn't
      // wipe unrelated keys. Fetch current row first.
      const { data: current } = await supabase
        .from('user_profiles')
        .select('preferences')
        .eq('id', user.id)
        .single();
      const merged = { ...(current?.preferences ?? {}), ...body.preferences };
      update.preferences = merged;
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .update(update)
      .eq('id', user.id)
      .select()
      .single();

    if (error) {
      throw new AppError(500, error.message);
    }

    res.json({
      id: user.id,
      email: user.email,
      fullName: data?.full_name,
      avatarUrl: data?.avatar_url,
      isPremium: data?.is_premium ?? false,
      preferences: data?.preferences ?? {},
    });
  }),
);

// ─── DELETE /api/users/me ────────────────────────────────────
// Soft-delete — flag the account for deletion 30 days from now.
//
// Why not hard-delete: trip patterns (cities visited, budget vs. vibe,
// optimizer route orderings) are the product's long-term recommendation
// fuel. A hard delete nukes those learnings alongside the PII. Instead:
//
//   1. Set user_profiles.deleted_at = now()  ← reversible for 30 days.
//      During the grace period the account still exists but callers
//      should treat it as deactivated (frontend hides nav, shows
//      "Account scheduled for deletion" banner).
//   2. A daily pg_cron job (`anonymize_expired_deletions`) runs at
//      03:00 UTC and:
//        - clears email/password/metadata from auth.users
//        - bans the row (banned_until = infinity) so login is impossible
//        - drops auth.identities (so re-signup with same Google account
//          goes to a fresh user)
//        - clears PII from user_profiles but KEEPS the row so trips
//          still FK to a valid (anonymous) owner.
//
// Trips, cities, transports stay intact under the anonymous user_id.
// Collaborators on those trips can still read them (and optionally
// clone — handled by a future notification flow).
//
// Reactivation path: POST /api/users/me/cancel-deletion within 30 days.
const deleteUserSchema = z.object({
  reason: z.string().max(500).optional(),
});

router.delete(
  '/me',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const body = deleteUserSchema.parse(req.body ?? {});
    const supabase = getSupabase();

    // Don't re-flag an account that's already pending deletion — keep
    // the ORIGINAL deleted_at so the user doesn't inadvertently extend
    // their own grace period by re-submitting.
    const { data: existing } = await supabase
      .from('user_profiles')
      .select('deleted_at, anonymized_at')
      .eq('id', user.id)
      .single();

    if (existing?.anonymized_at) {
      throw new AppError(410, 'Account has already been anonymized');
    }

    if (existing?.deleted_at) {
      const scheduled = new Date(existing.deleted_at);
      scheduled.setDate(scheduled.getDate() + 30);
      res.json({
        success: true,
        accountStatus: 'pending_deletion',
        deletedAt: existing.deleted_at,
        scheduledDeletionAt: scheduled.toISOString(),
        alreadyScheduled: true,
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('user_profiles')
      .update({
        deleted_at: nowIso,
        deletion_reason: body.reason ?? null,
        updated_at: nowIso,
      })
      .eq('id', user.id);

    if (error) {
      throw new AppError(500, `Failed to schedule deletion: ${error.message}`);
    }

    const scheduled = new Date(nowIso);
    scheduled.setDate(scheduled.getDate() + 30);

    res.json({
      success: true,
      accountStatus: 'pending_deletion',
      deletedAt: nowIso,
      scheduledDeletionAt: scheduled.toISOString(),
      alreadyScheduled: false,
    });
  }),
);

// ─── POST /api/users/me/cancel-deletion ──────────────────────
// User changed their mind during the 30-day grace period. Clear the
// deleted_at flag and they're back to 'active'. Once anonymized_at is
// set, though, there's no coming back — PII is already gone.
router.post(
  '/me/cancel-deletion',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('deleted_at, anonymized_at')
      .eq('id', user.id)
      .single();

    if (!profile) {
      throw new AppError(404, 'Profile not found');
    }
    if (profile.anonymized_at) {
      // Past the point of no return — PII is already scrubbed.
      throw new AppError(410, 'Account has already been anonymized and cannot be recovered');
    }
    if (!profile.deleted_at) {
      // Not scheduled for deletion — no-op is fine; return current state.
      res.json({ success: true, accountStatus: 'active', wasScheduled: false });
      return;
    }

    const { error } = await supabase
      .from('user_profiles')
      .update({
        deleted_at: null,
        deletion_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (error) {
      throw new AppError(500, `Failed to cancel deletion: ${error.message}`);
    }

    res.json({ success: true, accountStatus: 'active', wasScheduled: true });
  }),
);

// ─── GET /api/users/me/export ────────────────────────────────
// GDPR "right of access" dump — everything we have about this user, as
// one JSON blob. Intended to be saved to disk by the client. Includes:
//   - auth/profile basics
//   - every trip they own (with cities + transports nested)
//   - every trip they collaborate on (metadata only, not full itinerary —
//     the owner is the data controller for those)
//   - canvas suggestions they authored
// We explicitly DO NOT include other users' PII (collaborator emails,
// etc.) so the export can be safely shared.
router.get(
  '/me/export',
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const supabase = getSupabase();

    const [
      { data: profile },
      { data: ownedTrips },
      { data: memberships },
      { data: suggestions },
    ] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('id', user.id).single(),
      supabase.from('trips').select('*').eq('user_id', user.id),
      supabase
        .from('group_members')
        .select('id, trip_id, role, accepted_at, invited_at')
        .eq('user_id', user.id),
      supabase
        .from('canvas_suggestions')
        .select('*')
        .eq('suggested_by', user.id),
    ]);

    // Enrich owned trips with their cities + transports so the export
    // is self-contained (user can reconstruct an itinerary from the JSON
    // without any other API calls).
    const ownedTripIds = (ownedTrips ?? []).map((t: any) => t.id);
    const [{ data: cities }, { data: transports }] = await Promise.all([
      ownedTripIds.length > 0
        ? supabase.from('cities').select('*').in('trip_id', ownedTripIds)
        : Promise.resolve({ data: [] as any[] }),
      ownedTripIds.length > 0
        ? supabase.from('transports').select('*').in('trip_id', ownedTripIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const citiesByTrip: Record<string, any[]> = {};
    for (const c of cities ?? []) {
      (citiesByTrip[c.trip_id] ||= []).push(c);
    }
    const transportsByTrip: Record<string, any[]> = {};
    for (const t of transports ?? []) {
      (transportsByTrip[t.trip_id] ||= []).push(t);
    }

    const trips = (ownedTrips ?? []).map((t: any) => ({
      ...t,
      cities: citiesByTrip[t.id] ?? [],
      transports: transportsByTrip[t.id] ?? [],
    }));

    const payload = {
      exportedAt: new Date().toISOString(),
      exportVersion: 1,
      user: {
        id: user.id,
        email: user.email,
        emailConfirmedAt: user.email_confirmed_at ?? null,
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at ?? null,
      },
      profile: profile ?? null,
      trips,
      // Collaborator memberships include trip_id + role only; full itineraries
      // for trips owned by OTHER users are that owner's data to export.
      collaborations: memberships ?? [],
      canvasSuggestions: suggestions ?? [],
    };

    // Hint the browser to download rather than display — the Settings
    // page can fetch this URL via an <a download> link.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="voyza-export-${user.id}.json"`,
    );
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(payload, null, 2));
  }),
);

export default router;
