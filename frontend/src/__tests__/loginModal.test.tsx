// LoginModal tests — standalone mocks
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next/link', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children, href, ...props }: any) =>
      React.createElement('a', { href, ...props }, children),
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

const mockSignInWithPassword = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: any[]) => mockSignInWithPassword(...args),
      getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
  getCurrentUser: jest.fn().mockResolvedValue(null),
  getAuthHeader: jest.fn().mockResolvedValue({}),
}));

jest.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => {
    const state = {
      user: null, session: null, isLoading: false,
      setUser: jest.fn(), setSession: jest.fn(), signOut: jest.fn(),
    };
    return selector(state);
  },
}));

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginModal from '@/components/shared/LoginModal';

beforeEach(() => { jest.clearAllMocks(); });

describe('LoginModal', () => {
  test('renders email, password inputs and sign in button', () => {
    render(<LoginModal isOpen={true} onClose={jest.fn()} />);
    expect(screen.getByPlaceholderText('Email')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  test('shows error on failed login', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid credentials' },
    });

    render(<LoginModal isOpen={true} onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'bad@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => { expect(screen.getByText('Invalid credentials')).toBeInTheDocument(); });
  });

  test('calls onSuccess after successful login', async () => {
    const onSuccess = jest.fn();
    const onClose = jest.fn();
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 'tok' } },
      error: null,
    });

    render(<LoginModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'test@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  test('close button dismisses modal', () => {
    const onClose = jest.fn();
    render(<LoginModal isOpen={true} onClose={onClose} />);
    // Find the X button (it's the button without text content "Sign in" or "Create account")
    const buttons = screen.getAllByRole('button');
    const closeBtn = buttons.find((b) => b.querySelector('svg.lucide-x'));
    if (closeBtn) fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
