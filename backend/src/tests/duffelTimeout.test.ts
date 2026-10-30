/**
 * A Duffel call that never answers must give its search slot back.
 *
 * The SDK (3.3.0) sends through node-fetch with no timeout and no signal, and
 * offers no option for either. flights.ts runs every search inside one of six
 * global slots, so one silent Duffel connection held a slot for good, the
 * optimize waiting on it never answered, and six of them stopped flight search
 * for the whole process.
 *
 * These tests drive the REAL SDK and the real flights.ts search path; only
 * node-fetch — the SDK's transport — is replaced, by one that can be told to
 * answer or to hang.
 */

jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    DUFFEL_ACCESS_TOKEN: 'duffel_test_dummy',
  },
}));

// The SDK calls the module export itself: `require("node-fetch")(url, init)`.
jest.mock('node-fetch', () => jest.fn());

import nodeFetch from 'node-fetch';
import { getDuffel } from '../services/duffel';
import { searchFlights } from '../services/flights';

const mockNodeFetch = nodeFetch as unknown as jest.Mock;

/** The deadline in duffel.ts, stated here so the unfixed code fails on time, not on an import. */
const DEADLINE_MS = 90_000;

const hang = () => new Promise<never>(() => {});

/** A Duffel offer-request response with one plain USD offer, as node-fetch would hand it to the SDK. */
function answer() {
  const body = {
    data: {
      offers: [
        {
          id: 'off_1',
          total_amount: '312.40',
          total_currency: 'USD',
          slices: [
            {
              duration: 'PT7H35M',
              segments: [
                {
                  departing_at: '2026-12-03T18:00:00',
                  arriving_at: '2026-12-04T07:35:00',
                  operating_carrier: { name: 'Duffel Airways', iata_code: 'ZZ' },
                  origin: { time_zone: 'America/New_York' },
                  destination: { time_zone: 'Europe/Paris' },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

let errSpy: jest.SpyInstance;
beforeEach(() => {
  mockNodeFetch.mockReset();
  jest.useFakeTimers();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  errSpy.mockRestore();
});

it('abandons a Duffel request that never answers at the deadline, and not before', async () => {
  mockNodeFetch.mockImplementation(hang);
  let outcome: unknown = 'pending';
  getDuffel()
    .offerRequests.create({
      slices: [{ origin: 'JFK', destination: 'CDG', departure_date: '2026-12-03' }] as any,
      passengers: [{ type: 'adult' }],
      return_offers: true,
    } as any)
    .then(
      () => (outcome = 'resolved'),
      (err) => (outcome = err),
    );

  await jest.advanceTimersByTimeAsync(DEADLINE_MS - 1);
  expect(outcome).toBe('pending');
  await jest.advanceTimersByTimeAsync(1);

  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).name).toBe('DuffelTimeoutError');
  expect((outcome as Error).message).toBe('Duffel POST air/offer_requests/ timed out after 90000 ms');
  expect(mockNodeFetch).toHaveBeenCalledTimes(1);
  expect(mockNodeFetch.mock.calls[0][0]).toBe('https://api.duffel.com/air/offer_requests/?return_offers=true');
});

it('passes a normal answer through untouched and leaves no timer behind', async () => {
  mockNodeFetch.mockImplementation(answer);
  const res: any = await getDuffel().offerRequests.create({
    slices: [{ origin: 'JFK', destination: 'CDG', departure_date: '2026-12-03' }] as any,
    passengers: [{ type: 'adult' }],
    return_offers: true,
  } as any);
  expect(res.data.offers[0].id).toBe('off_1');
  expect(typeof res.headers.get).toBe('function'); // flights.ts reads rate-limit headers off this
  expect(jest.getTimerCount()).toBe(0);
});

it('six hung searches no longer wedge flight search: each fails at the deadline, once, and the next search runs', async () => {
  // Six is flights.ts's MAX_CONCURRENT_SEARCHES — every slot in the process.
  mockNodeFetch.mockImplementation(hang);
  const hung = ['CDG', 'AMS', 'BER', 'FCO', 'MAD', 'LIS'].map((dest) =>
    searchFlights({ origin: 'JFK', destination: dest, date: '2026-12-03', travelers: 1 }).then(
      () => 'resolved',
      (err) => err,
    ),
  );

  await jest.advanceTimersByTimeAsync(DEADLINE_MS);
  const outcomes = await Promise.all(hung);
  for (const err of outcomes) {
    expect(err).toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/^Flight search failed: Duffel POST air\/offer_requests\/ timed out after 90000 ms$/),
    });
  }
  // One HTTP call per search: a timeout carries no status, so withRetry does
  // not spend another three attempts on a call that already took 90 s.
  expect(mockNodeFetch).toHaveBeenCalledTimes(6);

  // The slots came back. Before, this search queued behind six dead sockets.
  mockNodeFetch.mockImplementation(answer);
  const offers = await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2026-12-03', travelers: 1 });
  expect(offers).toHaveLength(1);
  expect(offers[0]).toMatchObject({ price: 312.4, currency: 'USD', carrier: 'Duffel Airways' });
});
