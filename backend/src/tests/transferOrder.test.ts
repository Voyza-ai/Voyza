jest.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', FRONTEND_URL: 'http://x' },
}));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));

// Ordered log of every write, so we can assert the old owner's editor row
// lands BEFORE trips.user_id changes (their access must never lapse).
const ops: string[] = [];
const OLD_OWNER = 'old-owner';
const NEW_OWNER = 'new-owner';

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: { id: OLD_OWNER, email: 'old@x.dev' } } })),
    },
    from: (table: string) => {
      let mode: 'read' | 'insert' | 'update' | 'delete' = 'read';
      const chain: any = {};
      for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'is', 'ilike']) {
        chain[m] = jest.fn(() => chain);
      }
      chain.insert = jest.fn(() => {
        mode = 'insert';
        ops.push(`insert:${table}`);
        return chain;
      });
      chain.update = jest.fn((patch: any) => {
        mode = 'update';
        ops.push(`update:${table}:${Object.keys(patch).join(',')}`);
        return chain;
      });
      chain.delete = jest.fn(() => {
        mode = 'delete';
        ops.push(`delete:${table}`);
        return chain;
      });
      const result = () => {
        if (mode === 'insert') return { data: { id: 'editor-row' }, error: null };
        if (mode !== 'read') return { data: null, error: null };
        if (table === 'trips') return { data: { user_id: OLD_OWNER, title: 'T' }, error: null };
        if (table === 'group_members') {
          return {
            data: { id: 'm1', user_id: NEW_OWNER, accepted_at: '2026-01-01', role: 'editor' },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      chain.single = jest.fn(() => Promise.resolve(result()));
      chain.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej);
      return chain;
    },
  }),
}));

import express from 'express';
import request from 'supertest';
import canvasRouter from '../routes/canvas';
import tripsRouter from '../routes/trips';
import { errorHandler } from '../middleware/error';

const app = express();
app.use(express.json());
app.use((req: any, _r, next) => {
  req.user = { id: OLD_OWNER, email: 'old@x.dev' };
  next();
});
app.use('/api/canvas', canvasRouter);
app.use('/api/trips', tripsRouter);
app.use(errorHandler);

const firstIndex = (prefix: string) => ops.findIndex((o) => o.startsWith(prefix));

beforeEach(() => {
  ops.length = 0;
});

describe.each([
  ['canvas route', '/api/canvas/trip-1/transfer-ownership', { memberId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff' }],
  ['trips route', '/api/trips/trip-1/transfer-ownership', { newOwnerId: '7f9619ff-8b86-4d11-b42d-00c04fc964ff' }],
])('ownership transfer (%s)', (_name, url, body) => {
  it("writes the old owner's editor row BEFORE the trip changes hands", async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer t')
      .send(body);
    expect(res.status).toBe(200);

    const editorInsert = firstIndex('insert:group_members');
    const ownerChange = firstIndex('update:trips:user_id');
    expect(editorInsert).toBeGreaterThanOrEqual(0);
    expect(ownerChange).toBeGreaterThanOrEqual(0);
    expect(editorInsert).toBeLessThan(ownerChange);

    // And never a delete of membership rows before that editor row exists.
    const firstMemberDelete = firstIndex('delete:group_members');
    expect(firstMemberDelete).toBeGreaterThan(editorInsert);
  });
});
