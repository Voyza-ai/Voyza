// Auth tests — standalone mocks (don't import shared mocks.ts)

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

// Mock framer-motion
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

// Supabase mock with actual callable methods
const mockSignInWithPassword = jest.fn();
const mockSignUp = jest.fn();
const mockResetPasswordForEmail = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: any[]) => mockSignInWithPassword(...args),
      signUp: (...args: any[]) => mockSignUp(...args),
      resetPasswordForEmail: (...args: any[]) => mockResetPasswordForEmail(...args),
      getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
  getCurrentUser: jest.fn().mockResolvedValue(null),
  getAuthHeader: jest.fn().mockResolvedValue({}),
}));

// Auth store mock
const mockSetUser = jest.fn();
const mockSetSession = jest.fn();
jest.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => {
    const state = {
      user: null, session: null, isLoading: false,
      setUser: mockSetUser, setSession: mockSetSession, signOut: jest.fn(),
    };
    return selector(state);
  },
}));

// Trip store mock
let mockCurrentTrip: any = null;
jest.mock('@/store/tripStore', () => ({
  useTripStore: (selector: any) => {
    const state = { currentTrip: mockCurrentTrip };
    return selector(state);
  },
}));

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from '@/app/auth/login/page';
import SignupPage from '@/app/auth/signup/page';
import ForgotPasswordPage from '@/app/auth/forgot-password/page';

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentTrip = null;
});

describe('Login page', () => {
  test('renders email, password, and sign in button', () => {
    render(<LoginPage />);
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter your password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  test('calls signInWithPassword with correct credentials', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'u1', email: 'test@test.com' }, session: { access_token: 'tok' } },
      error: null,
    });

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(mockSignInWithPassword).toHaveBeenCalledWith({ email: 'test@test.com', password: 'password123' });
    });
  });

  test('shows error message on failure', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'bad@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('Invalid login credentials')).toBeInTheDocument();
    });
  });

  test('redirects to /results when tripStore has cities', async () => {
    mockCurrentTrip = { cities: [{ name: 'Paris' }] };
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 'tok' } },
      error: null,
    });

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'pass123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => { expect(mockPush).toHaveBeenCalledWith('/results'); });
  });

  test('redirects to /history when tripStore is empty', async () => {
    mockCurrentTrip = null;
    mockSignInWithPassword.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 'tok' } },
      error: null,
    });

    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'pass123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => { expect(mockPush).toHaveBeenCalledWith('/history'); });
  });
});

describe('Signup page', () => {
  test('validates password match (shows error if mismatch)', async () => {
    render(<SignupPage />);
    fireEvent.change(screen.getByPlaceholderText('Jane Doe'), { target: { value: 'Test User' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'password123!' } });
    fireEvent.change(screen.getByPlaceholderText('Re-enter your password'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => { expect(screen.getByText('Passwords do not match')).toBeInTheDocument(); });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  test('shows password strength: weak/medium/strong', () => {
    render(<SignupPage />);
    const pwInput = screen.getByPlaceholderText('At least 8 characters');

    fireEvent.change(pwInput, { target: { value: 'short' } });
    expect(screen.getByText('Weak')).toBeInTheDocument();

    fireEvent.change(pwInput, { target: { value: 'password1' } });
    expect(screen.getByText('Medium')).toBeInTheDocument();

    fireEvent.change(pwInput, { target: { value: 'password1!' } });
    expect(screen.getByText('Strong')).toBeInTheDocument();
  });

  test('calls signUp with name, email, password', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 'tok' } },
      error: null,
    });

    render(<SignupPage />);
    fireEvent.change(screen.getByPlaceholderText('Jane Doe'), { target: { value: 'Test User' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'password123!' } });
    fireEvent.change(screen.getByPlaceholderText('Re-enter your password'), { target: { value: 'password123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith({
        email: 'test@test.com',
        password: 'password123!',
        options: { data: { full_name: 'Test User' } },
      });
    });
  });
});

describe('Forgot password page', () => {
  test('calls resetPasswordForEmail', async () => {
    mockResetPasswordForEmail.mockResolvedValue({ error: null });

    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@test.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => {
      expect(mockResetPasswordForEmail).toHaveBeenCalledWith('test@test.com', expect.any(Object));
    });
  });

  test('shows success message after submission', async () => {
    mockResetPasswordForEmail.mockResolvedValue({ error: null });

    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@test.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() => {
      expect(screen.getByText('Check your email for a reset link')).toBeInTheDocument();
    });
  });
});
