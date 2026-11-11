/**
 * /api/textbot routes: who may get a code, the hourly cap, the phone
 * endpoints, and the webhook's secret gate. Auth and trip membership are
 * mocked; nothing touches Supabase or Sendblue.
 */
jest.mock('../config/env', () => ({
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', PORT: 4000, FRONTEND_URL: 'http://localhost:3000' },
}));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ error: 'auth' });
    req.user = { id };
    next();
  },
}));
jest.mock('../services/textbot/tripLoader', () => ({
  SupabaseTripLoader: class {
    async members(tripId: string) {
      return tripId === '11111111-1111-4111-8111-111111111111'
        ? new Map([['owner', 'owner'], ['viewer', 'viewer']])
        : new Map();
    }
  },
}));

import express from 'express';
import request from 'supertest';
import textbot from '../routes/textbot';
import { errorHandler } from '../middleware/error';
import { textStore } from '../services/textbot/runtime';

const TRIP = '11111111-1111-4111-8111-111111111111';
const app = express();
app.use(express.json());
app.use('/api/textbot', textbot);
app.use(errorHandler);

describe('/api/textbot/codes', () => {
  it('requires login', async () => {
    await request(app).post('/api/textbot/codes').send({ tripId: TRIP, kind: 'verify' }).expect(401);
  });

  it('refuses non-members', async () => {
    const r = await request(app).post('/api/textbot/codes').set('x-test-user', 'stranger').send({ tripId: TRIP, kind: 'verify' });
    expect(r.status).toBe(403);
  });

  it('viewers can verify but not link', async () => {
    const link = await request(app).post('/api/textbot/codes').set('x-test-user', 'viewer').send({ tripId: TRIP, kind: 'link' });
    expect(link.status).toBe(403);
    const v = await request(app).post('/api/textbot/codes').set('x-test-user', 'viewer').send({ tripId: TRIP, kind: 'verify' });
    expect(v.status).toBe(200);
    expect(v.body.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(v.body.textToSend).toBe(`verify ${v.body.code}`);
  });

  it('the owner gets a link code that the store will accept once', async () => {
    const r = await request(app).post('/api/textbot/codes').set('x-test-user', 'owner').send({ tripId: TRIP, kind: 'link' });
    expect(r.status).toBe(200);
    expect((await textStore().consumeCode(r.body.code))?.userId).toBe('owner');
    expect(await textStore().consumeCode(r.body.code)).toBeNull();
  });

  it('caps codes at 10 an hour per user', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await request(app).post('/api/textbot/codes').set('x-test-user', 'owner').send({ tripId: TRIP, kind: 'verify' })).status);
    }
    // 1 used by the previous test → 9 more OK, then 429s.
    expect(statuses.filter((s) => s === 200)).toHaveLength(9);
    expect(statuses.slice(-1)[0]).toBe(429);
  });

  it('rejects a bad body', async () => {
    const r = await request(app).post('/api/textbot/codes').set('x-test-user', 'viewer').send({ tripId: 'nope', kind: 'link' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe('/api/textbot/phone', () => {
  it('shows only my phone and forgets it on DELETE', async () => {
    await textStore().linkPhone('viewer', '+14155550003');
    await textStore().linkPhone('owner', '+14155550001');
    const g = await request(app).get('/api/textbot/phone').set('x-test-user', 'viewer');
    expect(g.body.phone).toBe('+14155550003');
    await request(app).delete('/api/textbot/phone').set('x-test-user', 'viewer').expect(200);
    expect((await request(app).get('/api/textbot/phone').set('x-test-user', 'viewer')).body.phone).toBeNull();
    expect((await textStore().userForPhone('+14155550001'))?.userId).toBe('owner');
  });

  it('changing number replaces the old one (one phone per user)', async () => {
    await textStore().linkPhone('owner', '+14155550011');
    expect(await textStore().userForPhone('+14155550001')).toBeNull();
    expect((await textStore().phoneForUser('owner'))?.phone).toBe('+14155550011');
  });
});

describe('/api/textbot/sendblue/webhook', () => {
  const OLD = process.env.SENDBLUE_WEBHOOK_SECRET;
  afterAll(() => { process.env.SENDBLUE_WEBHOOK_SECRET = OLD; });

  it('rejects everything when no secret is configured', async () => {
    delete process.env.SENDBLUE_WEBHOOK_SECRET;
    await request(app).post('/api/textbot/sendblue/webhook').set('sb-signing-secret', 'x').send({}).expect(401);
  });

  it('rejects a wrong secret, accepts the right one', async () => {
    process.env.SENDBLUE_WEBHOOK_SECRET = 'right-secret';
    await request(app).post('/api/textbot/sendblue/webhook').set('sb-signing-secret', 'wrong-secret').send({}).expect(401);
    await request(app).post('/api/textbot/sendblue/webhook').set('sb-signing-secret', 'right-secret').send({}).expect(200);
  });
});
