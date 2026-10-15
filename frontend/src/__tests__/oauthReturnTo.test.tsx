// OAuth callback redirect — standalone mocks (don't import shared mocks.ts)

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

jest.mock('next/link', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children, href, ...props }: any) =>
      React.createElement('a', { href, ...props }, children),
  };
});

// Inlined rather than referencing an outer const: jest.mock factories are
// hoisted above module-scope declarations.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: { access_token: 'tok', user: { id: 'u1', email: 'a@b.c' } } },
      }),
      exchangeCodeForSession: jest.fn(),
    },
  },
}));

jest.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) =>
    selector({ setUser: jest.fn(), setSession: jest.fn() }),
}));

jest.mock('@/lib/canvasHandoff', () => ({
  readCanvasIntent: () => null,
  clearCanvasIntent: jest.fn(),
  resolveCanvasTripId: jest.fn(),
}));

import React from 'react';
import { render, waitFor } from '@testing-library/react';
import AuthCallbackPage from '@/app/auth/callback/page';

/**
 * LoginModal stores the page the modal was opened from so sign-in can return
 * you there. That's right for a deep link, and wrong for the pages people sign
 * in *from*: landing on the marketing page again reads as "nothing happened".
 * Those cases belong on the hub (/main), which is where Browse / Describe /
 * View-or-edit-trips live.
 */
describe('OAuth callback redirect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
  });

  const landsOn = async (saved: string | null) => {
    if (saved !== null) sessionStorage.setItem('voyza.oauth_return_to', saved);
    render(<AuthCallbackPage />);
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    return mockPush.mock.calls[0][0];
  };

  it('sends you to the hub after signing in from the landing page', async () => {
    expect(await landsOn('/')).toBe('/main');
  });

  it('sends you to the hub when the landing page carried query params', async () => {
    expect(await landsOn('/?ref=twitter')).toBe('/main');
  });

  it('sends you to the hub after signing in from an auth screen', async () => {
    expect(await landsOn('/auth/login')).toBe('/main');
  });

  it('defaults to the hub when nothing was saved', async () => {
    expect(await landsOn(null)).toBe('/main');
  });

  it('still returns you to a real destination you were deep-linked to', async () => {
    expect(await landsOn('/results?tripId=abc123')).toBe('/results?tripId=abc123');
  });

  it('still returns you to a plain in-app page', async () => {
    expect(await landsOn('/history')).toBe('/history');
  });

  it('consumes the stored path so a later sign-in does not reuse it', async () => {
    await landsOn('/history');
    expect(sessionStorage.getItem('voyza.oauth_return_to')).toBeNull();
  });

  // A stored value only has to start with "/" to look local, which is not the
  // same as being local. These are the shapes that escape the origin.
  it.each([
    ['//evil.com', 'protocol-relative URL'],
    ['//evil.com/phish', 'protocol-relative with a path'],
    ['/\\evil.com', 'backslash some browsers normalise to a slash'],
    ['///evil.com', 'triple slash'],
    ['https://evil.com', 'absolute URL'],
    ['javascript:alert(1)', 'script scheme'],
  ])('refuses to redirect to %s (%s)', async (hostile) => {
    expect(await landsOn(hostile)).toBe('/main');
  });
});
