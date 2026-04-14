import express from 'express';
import request from 'supertest';

jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

// Track mock calls
const mockSupabaseData: Record<string, any> = {};

jest.mock('../services/supabase', () => {
  const createChainableQuery = (resolveWith?: any) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      single: () => Promise.resolve({ data: resolveWith ?? null }),
      order: () => chain,
      limit: () => chain,
      insert: () => chain,
      update: () => chain,
      upsert: () => chain,
      delete: () => chain,
    };
    return chain;
  };

  return {
    getSupabase: () => ({
      auth: {
        getUser: jest.fn().mockImplementation((token: string) => {
          if (token === 'owner-token') {
            return Promise.resolve({ data: { user: { id: 'owner-user-id' } } });
          }
          if (token === 'editor-token') {
            return Promise.resolve({ data: { user: { id: 'editor-user-id' } } });
          }
          if (token === 'viewer-token') {
            return Promise.resolve({ data: { user: { id: 'viewer-user-id' } } });
          }
          if (token === 'suggester-token') {
            return Promise.resolve({ data: { user: { id: 'suggester-user-id' } } });
          }
          if (token === 'non-member-token') {
            return Promise.resolve({ data: { user: { id: 'non-member-id' } } });
          }
          return Promise.resolve({ data: { user: null } });
        }),
      },
      from: jest.fn().mockImplementation((table: string) => {
        if (table === 'trips') {
          return createChainableQuery({ user_id: 'owner-user-id' });
        }
        if (table === 'group_members') {
          return {
            select: () => ({
              eq: (col: string, val: string) => ({
                eq: (col2: string, val2: string) => ({
                  single: () => {
                    // Determine role based on user_id
                    if (val2 === 'editor-user-id' || val === 'editor-user-id') {
                      return Promise.resolve({ data: { role: 'editor' } });
                    }
                    if (val2 === 'viewer-user-id' || val === 'viewer-user-id') {
                      return Promise.resolve({ data: { role: 'viewer' } });
                    }
                    if (val2 === 'suggester-user-id' || val === 'suggester-user-id') {
                      return Promise.resolve({ data: { role: 'suggester' } });
                    }
                    return Promise.resolve({ data: null });
                  },
                }),
                single: () => Promise.resolve({ data: null }),
              }),
            }),
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: 'new-member', invite_token: 'test-token' },
                  }),
              }),
            }),
          };
        }
        if (table === 'canvas_sessions') {
          return createChainableQuery(null);
        }
        if (table === 'canvas_suggestions') {
          return {
            ...createChainableQuery(),
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: 'suggestion-1', type: 'comment', status: 'pending' },
                  }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: () =>
                      Promise.resolve({
                        data: { id: 'suggestion-1', type: 'comment', status: 'approved' },
                      }),
                  }),
                }),
              }),
            }),
          };
        }
        return createChainableQuery();
      }),
    }),
  };
});

import canvasRouter from '../routes/canvas';
import { errorHandler } from '../middleware/error';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/canvas', canvasRouter);
  app.use(errorHandler);
  return app;
}

describe('Canvas Routes', () => {
  const app = createApp();

  describe('POST /api/canvas/:tripId/session', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/canvas/trip-1/session');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-member', async () => {
      const res = await request(app)
        .post('/api/canvas/trip-1/session')
        .set('Authorization', 'Bearer non-member-token');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/canvas/:tripId/save', () => {
    it('returns 403 for non-owner', async () => {
      const res = await request(app)
        .post('/api/canvas/trip-1/save')
        .set('Authorization', 'Bearer editor-token')
        .send({ state: {} });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/canvas/:tripId/suggestions', () => {
    it('returns 403 for viewer', async () => {
      const res = await request(app)
        .post('/api/canvas/trip-1/suggestions')
        .set('Authorization', 'Bearer viewer-token')
        .send({ type: 'comment', payload: { text: 'Nice!' } });
      expect(res.status).toBe(403);
    });

    it('allows suggester to POST', async () => {
      const res = await request(app)
        .post('/api/canvas/trip-1/suggestions')
        .set('Authorization', 'Bearer suggester-token')
        .send({ type: 'comment', payload: { text: 'Nice!' } });
      expect(res.status).toBe(201);
    });
  });

  describe('PATCH /api/canvas/:tripId/suggestions/:suggestionId', () => {
    it('returns 403 for editor (not owner)', async () => {
      const res = await request(app)
        .patch('/api/canvas/trip-1/suggestions/s1')
        .set('Authorization', 'Bearer editor-token')
        .send({ status: 'approved' });
      expect(res.status).toBe(403);
    });
  });
});
