import { safeReturnPath } from '@/lib/authEmail';

jest.mock('@/lib/supabase', () => ({ supabase: null }));

describe('safeReturnPath', () => {
  it('keeps a path on this site, with its query', () => {
    expect(safeReturnPath('/results?tripId=t1&share=x')).toBe('/results?tripId=t1&share=x');
  });
  it('refuses other sites however they are spelled', () => {
    for (const raw of ['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com/x', 'javascript:alert(1)']) {
      expect(safeReturnPath(raw)).toBeNull();
    }
  });
  it('skips the landing page and the auth screens', () => {
    expect(safeReturnPath('/')).toBeNull();
    expect(safeReturnPath('/auth/login')).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
  });
});
