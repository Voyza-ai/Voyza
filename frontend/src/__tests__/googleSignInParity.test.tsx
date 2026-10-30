/**
 * D-18: Google sign-in was disabled on /auth/login ("Coming soon") but live
 * in the in-app login modal. The modal's flow is the real one — Supabase
 * `signInWithOAuth({ provider: 'google' })` back to /auth/callback, which
 * exchanges the code (oauthReturnTo.test.tsx) — so the login page now offers
 * the same flow instead of a dead button.
 */
const mockPush = jest.fn();
let mockParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockParams,
}));

jest.mock('next/link', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children, href, ...props }: any) => React.createElement('a', { href, ...props }, children),
  };
});

jest.mock('framer-motion', () => {
  const React = require('react');
  const motion = new Proxy({}, {
    get: (_t: any, prop: string) =>
      React.forwardRef((props: any, ref: any) => {
        const { initial, animate, exit, transition, variants, whileHover, whileTap, onAnimationComplete, layout, layoutId, ...rest } = props;
        return React.createElement(prop, { ...rest, ref });
      }),
  });
  return { motion, AnimatePresence: ({ children }: any) => children };
});

const mockOAuth = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOAuth: (...args: any[]) => mockOAuth(...args),
      signInWithPassword: jest.fn(),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

jest.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => selector({ setUser: jest.fn(), setSession: jest.fn() }),
}));

let mockTrip: any = null;
jest.mock('@/store/tripStore', () => ({
  useTripStore: (selector: any) => selector({ currentTrip: mockTrip }),
}));

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from '@/app/auth/login/page';
import LoginModal from '@/components/shared/LoginModal';

beforeEach(() => {
  jest.clearAllMocks();
  mockOAuth.mockResolvedValue({ error: null });
  mockParams = new URLSearchParams();
  mockTrip = null;
  sessionStorage.clear();
});

const googleCall = () => mockOAuth.mock.calls[0]?.[0];

describe('Google sign-in is the same on both doors', () => {
  it('the modal starts the Supabase Google OAuth back to /auth/callback (the reference)', async () => {
    render(<LoginModal isOpen onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    await waitFor(() => expect(mockOAuth).toHaveBeenCalledTimes(1));
    expect(googleCall()).toEqual({ provider: 'google', options: { redirectTo: `${window.location.origin}/auth/callback` } });
  });

  it('/auth/login: the button is enabled and starts the same flow', async () => {
    render(<LoginPage />);
    const btn = screen.getByRole('button', { name: /Continue with Google/ });
    // Before: disabled, with a "Coming soon" tooltip.
    expect(btn).toBeEnabled();
    expect(screen.queryByText('Coming soon')).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(mockOAuth).toHaveBeenCalledTimes(1));
    expect(googleCall()).toEqual({ provider: 'google', options: { redirectTo: `${window.location.origin}/auth/callback` } });
  });

  it('/auth/login returns where the email sign-in would: ?redirect=, else the trip, else My Trips', async () => {
    mockParams = new URLSearchParams('redirect=/canvas/t1');
    const { unmount } = render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    await waitFor(() => expect(sessionStorage.getItem('voyza.oauth_return_to')).toBe('/canvas/t1'));
    unmount();

    mockParams = new URLSearchParams();
    mockTrip = { cities: [{ name: 'Paris' }] };
    const r2 = render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    await waitFor(() => expect(sessionStorage.getItem('voyza.oauth_return_to')).toBe('/results'));
    r2.unmount();

    mockTrip = null;
    render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    await waitFor(() => expect(sessionStorage.getItem('voyza.oauth_return_to')).toBe('/history'));
  });

  it('/auth/login shows the provider error and re-enables the button', async () => {
    mockOAuth.mockResolvedValue({ error: { message: 'provider is not enabled' } });
    render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    expect(await screen.findByText('provider is not enabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeEnabled();
  });
});
