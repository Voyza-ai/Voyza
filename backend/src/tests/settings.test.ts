/**
 * Settings page backend: profile/preference PATCH merging, notification +
 * privacy preferences being honoured, two-step account deletion (request →
 * emailed single-use link → confirm), apply-privacy-to-trips, and export.
 * In-memory Supabase fake — nothing touches a real database.
 */
jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'BlueMurr <test@bluemurr.com>',
    API_PUBLIC_URL: 'http://localhost:4000',
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
const reset = () => {
  db.user_profiles = [
    { id: USER_ID, full_name: 'Test', avatar_url: null, preferences: {}, deleted_at: null, anonymized_at: null },
    { id: OTHER_ID, full_name: 'Other', preferences: {}, deleted_at: null, anonymized_at: null },
  ];
  db.trips = [
    { id: 't1', user_id: USER_ID, allow_recommendations: true },
    { id: 't2', user_id: USER_ID, allow_recommendations: true },
    { id: 't3', user_id: OTHER_ID, allow_recommendations: true },
  ];
  db.notifications = [];
  db.group_members = [];
  db.canvas_suggestions = [];
  db.cities = [];
  db.transports = [];
};

// Minimal PostgREST-ish chain over `db`: select/eq/in filters, insert,
// update, single, and thenable lists.
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'update' | 'insert' = 'select';
  let patch: Row | null = null;
  let inserted: Row[] = [];
  const rows = () => (db[name] ??= []).filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === 'update') {
      const hit = rows();
      hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(patch))));
      return { data: hit, error: null };
    }
    if (op === 'insert') return { data: inserted, error: null };
    return { data: rows(), error: null };
  };
  const chain: any = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    eq: (col: string, v: any) => (filters.push((r) => r[col] === v), chain),
    in: (col: string, vs: any[]) => (filters.push((r) => vs.includes(r[col])), chain),
    update: (p: Row) => ((op = 'update'), (patch = p), chain),
    insert: (p: Row | Row[]) => {
      op = 'insert';
      inserted = (Array.isArray(p) ? p : [p]).map((r) => ({ id: `new-${Math.random()}`, ...r }));
      db[name] = [...(db[name] ?? []), ...inserted];
      return chain;
    },
    single: () => {
      const { data } = run();
      const row = Array.isArray(data) ? data[0] : data;
      return Promise.resolve({ data: row ?? null, error: row ? null : { message: 'no rows' } });
    },
    then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
  };
  return chain;
}

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: (t: string) => table(t),
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: id === USER_ID ? { id, email: 'me@test.dev' } : null },
        }),
      },
    },
  }),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import express from 'express';
import request from 'supertest';
import usersRouter, { mergePreferences } from '../routes/users';
import emailRouter from '../routes/email';
import tripsRouter from '../routes/trips';
import { errorHandler } from '../middleware/error';
import { createNotification } from '../services/notifications';
import { sendEmail } from '../services/email';
import { recommendationDefaultFor, DELETION_REQUEST_COOLDOWN_MS } from '../services/accountDeletion';

const app = (() => {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/users', (req, _res, next) => {
    (req as any).user = { id: USER_ID, email: 'me@test.dev', created_at: '2026-01-01' };
    next();
  }, usersRouter);
  a.use('/api/email', emailRouter);
  a.use('/api/trips', (req, _res, next) => {
    (req as any).user = { id: USER_ID, email: 'me@test.dev' };
    next();
  }, tripsRouter);
  a.use(errorHandler);
  return a;
})();

const profile = () => db.user_profiles.find((p) => p.id === USER_ID)!;

/** The confirm link from the last email sent through the Resend mock. */
function lastEmailedToken(): string {
  const body = JSON.parse(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1].body);
  const m = /confirm-deletion\?token=([^"&]+)/.exec(body.html);
  if (!m) throw new Error('no confirm link in email');
  return decodeURIComponent(m[1]);
}

beforeEach(() => {
  reset();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'email-1' }) });
});

describe('mergePreferences', () => {
  it('merges nested groups key-by-key and leaves other keys alone', () => {
    const current = { homeCity: 'Paris', notifications: { canvas_invite: false }, email: { digest: true } };
    const out = mergePreferences(current, { notifications: { suggestion_decided: false } });
    expect(out).toEqual({
      homeCity: 'Paris',
      notifications: { canvas_invite: false, suggestion_decided: false },
      email: { digest: true },
    });
  });
});

describe('PATCH /api/users/me', () => {
  it('saves name, avatar and preferences, and GET returns them', async () => {
    const avatar = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const res = await request(app)
      .patch('/api/users/me')
      .send({
        fullName: '  New Name ',
        avatarUrl: avatar,
        preferences: { homeCity: 'Lisbon', preferredCurrency: 'EUR', defaultTravelers: 2 },
      });
    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe('New Name');
    const me = await request(app).get('/api/users/me');
    expect(me.body).toMatchObject({
      fullName: 'New Name',
      avatarUrl: avatar,
      preferences: { homeCity: 'Lisbon', preferredCurrency: 'EUR', defaultTravelers: 2 },
    });
  });

  it('rejects non-image avatars and oversized ones', async () => {
    for (const avatarUrl of ['javascript:alert(1)', 'data:text/html;base64,PGgxPg==', 'http://x.dev/a.png']) {
      const res = await request(app).patch('/api/users/me').send({ avatarUrl });
      expect(res.status).toBe(400);
    }
    const big = 'data:image/png;base64,' + 'A'.repeat(210_000);
    expect((await request(app).patch('/api/users/me').send({ avatarUrl: big })).status).toBe(400);
  });

  it('a partial notification patch does not wipe the other notification keys', async () => {
    await request(app).patch('/api/users/me').send({ preferences: { notifications: { canvas_invite: false } } });
    await request(app).patch('/api/users/me').send({ preferences: { notifications: { suggestion_decided: false } } });
    expect(profile().preferences.notifications).toEqual({ canvas_invite: false, suggestion_decided: false });
  });

  it('clients cannot write the server-only deletionRequest key', async () => {
    await request(app)
      .patch('/api/users/me')
      .send({ preferences: { deletionRequest: { tokenHash: 'x', expiresAt: '2999-01-01' } } });
    expect(profile().preferences.deletionRequest).toBeUndefined();
  });
});

describe('notification preferences are honoured', () => {
  it('a type muted in Settings is not inserted; others still are', async () => {
    await request(app).patch('/api/users/me').send({ preferences: { notifications: { canvas_invite: false } } });
    await createNotification({ userId: USER_ID, type: 'canvas_invite', title: 'invite' });
    await createNotification({ userId: USER_ID, type: 'suggestion_decided', title: 'decided' });
    expect(db.notifications.map((n) => n.type)).toEqual(['suggestion_decided']);
  });

  it('email toggles saved in Settings gate the invite + digest emails', async () => {
    await request(app).patch('/api/users/me').send({ preferences: { email: { canvas_invite: false } } });
    expect(await sendEmail({ to: 'me@test.dev', userId: USER_ID, type: 'canvas_invite', subject: 's', html: 'h' })).toBe(false);
    expect(await sendEmail({ to: 'me@test.dev', userId: USER_ID, type: 'digest', subject: 's', html: 'h' })).toBe(false);
    await request(app).patch('/api/users/me').send({ preferences: { email: { canvas_invite: true, digest: true } } });
    expect(await sendEmail({ to: 'me@test.dev', userId: USER_ID, type: 'digest', subject: 's', html: 'h' })).toBe(true);
  });
});

describe('privacy default', () => {
  it('recommendationDefaultFor is opt-out and follows the Settings toggle', async () => {
    expect(await recommendationDefaultFor(USER_ID)).toBe(true);
    await request(app).patch('/api/users/me').send({ preferences: { privacy: { allowRecommendations: false } } });
    expect(await recommendationDefaultFor(USER_ID)).toBe(false);
  });

  it('new trips saved through POST /api/trips take the Settings default', async () => {
    const save = () => request(app).post('/api/trips').send({ title: 'Trip', cities: [] });
    let res = await save();
    expect(res.status).toBe(201);
    expect(db.trips.find((t) => t.id === res.body.tripId)?.allow_recommendations).toBe(true);

    await request(app).patch('/api/users/me').send({ preferences: { privacy: { allowRecommendations: false } } });
    res = await save();
    expect(db.trips.find((t) => t.id === res.body.tripId)?.allow_recommendations).toBe(false);
  });

  it('apply-to-trips updates only trips the caller owns', async () => {
    const res = await request(app)
      .post('/api/users/me/privacy/apply-to-trips')
      .send({ allowRecommendations: false });
    expect(res.body).toMatchObject({ success: true, updated: 2 });
    expect(db.trips.map((t) => [t.id, t.allow_recommendations])).toEqual([
      ['t1', false],
      ['t2', false],
      ['t3', true],
    ]);
  });
});

describe('two-step account deletion', () => {
  it('requesting emails a link and does NOT schedule anything yet', async () => {
    const res = await request(app).post('/api/users/me/deletion-request').send({ reason: 'bye' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ confirmationSent: true, accountStatus: 'active' });
    expect(profile().deleted_at).toBeNull();
    const email = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(email.to).toEqual(['me@test.dev']);
    expect(email.subject).toMatch(/Confirm/);
    // Only the hash is stored, and GET /me never exposes it.
    expect(profile().preferences.deletionRequest.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(profile().preferences)).not.toContain(lastEmailedToken().split('.')[1]);
    const me = await request(app).get('/api/users/me');
    expect(me.body.preferences.deletionRequest).toBeUndefined();
  });

  it('DELETE /me is the same request step — it can no longer skip the email', async () => {
    const res = await request(app).delete('/api/users/me');
    expect(res.body.confirmationSent).toBe(true);
    expect(profile().deleted_at).toBeNull();
  });

  it('confirming the emailed link schedules deletion once; the link is single-use', async () => {
    await request(app).post('/api/users/me/deletion-request').send({ reason: 'bye' });
    const token = lastEmailedToken();

    const ok = await request(app).post('/api/email/confirm-deletion').send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ accountStatus: 'pending_deletion', alreadyScheduled: false });
    expect(profile().deleted_at).toBeTruthy();
    expect(profile().deletion_reason).toBe('bye');
    expect(profile().preferences.deletionRequest).toBeUndefined();
    expect(db.notifications.map((n) => n.type)).toContain('account_deletion_scheduled');

    const again = await request(app).post('/api/email/confirm-deletion').send({ token });
    expect(again.status).toBe(400);

    const me = await request(app).get('/api/users/me');
    expect(me.body.accountStatus).toBe('pending_deletion');

    // Restore works as before.
    const cancel = await request(app).post('/api/users/me/cancel-deletion');
    expect(cancel.body).toMatchObject({ accountStatus: 'active', wasScheduled: true });
    expect(profile().deleted_at).toBeNull();
  });

  it('rejects tampered, foreign, expired and superseded tokens', async () => {
    await request(app).post('/api/users/me/deletion-request');
    const token = lastEmailedToken();
    const [, secret] = token.split('.');

    const bad = [
      'garbage',
      `${token}x`,
      `${Buffer.from(OTHER_ID).toString('base64url')}.${secret}`,
    ];
    for (const t of bad) {
      expect((await request(app).post('/api/email/confirm-deletion').send({ token: t })).status).toBe(400);
    }
    expect(db.user_profiles.every((p) => p.deleted_at === null)).toBe(true);

    profile().preferences.deletionRequest.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await request(app).post('/api/email/confirm-deletion').send({ token })).status).toBe(400);

    // A newer request replaces the stored hash: the older link dies.
    profile().preferences.deletionRequest.requestedAt = new Date(Date.now() - DELETION_REQUEST_COOLDOWN_MS - 1).toISOString();
    await request(app).post('/api/users/me/deletion-request');
    const newer = lastEmailedToken();
    expect((await request(app).post('/api/email/confirm-deletion').send({ token })).status).toBe(400);
    expect((await request(app).post('/api/email/confirm-deletion').send({ token: newer })).status).toBe(200);
  });

  it('cancelling voids a pending, unclicked link', async () => {
    await request(app).post('/api/users/me/deletion-request');
    const token = lastEmailedToken();
    await request(app).post('/api/users/me/cancel-deletion');
    expect((await request(app).post('/api/email/confirm-deletion').send({ token })).status).toBe(400);
    expect(profile().deleted_at).toBeNull();
  });

  it('rate-limits repeat requests and reports 503 when the email cannot be sent', async () => {
    await request(app).post('/api/users/me/deletion-request');
    expect((await request(app).post('/api/users/me/deletion-request')).status).toBe(429);

    reset();
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const res = await request(app).post('/api/users/me/deletion-request');
    expect(res.status).toBe(503);
    expect(profile().deleted_at).toBeNull();
  });

  it('a request while already pending reports the existing schedule', async () => {
    profile().deleted_at = '2026-10-01T00:00:00.000Z';
    const res = await request(app).post('/api/users/me/deletion-request');
    expect(res.body).toMatchObject({ alreadyScheduled: true, accountStatus: 'pending_deletion' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/users/me/export', () => {
  it('downloads the user’s profile and owned trips, without server-only keys', async () => {
    profile().preferences = { homeCity: 'Rome', deletionRequest: { tokenHash: 'h' } };
    const res = await request(app).get('/api/users/me/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="bluemurr-export-/);
    const json = JSON.parse(res.text);
    expect(json.user.id).toBe(USER_ID);
    expect(json.profile.preferences).toEqual({ homeCity: 'Rome' });
    expect(json.trips.map((t: any) => t.id)).toEqual(['t1', 't2']);
  });
});
