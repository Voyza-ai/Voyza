jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

// Queue-based supabase mock: every awaited query (thenable builder or
// .single()) consumes the next queued response, so each test scripts its
// DB responses in order. All builder methods chain.
const responseQueue: any[] = [];
const calls: Array<{ table: string; method: string; args: any[] }> = [];

function makeChain(table: string) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update', 'delete', 'insert']) {
    chain[m] = jest.fn().mockImplementation((...args: any[]) => {
      calls.push({ table, method: m, args });
      return chain;
    });
  }
  chain.single = jest.fn().mockImplementation(() =>
    Promise.resolve(responseQueue.shift() ?? { data: null, error: null }),
  );
  chain.then = (resolve: any, reject: any) =>
    Promise.resolve(responseQueue.shift() ?? { data: null, error: null }).then(resolve, reject);
  return chain;
}

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({ from: (table: string) => makeChain(table) }),
}));

import express from 'express';
import request from 'supertest';
import notificationsRouter from '../routes/notifications';
import { errorHandler } from '../middleware/error';

// Fake auth middleware standing in for requireAuth: token → user id.
const USERS: Record<string, string> = { 'alice-token': 'alice-id', 'bob-token': 'bob-id' };
function fakeAuth(req: any, res: any, next: any) {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  const userId = USERS[token];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: userId, email: `${userId}@test.dev` };
  next();
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', fakeAuth, notificationsRouter);
  app.use(errorHandler);
  return app;
}

const app = createApp();

const row = (over: Partial<any> = {}) => ({
  id: 'n1',
  user_id: 'alice-id',
  type: 'canvas_invite',
  title: 'You were invited',
  body: null,
  data: {},
  read_at: null,
  created_at: '2026-09-27T10:00:00Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  responseQueue.length = 0;
  calls.length = 0;
});

describe('GET /api/notifications', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(401);
  });

  it('returns the list + unread count, scoped to the authed user', async () => {
    responseQueue.push({ data: [row(), row({ id: 'n2', read_at: '2026-09-27T11:00:00Z' })], error: null });
    responseQueue.push({ count: 1, error: null });

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', 'Bearer alice-token');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
    expect(res.body.unreadCount).toBe(1);
    // Every notifications query was filtered to the caller.
    const eqCalls = calls.filter((c) => c.method === 'eq');
    expect(eqCalls.length).toBeGreaterThan(0);
    for (const c of eqCalls) expect(c.args).toEqual(['user_id', 'alice-id']);
  });

  it('rejects an out-of-range limit', async () => {
    const res = await request(app)
      .get('/api/notifications?limit=5000')
      .set('Authorization', 'Bearer alice-token');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/notifications/read-all', () => {
  it('marks everything read and reports the count', async () => {
    responseQueue.push({ data: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }], error: null });
    const res = await request(app)
      .patch('/api/notifications/read-all')
      .set('Authorization', 'Bearer alice-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, updated: 3 });
    // Route-order regression: read-all must NOT be treated as an :id —
    // its handler filters by user_id + unread, never by id.
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'id')).toBe(false);
    expect(calls.some((c) => c.method === 'is' && c.args[0] === 'read_at')).toBe(true);
  });
});

describe('PATCH /api/notifications/:id', () => {
  it('marks one notification read', async () => {
    responseQueue.push({ data: row({ read_at: '2026-09-27T12:00:00Z' }), error: null });
    const res = await request(app)
      .patch('/api/notifications/n1')
      .set('Authorization', 'Bearer alice-token');
    expect(res.status).toBe(200);
    expect(res.body.notification.read_at).toBe('2026-09-27T12:00:00Z');
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === 'n1')).toBe(true);
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === 'alice-id')).toBe(true);
  });

  it("404s when the row doesn't exist or belongs to someone else", async () => {
    responseQueue.push({ data: null, error: { message: 'No rows' } });
    const res = await request(app)
      .patch('/api/notifications/nope')
      .set('Authorization', 'Bearer bob-token');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/notifications (clear all)', () => {
  it('deletes every notification for the caller and reports the count', async () => {
    responseQueue.push({ data: [{ id: 'n1' }, { id: 'n2' }], error: null });
    const res = await request(app)
      .delete('/api/notifications')
      .set('Authorization', 'Bearer alice-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 2 });
    // Scoped to the caller, and NOT routed into /:id.
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === 'alice-id')).toBe(true);
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'id')).toBe(false);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('deletes with user scoping', async () => {
    responseQueue.push({ error: null });
    const res = await request(app)
      .delete('/api/notifications/n1')
      .set('Authorization', 'Bearer alice-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(calls.some((c) => c.table === 'notifications' && c.method === 'delete')).toBe(true);
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === 'alice-id')).toBe(true);
  });
});
