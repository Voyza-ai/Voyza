// HomeAuthButton tests — the auth-aware corner button on the welcome page.
// Mirrors navbar.test.tsx conventions: standalone next/link + authStore mocks.
jest.mock('next/link', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children, href, ...props }: any) =>
      React.createElement('a', { href, ...props }, children),
  };
});

let mockUser: any = null;
const mockSignOut = jest.fn();

jest.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => {
    const state = {
      user: mockUser,
      session: null,
      isLoading: false,
      setUser: jest.fn(),
      setSession: jest.fn(),
      signOut: mockSignOut,
    };
    return selector(state);
  },
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import HomeAuthButton from '@/components/welcome/HomeAuthButton';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = null;
});

describe('HomeAuthButton', () => {
  test('shows "Log in" when user is null and clicking it opens the modal', () => {
    const onLoginClick = jest.fn();
    render(<HomeAuthButton onLoginClick={onLoginClick} />);
    const btn = screen.getByText('Log in');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onLoginClick).toHaveBeenCalled();
  });

  test('shows initials avatar instead of "Log in" when signed in', () => {
    mockUser = {
      id: 'u1',
      email: 'jane@test.com',
      user_metadata: { full_name: 'Jane Doe' },
    };
    render(<HomeAuthButton onLoginClick={jest.fn()} />);
    expect(screen.getByText('JD')).toBeInTheDocument();
    expect(screen.queryByText('Log in')).not.toBeInTheDocument();
  });

  test('falls back to email initial when no full_name', () => {
    mockUser = { id: 'u1', email: 'sam@test.com', user_metadata: {} };
    render(<HomeAuthButton onLoginClick={jest.fn()} />);
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  test('dropdown shows email, My Trips link, and Sign out on avatar click', () => {
    mockUser = { id: 'u1', email: 'jane@test.com', user_metadata: {} };
    render(<HomeAuthButton onLoginClick={jest.fn()} />);
    fireEvent.click(screen.getByText('J'));
    expect(screen.getByText('jane@test.com')).toBeInTheDocument();
    expect(screen.getByText('My Trips').closest('a')).toHaveAttribute('href', '/history');
    expect(screen.getByText('Sign out')).toBeInTheDocument();
  });

  test('"Sign out" calls authStore.signOut', () => {
    mockUser = { id: 'u1', email: 'jane@test.com', user_metadata: {} };
    render(<HomeAuthButton onLoginClick={jest.fn()} />);
    fireEvent.click(screen.getByText('J'));
    fireEvent.click(screen.getByText('Sign out'));
    expect(mockSignOut).toHaveBeenCalled();
  });
});
