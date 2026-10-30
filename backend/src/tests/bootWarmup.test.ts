/**
 * The location index is built at boot, not on a user's request.
 *
 * originIndex() is lazy, so at 54fd844 the first /api/locations/resolve or
 * optimize after every deploy paid 391–421 ms (+53 MB heap) to build it, on
 * that user's request. index.ts now builds it right after `listen`.
 *
 * Each test boots the real app from src/index.ts in its own module registry.
 * The build itself is real; buildIndex is only wrapped to count calls.
 */

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 0,
    CORS_ORIGIN: 'http://localhost:3000',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
  },
}));
jest.mock('morgan', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

import { once } from 'events';
import type { Server } from 'http';
import request from 'supertest';

async function until(cond: () => boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function listening(server: Server) {
  if (!server.listening) await once(server, 'listening');
}

const close = (server: Server) => new Promise((r) => server.close(r));

let logSpy: jest.SpyInstance;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

it('builds the index once, right after listen, before any request asks for it — and the first request does not build it again', async () => {
  let server!: Server;
  let buildIndex!: jest.Mock;
  jest.isolateModules(() => {
    jest.doMock('../services/location/buildIndex', () => {
      const actual = jest.requireActual('../services/location/buildIndex');
      return { ...actual, buildIndex: jest.fn(actual.buildIndex) };
    });
    buildIndex = require('../services/location/buildIndex').buildIndex;
    ({ server } = require('../index'));
  });
  try {
    await listening(server);
    // No request has been made. The build happens on its own.
    await until(() => buildIndex.mock.calls.length > 0, 'the boot-time build');
    expect(buildIndex).toHaveBeenCalledTimes(1);

    const res = await request(server).post('/api/locations/resolve').send({ query: 'nyc' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(buildIndex).toHaveBeenCalledTimes(1);
  } finally {
    await close(server);
  }
}, 30_000);

it('warms the Browse preset checks right after the index, before any /api/presets request', async () => {
  // The first /api/presets after a deploy otherwise spent ~0.6s resolving
  // every generated preset's gateway airport (and in CI the first request of
  // presetsServeProd.test.ts ran past Jest's 5s with the index build on top).
  let server!: Server;
  let warm!: jest.Mock;
  jest.isolateModules(() => {
    jest.doMock('../services/presets', () => {
      const actual = jest.requireActual('../services/presets');
      return { ...actual, warmPresetChecks: jest.fn(actual.warmPresetChecks) };
    });
    warm = require('../services/presets').warmPresetChecks;
    ({ server } = require('../index'));
  });
  try {
    await listening(server);
    await until(() => warm.mock.calls.length > 0, 'the boot-time preset warm-up');
    expect(warm).toHaveBeenCalledTimes(1);
  } finally {
    await close(server);
  }
}, 30_000);

it('a failed build is logged, does not take the server down, and the first request builds it instead', async () => {
  let server!: Server;
  let errorLog!: jest.SpyInstance;
  jest.isolateModules(() => {
    jest.doMock('../services/location/originAirports', () => {
      const actual = jest.requireActual('../services/location/originAirports');
      let failNext = true;
      return {
        ...actual,
        originIndex: jest.fn(() => {
          if (failNext) {
            failNext = false;
            throw new Error('artifact unreadable');
          }
          return actual.originIndex();
        }),
      };
    });
    const { logger } = require('../utils/logger');
    errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});
    ({ server } = require('../index'));
  });
  try {
    await listening(server);
    await until(() => errorLog.mock.calls.length > 0, 'the warm-up failure to be logged');
    expect(errorLog).toHaveBeenCalledWith('Location index warm-up failed — the first request will build it', {
      errMessage: 'artifact unreadable',
    });

    expect((await request(server).get('/api/health')).status).toBe(200);
    const res = await request(server).post('/api/locations/resolve').send({ query: 'nyc' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
  } finally {
    await close(server);
  }
}, 30_000);
