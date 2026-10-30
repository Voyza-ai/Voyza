/**
 * A stalled Anthropic call must end in minutes, not half an hour.
 *
 * getAnthropic() built the SDK client with its defaults: a 600 s timeout and
 * 2 retries, where a timeout is itself retried. A call that never answered
 * therefore held its route for ~3 × 600 s before failing, and the frontend has
 * no timeout of its own to cut that short.
 *
 * The behavioural test drives the REAL client from getAnthropic() — the SDK's
 * own node-fetch transport, its own retry loop — against a local server that
 * accepts every request and never answers. Only `setTimeout` is faked, so the
 * deadline can be walked forward without waiting three real minutes; the
 * sockets are real.
 */

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
  },
}));

import http from 'http';
import type { AddressInfo } from 'net';

const TIMEOUT_MS = 90_000;
const MAX_RETRIES = 1;

it('builds the client with an explicit timeout and retry count', () => {
  let getAnthropic!: typeof import('../services/anthropic').getAnthropic;
  jest.isolateModules(() => {
    ({ getAnthropic } = require('../services/anthropic'));
  });
  const client = getAnthropic();
  expect(client.timeout).toBe(TIMEOUT_MS);
  expect(client.maxRetries).toBe(MAX_RETRIES);
});

describe('against a server that never answers', () => {
  let server: http.Server;
  let requests = 0;
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;

  beforeAll(async () => {
    server = http.createServer(() => {
      requests += 1; // accept, read, never respond
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    // The SDK reads this when the client is constructed.
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  /** Real I/O still has to happen between fake-clock steps. */
  async function until(cond: () => boolean, what: string) {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
    if (!cond()) throw new Error(`never happened: ${what}`);
  }

  it('gives up after two attempts of 90 s each, instead of three of 600 s', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'hrtime', 'performance'] });
    try {
      let getAnthropic!: typeof import('../services/anthropic').getAnthropic;
      let TimeoutError!: typeof import('@anthropic-ai/sdk').APIConnectionTimeoutError;
      jest.isolateModules(() => {
        ({ getAnthropic } = require('../services/anthropic'));
        // The SDK copy this registry loaded — its error classes are its own.
        ({ APIConnectionTimeoutError: TimeoutError } = require('@anthropic-ai/sdk'));
      });

      let outcome: unknown = 'pending';
      getAnthropic()
        .messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 700,
          messages: [{ role: 'user', content: 'hello' }],
        })
        .then(
          () => (outcome = 'resolved'),
          (err) => (outcome = err),
        );

      await until(() => requests === 1, 'first attempt reaches the server');
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(outcome).toBe('pending');
      expect(requests).toBe(1);

      // First attempt times out; the SDK backs off (≤ 0.5 s for the first
      // retry) and tries once more.
      await jest.advanceTimersByTimeAsync(1);
      for (let waited = 0; requests < 2 && waited < 1_000; waited += 50) {
        await jest.advanceTimersByTimeAsync(50);
        await new Promise((r) => setImmediate(r));
      }
      await until(() => requests === 2, 'the one retry reaches the server');
      expect(outcome).toBe('pending');

      await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
      await until(() => outcome !== 'pending', 'the call to fail');
      expect(outcome).toBeInstanceOf(TimeoutError);
      expect(requests).toBe(1 + MAX_RETRIES);
    } finally {
      jest.useRealTimers();
    }
  }, 30_000);
});
