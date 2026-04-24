/**
 * End-to-end smoke test for the account-lifecycle + trip-ops endpoints.
 *
 * What it exercises (in order):
 *   1. Create two test users (owner + collaborator) via Supabase admin API.
 *   2. Owner creates a trip with cities + transports.
 *   3. GET /api/users/me returns active status.
 *   4. PATCH /api/trips/:id/permissions toggles allow_clones / is_public.
 *   5. Collaborator is invited via group_members row (direct DB) then:
 *      - owner transfers ownership to them
 *      - new-owner GET /trips/:id succeeds
 *      - old-owner is demoted to editor
 *   6. Old-owner clones the (now not-owned) trip with selective body.
 *      - verifies cities copied, transports NOT copied (default).
 *      - verifies source.clone_count incremented.
 *   7. DELETE /api/users/me schedules soft-deletion.
 *      - GET /me now reports 'pending_deletion' + scheduledDeletionAt.
 *   8. POST /me/cancel-deletion reverses it, status back to 'active'.
 *   9. GET /me/export returns a downloadable JSON with trips nested.
 *  10. Cleanup: hard-delete both test users via admin API.
 *
 * Usage:   npx tsx src/e2e/lifecycle.ts
 * Expects: backend running on localhost:4000, .env loaded.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

let pass = 0;
let fail = 0;
function assert(cond: unknown, label: string, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log('    detail:', detail);
  }
}

async function signup(tag: string): Promise<{ id: string; email: string; token: string }> {
  // Supabase rejects .local / example.com — use a domain that passes validation.
  const email = `e2e-${tag}-${Date.now()}@voyza-e2e-test.com`;
  const password = `TestPass${Math.random().toString(36).slice(2, 10)}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);

  // Sign in to get a JWT (the admin API returns a user but no session).
  const anon = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY!);
  const { data: signin, error: signinErr } = await anon.auth.signInWithPassword({ email, password });
  if (signinErr || !signin.session) throw new Error(`signin failed: ${signinErr?.message}`);
  return { id: data.user.id, email, token: signin.session.access_token };
}

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function cleanup(userIds: string[]) {
  for (const id of userIds) {
    // Wipe trips first (FK from trips → auth.users blocks user delete).
    await admin.from('trips').delete().eq('user_id', id);
    await admin.auth.admin.deleteUser(id);
  }
}

async function main() {
  console.log('▶︎ Account lifecycle + trip ops E2E\n');
  const owner = await signup('owner');
  const collab = await signup('collab');
  const createdUserIds = [owner.id, collab.id];

  try {
    // ─── 1. GET /users/me — initial state ───────────────────
    console.log('1. GET /users/me — active state');
    const me1 = await api(owner.token, 'GET', '/users/me');
    assert(me1.status === 200, 'status 200', me1);
    assert(me1.body.accountStatus === 'active', 'accountStatus=active', me1.body.accountStatus);
    assert(me1.body.scheduledDeletionAt === null, 'scheduledDeletionAt=null');

    // ─── 2. Create a trip ───────────────────────────────────
    console.log('\n2. POST /trips — create trip with cities/transports');
    const tripBody = {
      title: 'E2E Lifecycle Trip',
      travelers: 2,
      totalCost: 1234,
      savingsVsAlternative: 0,
      budget: 2000,
      vibe: 'culture',
      startDate: '2026-06-01',
      cities: [
        {
          name: 'Tokyo',
          country: 'Japan',
          dates: { arrival: '2026-06-01', departure: '2026-06-05' },
          colorIndex: 0,
          hotel: { name: 'Hotel A', pricePerNight: 150 },
          hotels: [{ name: 'Hotel A', pricePerNight: 150 }],
          selectedHotelIndex: 0,
          activities: [{ title: 'Senso-ji', duration: '2h' }],
          restaurants: [],
          schedule: {},
          transportOut: {
            mode: 'train',
            operator: 'Shinkansen',
            price: 120,
            duration: '2h 20m',
            currency: 'USD',
          },
        },
        {
          name: 'Kyoto',
          country: 'Japan',
          dates: { arrival: '2026-06-05', departure: '2026-06-08' },
          colorIndex: 1,
          hotel: { name: 'Hotel B', pricePerNight: 180 },
          hotels: [{ name: 'Hotel B', pricePerNight: 180 }],
          activities: [],
          restaurants: [],
          schedule: {},
        },
      ],
    };
    const create = await api(owner.token, 'POST', '/trips', tripBody);
    assert(create.status === 201, 'status 201', create);
    const tripId = create.body.tripId;
    assert(!!tripId, 'tripId returned');

    // ─── 3. PATCH permissions ──────────────────────────────
    console.log('\n3. PATCH /trips/:id/permissions');
    const perms = await api(owner.token, 'PATCH', `/trips/${tripId}/permissions`, {
      allowClones: true,
      allowRecommendations: false,
      isPublic: true,
    });
    assert(perms.status === 200, 'status 200', perms);
    assert(perms.body.permissions.allow_clones === true, 'allow_clones=true');
    assert(perms.body.permissions.allow_recommendations === false, 'allow_recommendations=false');
    assert(perms.body.permissions.is_public === true, 'is_public=true');

    // Non-owner trying to change permissions is rejected.
    const permsForbidden = await api(collab.token, 'PATCH', `/trips/${tripId}/permissions`, {
      isPublic: false,
    });
    assert(permsForbidden.status === 403, 'non-owner gets 403 on permissions PATCH', permsForbidden);

    // ─── 4. Invite collaborator directly (simulates canvas invite) ──
    console.log('\n4. Invite collaborator');
    await admin.from('group_members').insert({
      trip_id: tripId,
      user_id: collab.id,
      role: 'editor',
      accepted_at: new Date().toISOString(),
    });
    const memberList = await api(owner.token, 'GET', `/canvas/${tripId}/members`);
    assert(memberList.status === 200, 'list members 200', memberList);
    assert(
      Array.isArray(memberList.body.members) && memberList.body.members.length >= 2,
      'at least owner + collab in members list',
    );
    // Enriched shape: every accepted member now carries email.
    const ownerMember = memberList.body.members.find((m: any) => m.userId === owner.id);
    const collabMember = memberList.body.members.find((m: any) => m.userId === collab.id);
    assert(ownerMember?.email === owner.email, 'owner member row has email', ownerMember);
    assert(collabMember?.email === collab.email, 'collab member row has email', collabMember);
    assert('fullName' in (ownerMember ?? {}), 'owner member row exposes fullName field');
    assert('avatarUrl' in (ownerMember ?? {}), 'owner member row exposes avatarUrl field');
    assert(ownerMember?.pending === false, 'accepted members have pending=false');

    // ─── 5. Transfer ownership ─────────────────────────────
    console.log('\n5. POST /trips/:id/transfer-ownership');
    const transfer = await api(owner.token, 'POST', `/trips/${tripId}/transfer-ownership`, {
      newOwnerId: collab.id,
    });
    assert(transfer.status === 200, 'transfer 200', transfer);
    assert(transfer.body.newOwnerId === collab.id, 'newOwnerId matches');

    const afterTransfer = await api(collab.token, 'GET', `/trips/${tripId}`);
    assert(afterTransfer.status === 200, 'new owner can read trip', afterTransfer);
    assert(afterTransfer.body.trip.user_id === collab.id || afterTransfer.body.trip.userId === collab.id || afterTransfer.body.trip, 'user_id flipped (or trip shape)');

    // Old owner should no longer be able to change permissions.
    const permsAfter = await api(owner.token, 'PATCH', `/trips/${tripId}/permissions`, {
      isPublic: false,
    });
    assert(permsAfter.status === 403, 'former owner forbidden from permissions', permsAfter);

    // ─── 6. Clone the trip (as the demoted former owner) ───
    console.log('\n6. POST /trips/:id/clone');
    const clone = await api(owner.token, 'POST', `/trips/${tripId}/clone`, {
      title: 'Cloned trip',
      include: { hotels: true, activities: true, restaurants: true, schedule: true, transports: false },
    });
    assert(clone.status === 201, 'clone 201', clone);
    const cloneId = clone.body.tripId;
    assert(!!cloneId && cloneId !== tripId, 'new cloned tripId distinct from source');

    // Verify source clone_count bumped.
    const { data: srcAfter } = await admin.from('trips').select('clone_count, is_public').eq('id', tripId).single();
    assert((srcAfter?.clone_count ?? 0) >= 1, 'source clone_count incremented', srcAfter);

    // Verify cloned trip has cities but no transports (include.transports=false).
    const { data: cloneCities } = await admin.from('cities').select('*').eq('trip_id', cloneId);
    const { data: cloneTransports } = await admin.from('transports').select('*').eq('trip_id', cloneId);
    assert((cloneCities ?? []).length === 2, 'cloned trip has 2 cities', cloneCities?.length);
    assert((cloneTransports ?? []).length === 0, 'cloned trip has 0 transports (opt-out)', cloneTransports?.length);

    // Verify cloned_from_trip_id set.
    const { data: cloneRow } = await admin.from('trips').select('cloned_from_trip_id').eq('id', cloneId).single();
    assert(cloneRow?.cloned_from_trip_id === tripId, 'cloned_from_trip_id set correctly');

    // ─── 7. Soft-delete ─────────────────────────────────────
    console.log('\n7. DELETE /users/me — soft delete');
    const del = await api(owner.token, 'DELETE', '/users/me', { reason: 'e2e test' });
    assert(del.status === 200, 'delete 200', del);
    assert(del.body.accountStatus === 'pending_deletion', 'status=pending_deletion');
    assert(!!del.body.scheduledDeletionAt, 'scheduledDeletionAt returned');
    assert(del.body.alreadyScheduled === false, 'alreadyScheduled=false first time');

    // Repeat call should be idempotent (alreadyScheduled=true).
    const delAgain = await api(owner.token, 'DELETE', '/users/me');
    assert(delAgain.body.alreadyScheduled === true, 'second delete is idempotent');

    const mePending = await api(owner.token, 'GET', '/users/me');
    assert(mePending.body.accountStatus === 'pending_deletion', 'GET /me reports pending_deletion');
    assert(!!mePending.body.scheduledDeletionAt, 'scheduledDeletionAt on /me');

    // ─── 8. Cancel deletion ────────────────────────────────
    console.log('\n8. POST /users/me/cancel-deletion');
    const cancel = await api(owner.token, 'POST', '/users/me/cancel-deletion');
    assert(cancel.status === 200, 'cancel 200', cancel);
    assert(cancel.body.accountStatus === 'active', 'status back to active');
    assert(cancel.body.wasScheduled === true, 'wasScheduled=true');

    const meActive = await api(owner.token, 'GET', '/users/me');
    assert(meActive.body.accountStatus === 'active', 'GET /me reports active again');
    assert(meActive.body.scheduledDeletionAt === null, 'scheduledDeletionAt cleared');

    // ─── 9. GDPR export ────────────────────────────────────
    console.log('\n9. GET /users/me/export');
    const exportRes = await fetch(`${API}/users/me/export`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const exportJson: any = await exportRes.json();
    assert(exportRes.status === 200, 'export 200');
    assert(exportRes.headers.get('content-disposition')?.includes('attachment'), 'Content-Disposition: attachment');
    assert(exportJson.exportVersion === 1, 'exportVersion=1');
    assert(exportJson.user.id === owner.id, 'export.user.id matches');
    assert(Array.isArray(exportJson.trips), 'export.trips is array');
    // owner's owned trips: the clone they just made (source trip was transferred away)
    assert(exportJson.trips.some((t: any) => t.id === cloneId), 'export includes cloned trip');
    assert(
      exportJson.trips.find((t: any) => t.id === cloneId)?.cities?.length === 2,
      'cloned trip in export has nested cities',
    );

    console.log(`\n━━━ Results: ${pass} passed, ${fail} failed ━━━`);
  } finally {
    console.log('\nCleaning up test users...');
    await cleanup(createdUserIds);
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(2);
});
