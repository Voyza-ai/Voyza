// ProtectedRoute tests — standalone mocks
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/history',
}));

let mockUser: any = null;
let mockIsLoading = false;

jest.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => {
    const state = {
      user: mockUser,
      session: null,
      isLoading: mockIsLoading,
      setUser: jest.fn(),
      setSession: jest.fn(),
      signOut: jest.fn(),
    };
    return selector(state);
  },
}));

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import ProtectedRoute from '@/components/shared/ProtectedRoute';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = null;
  mockIsLoading = false;
});

describe('ProtectedRoute', () => {
  test('shows spinner while isLoading is true', () => {
    mockIsLoading = true;
    render(
      <ProtectedRoute>
        <div>Protected content</div>
      </ProtectedRoute>
    );
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  test('redirects to /auth/login when no user', async () => {
    mockIsLoading = false;
    mockUser = null;
    render(
      <ProtectedRoute>
        <div>Protected content</div>
      </ProtectedRoute>
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/auth/login?redirect=%2Fhistory');
    });
  });

  test('renders children when user exists', () => {
    mockUser = { id: 'u1', email: 'test@test.com' };
    render(
      <ProtectedRoute>
        <div>Protected content</div>
      </ProtectedRoute>
    );
    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });
});
