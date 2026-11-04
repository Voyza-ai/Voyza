/**
 * Routes of the geo-aware planner: POST /api/plan/places, and the
 * coordinate handling in /activities and /restaurants — the model's own
 * coordinates are always stripped, the provider's are attached.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    ANTHROPIC_API_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
    ALLABOARD_API_URL: 'https://test.api-gateway.allaboard.eu',
    CORS_ORIGIN: 'http://localhost:3000',
    FRONTEND_URL: 'http://localhost:3000',
    API_PUBLIC_URL: 'http://localhost:4000',
    EMAIL_FROM: 'test <test@example.com>',
    PORT: 4000,
  },
}));

const mockCreate = jest.fn();
jest.mock('../services/anthropic', () => ({
  getAnthropicSafe: jest.fn(() => ({ messages: { create: mockCreate } })),
  getAnthropic: jest.fn(),
  DEFAULT_MODEL: 'claude-test',
}));
jest.mock('../services/flights', () => ({ searchFlights: jest.fn(), getIataCode: jest.fn() }));
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));

import planRouter from '../routes/plan';
import { errorHandler } from '../middleware/error';
import { __setProviderForTests, type PoiProvider } from '../services/places';

const app = express();
app.use(express.json());
app.use('/api/plan', planRouter);
app.use(errorHandler);

const provider = (answers: Record<string, any>): PoiProvider & { calls: string[] } => {
  const calls: string[] = [];
  return {
    name: 'osm',
    calls,
    async search(q) {
      calls.push(q);
      return answers[q] ?? null;
    },
  };
};

const aiText = (items: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(items) }] });

afterEach(() => {
  __setProviderForTests(null);
  mockCreate.mockReset();
});

describe('POST /api/plan/places', () => {
  it('returns provider coordinates in order, no travel matrix without a Google key', async () => {
    __setProviderForTests(provider({ 'Colosseum, Rome, Italy': { lat: 41.8902, lng: 12.4922, placeId: 'osm:W1' } }));
    const res = await request(app)
      .post('/api/plan/places')
      .send({ city: 'Rome', country: 'Italy', items: [{ name: 'Colosseum' }, { name: 'Gelato crawl' }] });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('osm');
    expect(res.body.places).toEqual([
      { name: 'Colosseum', lat: 41.8902, lng: 12.4922, placeId: 'osm:W1' },
      { name: 'Gelato crawl' },
    ]);
    expect(res.body.travel).toBeUndefined();
  });

  it('validates input: too many items is a 400', async () => {
    const items = Array.from({ length: 31 }, (_, i) => ({ name: `p${i}` }));
    const res = await request(app).post('/api/plan/places').send({ city: 'Rome', items });
    expect(res.status).toBe(400);
  });
});

describe('/activities and /restaurants', () => {
  it('strips coordinates the model invented and passes placeQuery through', async () => {
    __setProviderForTests(provider({}));
    mockCreate.mockResolvedValue(
      aiText([
        { name: 'Colosseum', category: 'landmark', timeOfDay: 'morning', durationHours: 2, reason: 'r', placeQuery: 'Colosseo', lat: 1, lng: 2, placeId: 'fake' },
      ]),
    );
    const res = await request(app).post('/api/plan/activities').send({ city: 'Rome', country: 'Italy' });
    expect(res.status).toBe(200);
    const [a] = res.body.activities;
    expect(a.placeQuery).toBe('Colosseo');
    expect(a.lat).toBeUndefined();
    expect(a.placeId).toBeUndefined();
  });

  it('attaches cached provider coordinates and prefetches the rest', async () => {
    const p = provider({ 'Roscioli, Rome, Italy': { lat: 41.894, lng: 12.473, placeId: 'osm:N7' } });
    __setProviderForTests(p);
    const pick = { name: 'Roscioli', cuisine: 'Roman', priceRange: '$$$', mealType: 'lunch', reason: 'r' };
    mockCreate.mockResolvedValue(aiText([pick]));
    const first = await request(app).post('/api/plan/restaurants').send({ city: 'Rome', country: 'Italy' });
    expect(first.body.restaurants[0].lat).toBeUndefined(); // not cached yet — no waiting on the provider
    await new Promise((r) => setTimeout(r, 20)); // the prefetch lands
    expect(p.calls).toContain('Roscioli, Rome, Italy');
    const second = await request(app).post('/api/plan/restaurants').send({ city: 'Rome', country: 'Italy' });
    expect(second.body.restaurants[0]).toMatchObject({ name: 'Roscioli', lat: 41.894, lng: 12.473, placeId: 'osm:N7' });
  });
});
