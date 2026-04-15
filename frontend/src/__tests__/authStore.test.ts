// Mock supabase before importing authStore
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signOut: jest.fn().mockResolvedValue({}),
    },
  },
}));

import { useAuthStore } from '@/store/authStore';

beforeEach(() => {
  // Reset store state
  useAuthStore.setState({ user: null, session: null, isLoading: true });
});

describe('authStore', () => {
  test('initial state: user null, session null', () => {
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.session).toBeNull();
  });

  test('setUser updates user', () => {
    const mockUser = { id: 'u1', email: 'test@test.com' } as any;
    useAuthStore.getState().setUser(mockUser);
    expect(useAuthStore.getState().user).toEqual(mockUser);
  });

  test('setSession updates session', () => {
    const mockSession = { access_token: 'tok123' } as any;
    useAuthStore.getState().setSession(mockSession);
    expect(useAuthStore.getState().session).toEqual(mockSession);
  });

  test('signOut clears user and session', async () => {
    useAuthStore.setState({
      user: { id: 'u1' } as any,
      session: { access_token: 'tok' } as any,
    });

    // jsdom doesn't allow redefining location, so use delete + assign
    const origHref = window.location.href;
    delete (window as any).location;
    (window as any).location = { href: '' };

    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();

    // Restore
    delete (window as any).location;
    (window as any).location = new URL(origHref);
  });
});
