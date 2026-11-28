/**
 * services/supabase.ts with SUPABASE_KEY_VIA_PROXY=true: the placeholder
 * `Authorization: Bearer <placeholder>` is dropped (the proxy adds the real key
 * as `apikey`); a user's own bearer token is kept. Off by default.
 */
jest.mock('../config/env', () => ({ env: { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'proxy-injected' } }));

describe('Supabase client key handling', () => {
  const realFetch = global.fetch;
  let seen: Headers[] = [];
  beforeEach(() => {
    seen = [];
    jest.resetModules();
    global.fetch = jest.fn(async (_url: any, init: any) => {
      seen.push(new Headers(init?.headers));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;
  });
  afterAll(() => { global.fetch = realFetch; delete process.env.SUPABASE_KEY_VIA_PROXY; });

  it('proxy mode: no placeholder Authorization header, apikey still sent', async () => {
    process.env.SUPABASE_KEY_VIA_PROXY = 'true';
    const { getSupabase } = require('../services/supabase');
    await getSupabase().from('trips').select('id').limit(1);
    expect(seen[0].get('authorization')).toBeNull();
    expect(seen[0].get('apikey')).toBe('proxy-injected');
  });

  it('proxy mode: a real user token is passed through', async () => {
    process.env.SUPABASE_KEY_VIA_PROXY = 'true';
    const { getSupabase } = require('../services/supabase');
    await getSupabase().auth.getUser('user-jwt-123').catch(() => undefined);
    expect(seen.some((h) => h.get('authorization') === 'Bearer user-jwt-123')).toBe(true);
  });

  it('default: headers unchanged', async () => {
    delete process.env.SUPABASE_KEY_VIA_PROXY;
    const { getSupabase } = require('../services/supabase');
    await getSupabase().from('trips').select('id').limit(1);
    expect(seen[0].get('authorization')).toBe('Bearer proxy-injected');
  });
});
