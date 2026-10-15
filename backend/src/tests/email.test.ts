jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'BlueMurr <test@bluemurr.com>',
    API_PUBLIC_URL: 'http://localhost:4000',
    FRONTEND_URL: 'http://localhost:3000',
    CRON_SECRET: 'cron-secret',
  },
}));

const mockWarn = jest.fn();
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: (...a: any[]) => mockWarn(...a), error: jest.fn() },
}));

// Supabase mock: user_profiles single() → profileResponse; updates recorded;
// notifications list → unreadResponse; profile lists → profilesListResponse;
// auth.admin.getUserById → email map.
let profileResponse: any = { data: { preferences: {} }, error: null };
let profilesListResponse: any = { data: [], error: null };
let unreadResponse: any = { data: [], error: null };
const profileUpdates: any[] = [];
const adminEmails: Record<string, string> = { 'u1': 'u1@test.dev' };

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: jest.fn(async (id: string) => ({
          data: { user: adminEmails[id] ? { email: adminEmails[id] } : null },
        })),
      },
    },
    from: (table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'is', 'not', 'order', 'limit']) {
        chain[m] = jest.fn().mockReturnValue(chain);
      }
      chain.update = jest.fn().mockImplementation((patch: any) => {
        profileUpdates.push({ table, patch });
        return chain;
      });
      chain.single = jest.fn().mockImplementation(() => Promise.resolve(profileResponse));
      chain.then = (resolve: any, reject: any) => {
        const out = table === 'notifications' ? unreadResponse : profilesListResponse;
        return Promise.resolve(out).then(resolve, reject);
      };
      return chain;
    },
  }),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import express from 'express';
import request from 'supertest';
import {
  sendEmail,
  isEmailTypeEnabled,
  emailTemplates,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from '../services/email';
import { runGraceReminders, runWeeklyDigests } from '../services/emailJobs';
import emailRouter from '../routes/email';
import { errorHandler } from '../middleware/error';
import { env } from '../config/env';

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use('/api/email', emailRouter);
  a.use(errorHandler);
  return a;
})();

beforeEach(() => {
  jest.clearAllMocks();
  profileUpdates.length = 0;
  profileResponse = { data: { preferences: {} }, error: null };
  profilesListResponse = { data: [], error: null };
  unreadResponse = { data: [], error: null };
  (env as any).RESEND_API_KEY = 're_test_key';
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'email-1' }) });
});

describe('isEmailTypeEnabled', () => {
  it('critical account emails always send — even unsubscribed', () => {
    const unsub = { email: { unsubscribed: true } };
    expect(isEmailTypeEnabled(unsub, 'deletion_scheduled')).toBe(true);
    expect(isEmailTypeEnabled(unsub, 'grace_reminder')).toBe(true);
  });

  it('invites are opt-out; digest is opt-in; unsubscribe blocks both', () => {
    expect(isEmailTypeEnabled({}, 'canvas_invite')).toBe(true);
    expect(isEmailTypeEnabled({ email: { canvas_invite: false } }, 'canvas_invite')).toBe(false);
    expect(isEmailTypeEnabled({}, 'digest')).toBe(false);
    expect(isEmailTypeEnabled({ email: { digest: true } }, 'digest')).toBe(true);
    const unsub = { email: { unsubscribed: true, digest: true } };
    expect(isEmailTypeEnabled(unsub, 'canvas_invite')).toBe(false);
    expect(isEmailTypeEnabled(unsub, 'digest')).toBe(false);
  });
});

describe('sendEmail', () => {
  const input = {
    to: 'x@test.dev',
    subject: 's',
    html: '<p>h</p>',
    type: 'canvas_invite' as const,
  };

  it('posts to Resend with from/to/subject/html', async () => {
    expect(await sendEmail(input)).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      from: 'BlueMurr <test@bluemurr.com>',
      to: ['x@test.dev'],
      subject: 's',
    });
  });

  it('is a silent no-op when the transport is not configured', async () => {
    (env as any).RESEND_API_KEY = undefined;
    expect(await sendEmail(input)).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('enforces stored preferences when userId is given', async () => {
    profileResponse = { data: { preferences: { email: { canvas_invite: false } } }, error: null };
    expect(await sendEmail({ ...input, userId: 'u1' })).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never throws — transport failures return false with a warning', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    await expect(sendEmail(input)).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalled();
    mockFetch.mockResolvedValue({ ok: false, status: 422 });
    await expect(sendEmail(input)).resolves.toBe(false);
  });
});

describe('unsubscribe tokens', () => {
  it('round-trips and rejects tampering', () => {
    const t = unsubscribeToken('user-abc');
    expect(verifyUnsubscribeToken(t)).toBe('user-abc');
    expect(verifyUnsubscribeToken(t.slice(0, -2) + 'zz')).toBeNull();
    expect(verifyUnsubscribeToken('garbage')).toBeNull();
    expect(verifyUnsubscribeToken('')).toBeNull();
  });
});

describe('GET /api/email/unsubscribe', () => {
  it('sets preferences.email.unsubscribed for a valid token', async () => {
    const res = await request(app).get(
      `/api/email/unsubscribe?token=${unsubscribeToken('u1')}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("You're unsubscribed");
    const upd = profileUpdates.find((u) => u.table === 'user_profiles');
    expect(upd.patch.preferences.email.unsubscribed).toBe(true);
  });

  it('400s an invalid token without touching the database', async () => {
    const res = await request(app).get('/api/email/unsubscribe?token=bad');
    expect(res.status).toBe(400);
    expect(profileUpdates).toHaveLength(0);
  });
});

describe('POST /api/email/run-jobs', () => {
  it('rejects a missing or wrong secret', async () => {
    expect((await request(app).post('/api/email/run-jobs')).status).toBe(401);
    expect(
      (await request(app).post('/api/email/run-jobs').set('x-cron-secret', 'nope')).status,
    ).toBe(401);
  });

  it('runs the jobs with the right secret', async () => {
    const res = await request(app)
      .post('/api/email/run-jobs')
      .set('x-cron-secret', 'cron-secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, remindersSent: 0, digestsSent: 0 });
  });
});

describe('runGraceReminders', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const deletedDaysAgo = (d: number) =>
    new Date(now.getTime() - d * 86_400_000).toISOString();

  it('sends once around day 23 and marks the profile', async () => {
    profilesListResponse = {
      data: [{ id: 'u1', preferences: {}, deleted_at: deletedDaysAgo(24) }],
      error: null,
    };
    expect(await runGraceReminders(now)).toBe(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subject).toMatch(/deleted in 6 days/);
    expect(body.to).toEqual(['u1@test.dev']);
    const upd = profileUpdates.find((u) => u.patch?.preferences?.email?.graceReminderSent);
    expect(upd).toBeDefined();
  });

  it('skips accounts already reminded or not yet due', async () => {
    profilesListResponse = {
      data: [
        { id: 'u1', preferences: { email: { graceReminderSent: true } }, deleted_at: deletedDaysAgo(24) },
        { id: 'u1', preferences: {}, deleted_at: deletedDaysAgo(5) }, // 25 days left
      ],
      error: null,
    };
    expect(await runGraceReminders(now)).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('runWeeklyDigests', () => {
  const now = new Date('2026-09-30T12:00:00Z');

  it('sends unread summaries to opted-in users and stamps digestSentAt', async () => {
    profilesListResponse = {
      data: [{ id: 'u1', preferences: { email: { digest: true } } }],
      error: null,
    };
    // sendEmail independently re-reads the profile to enforce prefs —
    // keep the single-row read consistent with the opted-in list row.
    profileResponse = { data: { preferences: { email: { digest: true } } }, error: null };
    unreadResponse = { data: [{ title: 'You were invited', body: null }], error: null };
    expect(await runWeeklyDigests(now)).toBe(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subject).toMatch(/1 unread notification/);
    expect(body.html).toContain('Unsubscribe');
    const upd = profileUpdates.find((u) => u.patch?.preferences?.email?.digestSentAt);
    expect(upd).toBeDefined();
  });

  it('skips users with nothing unread or a digest sent this week', async () => {
    profilesListResponse = {
      data: [
        { id: 'u1', preferences: { email: { digest: true, digestSentAt: now.toISOString() } } },
      ],
      error: null,
    };
    unreadResponse = { data: [{ title: 't', body: null }], error: null };
    expect(await runWeeklyDigests(now)).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
