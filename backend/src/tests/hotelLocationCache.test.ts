jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * The `booking_locations` cache in front of Booking.com's locations API.
 *
 * Measured against an unreachable Supabase, the original read cost ~7.0s on
 * EVERY hotel search and logged nothing: postgrest-js retries a failed GET
 * three times with 1s, 2s and 4s of backoff sleep, and `getDestinationId`
 * destructured only `data`, so the error went in the bin and the code fell
 * quietly through to the API. The DNS failures were ~80ms of that 7s — the
 * rest was pure backoff.
 *
 * These tests pin the three things that fix depends on: retries off, a bounded
 * read, and an error that gets looked at.
 */

type BuilderCalls = {
  retry: unknown[];
  abortSignal: AbortSignal[];
  selected: string[];
  upserts: unknown[];
};

let calls: BuilderCalls;
let readResult: { data: unknown; error: unknown };
let writeResult: { data: unknown; error: unknown };

jest.mock('../services/supabase', () => ({
  getSupabase: () => {
    const builder: any = {
      select: (cols: string) => {
        calls.selected.push(cols);
        return builder;
      },
      eq: () => builder,
      upsert: (row: unknown) => {
        calls.upserts.push(row);
        return builder;
      },
      retry: (enabled: boolean) => {
        calls.retry.push(enabled);
        return builder;
      },
      abortSignal: (signal: AbortSignal) => {
        calls.abortSignal.push(signal);
        return builder;
      },
      single: () => Promise.resolve(readResult),
      then: (onOk: any, onErr: any) => Promise.resolve(writeResult).then(onOk, onErr),
    };
    return { from: () => builder };
  },
}));

const warnings: { msg: string; meta?: Record<string, unknown> }[] = [];
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: (msg: string, meta?: Record<string, unknown>) => warnings.push({ msg, meta }),
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { searchHotels } from '../services/hotels';

/** A cold cache: PostgREST's real "0 rows" response to `.single()`. */
const PGRST116 = {
  data: null,
  error: {
    code: 'PGRST116',
    message: 'JSON object requested, multiple (or no) rows returned',
    details: 'The result contains 0 rows',
    hint: null,
  },
};

/** Supabase unreachable: the shape postgrest-js returns for a thrown fetch. */
const TRANSPORT_FAILURE = {
  data: null,
  error: {
    code: '',
    message: 'TypeError: fetch failed',
    details: 'Caused by: Error: getaddrinfo ENOTFOUND db.supabase.co (ENOTFOUND)',
    hint: '',
  },
};

/** Stubs the locations lookup, then the hotel search, in call order. */
function stubBookingApis() {
  mockFetch
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ dest_id: '-117543', dest_type: 'city' }]),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: [] }),
    });
}

const search = () =>
  searchHotels({
    city: 'Florence',
    checkin: '2027-04-10',
    checkout: '2027-04-13',
    adults: 2,
    rooms: 1,
  });

/** URLs the stubbed fetch was called with. */
const fetchedUrls = () => mockFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  jest.clearAllMocks();
  warnings.length = 0;
  calls = { retry: [], abortSignal: [], selected: [], upserts: [] };
  readResult = PGRST116;
  writeResult = { data: null, error: null };
});

describe('booking_locations cache read', () => {
  it('disables postgrest retries — the 1s/2s/4s backoff ladder is never worth it on a cache', async () => {
    stubBookingApis();
    await search();

    // If this ever regresses to the default, an unreachable Supabase puts 7s
    // of backoff sleep on every single hotel search.
    expect(calls.retry).toContain(false);
  });

  it('bounds the read with an abort signal, so a hanging Supabase cannot stall a search', async () => {
    stubBookingApis();
    await search();

    expect(calls.abortSignal.length).toBeGreaterThan(0);
    const signal = calls.abortSignal[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false); // bounded, but not already spent
  });

  it('serves a cache hit without touching the locations API', async () => {
    readResult = { data: { dest_id: '-117543', dest_type: 'city' }, error: null };
    // Only the search call is stubbed: a locations call would consume this and
    // leave the search with nothing, failing the assertions below.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: [] }),
    });

    await search();

    expect(fetchedUrls().some((u) => u.includes('/v1/hotels/locations'))).toBe(false);
    expect(fetchedUrls().some((u) => u.includes(`dest_id=-117543`))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('treats PGRST116 as an ordinary miss: falls through, and stays quiet', async () => {
    stubBookingApis();
    await search();

    expect(fetchedUrls().some((u) => u.includes('/v1/hotels/locations'))).toBe(true);
    // A cold cache is the normal case on a city we haven't seen. Warning here
    // would bury the real failures below in noise.
    expect(warnings.filter((w) => w.msg.includes('cache read failed'))).toEqual([]);
  });

  it('warns when the read actually fails, instead of swallowing it into {data: null}', async () => {
    readResult = TRANSPORT_FAILURE;
    stubBookingApis();
    await search();

    const warned = warnings.find((w) => w.msg.includes('cache read failed'));
    expect(warned).toBeDefined();
    expect(warned!.meta).toMatchObject({
      city: 'Florence',
      error: 'TypeError: fetch failed',
    });
  });

  it('still returns the right destination when the cache read fails', async () => {
    readResult = TRANSPORT_FAILURE;
    stubBookingApis();
    await search();

    // Correctness was never the problem — the fallback works. Keep it that way.
    expect(fetchedUrls().some((u) => u.includes('dest_id=-117543'))).toBe(true);
  });
});

describe('booking_locations cache write', () => {
  it('bounds the write too — it is the last thing before the caller gets results', async () => {
    stubBookingApis();
    await search();

    expect(calls.upserts).toHaveLength(1);
    // One signal for the read, one for the write.
    expect(calls.abortSignal.length).toBeGreaterThanOrEqual(2);
  });

  it('warns when the write fails rather than discarding the error', async () => {
    writeResult = { data: null, error: { code: '', message: 'TypeError: fetch failed' } };
    stubBookingApis();
    await search();

    expect(warnings.some((w) => w.msg.includes('cache write failed'))).toBe(true);
  });

  it('a failed write does not fail the search', async () => {
    writeResult = { data: null, error: { code: '', message: 'TypeError: fetch failed' } };
    stubBookingApis();

    await expect(search()).resolves.toEqual([]);
  });
});
