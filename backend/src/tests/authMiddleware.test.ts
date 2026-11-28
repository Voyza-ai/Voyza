let getUserResult: any = { data: { user: null }, error: null };
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({ auth: { getUser: async () => getUserResult } }),
}));

import { requireAuth, isAuthServiceDown } from '../middleware/auth';

const run = async () => {
  const next = jest.fn();
  await requireAuth({ headers: { authorization: 'Bearer tok' } } as any, {} as any, next);
  return next.mock.calls[0][0];
};

describe('requireAuth', () => {
  it('a bad token is 401', async () => {
    getUserResult = { data: { user: null }, error: { name: 'AuthApiError', status: 401, message: 'invalid JWT' } };
    expect((await run()).statusCode).toBe(401);
  });
  it('Supabase unreachable is a retryable 503, not a sign-out (found live: a DNS blip gave a 401)', async () => {
    getUserResult = { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' } };
    expect((await run()).statusCode).toBe(503);
    getUserResult = { data: { user: null }, error: { name: 'AuthApiError', status: 502, message: 'bad gateway' } };
    expect((await run()).statusCode).toBe(503);
  });
  it('a good token passes', async () => {
    getUserResult = { data: { user: { id: 'u1' } }, error: null };
    expect(await run()).toBeUndefined();
  });
  it('isAuthServiceDown', () => {
    expect(isAuthServiceDown(null)).toBe(false);
    expect(isAuthServiceDown({ name: 'AuthApiError', status: 403 })).toBe(false);
    expect(isAuthServiceDown({ name: 'AuthRetryableFetchError' })).toBe(true);
  });
});

it('an error of unknown shape is still a 401', async () => {
  getUserResult = { data: { user: null }, error: { message: 'invalid' } };
  expect((await run()).statusCode).toBe(401);
});
