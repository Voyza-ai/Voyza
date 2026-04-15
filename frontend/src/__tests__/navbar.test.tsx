// Navbar tests — standalone mocks
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

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
import Navbar from '@/components/shared/Navbar';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = null;
});

describe('Navbar', () => {
  test('shows "Log in" and "Sign up" when user is null', () => {
    render(<Navbar />);
    expect(screen.getByText('Log in')).toBeInTheDocument();
    expect(screen.getByText('Sign up')).toBeInTheDocument();
  });

  test('shows avatar with correct initials when user is logged in', () => {
    mockUser = {
      id: 'u1',
      email: 'jane@test.com',
      user_metadata: { full_name: 'Jane Doe' },
    };
    render(<Navbar />);
    expect(screen.getByText('JD')).toBeInTheDocument();
    expect(screen.queryByText('Log in')).not.toBeInTheDocument();
  });

  test('dropdown appears on avatar click', () => {
    mockUser = { id: 'u1', email: 'jane@test.com', user_metadata: {} };
    render(<Navbar />);
    fireEvent.click(screen.getByText('J'));
    expect(screen.getByText('jane@test.com')).toBeInTheDocument();
    expect(screen.getByText('My Trips')).toBeInTheDocument();
    expect(screen.getByText('Sign out')).toBeInTheDocument();
  });

  test('"My Trips" link navigates to /history', () => {
    mockUser = { id: 'u1', email: 'jane@test.com', user_metadata: {} };
    render(<Navbar />);
    fireEvent.click(screen.getByText('J'));
    const link = screen.getByText('My Trips');
    expect(link.closest('a')).toHaveAttribute('href', '/history');
  });

  test('"Sign out" calls authStore.signOut', () => {
    mockUser = { id: 'u1', email: 'jane@test.com', user_metadata: {} };
    render(<Navbar />);
    fireEvent.click(screen.getByText('J'));
    fireEvent.click(screen.getByText('Sign out'));
    expect(mockSignOut).toHaveBeenCalled();
  });
});
