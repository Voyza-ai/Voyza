// Shared mock setup for all tests

// Mock next/navigation
export const mockPush = jest.fn();
export const mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useSearchParams: () => mockSearchParams,
  useParams: () => ({ tripId: 'trip-test-123' }),
  usePathname: () => '/test',
}));

// Mock next/link
jest.mock('next/link', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children, href, ...props }: any) =>
      React.createElement('a', { href, ...props }, children),
  };
});

// Mock framer-motion to avoid animation complexity in tests
jest.mock('framer-motion', () => {
  const React = require('react');
  // Cache one component per tag: returning a FRESH component from every
  // `motion.div` access changes the element type on each re-render, which
  // makes React unmount/remount the subtree — DOM nodes grabbed by findBy*
  // right before a state flip end up detached and assertions flake.
  const motionCache: Record<string, any> = {};
  const motion = new Proxy(
    {},
    {
      get: (_target: any, prop: string) => {
        motionCache[prop] ??= React.forwardRef((props: any, ref: any) => {
          const {
            initial, animate, exit, transition, variants, whileHover,
            whileTap, onAnimationComplete, layout, layoutId,
            ...rest
          } = props;
          return React.createElement(prop, { ...rest, ref });
        });
        return motionCache[prop];
      },
    },
  );
  const ReorderGroup = React.forwardRef(({ children, as: Tag = 'div', values, onReorder, ...rest }: any, ref: any) => {
    const { axis, ...domProps } = rest;
    return React.createElement(Tag, { ...domProps, ref }, children);
  });
  const ReorderItem = React.forwardRef(({ children, as: Tag = 'div', value, dragListener, whileDrag, ...rest }: any, ref: any) => {
    const { transition, ...domProps } = rest;
    return React.createElement(Tag, { ...domProps, ref }, children);
  });

  return {
    motion,
    AnimatePresence: ({ children }: any) => children,
    Reorder: { Group: ReorderGroup, Item: ReorderItem },
    useAnimation: () => ({ start: jest.fn() }),
    useMotionValue: (val: number) => ({ get: () => val, set: jest.fn() }),
  };
});

// Mock supabase
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
    channel: jest.fn().mockReturnValue({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn().mockReturnValue('SUBSCRIBED'),
      unsubscribe: jest.fn(),
    }),
  },
  getCurrentUser: jest.fn().mockResolvedValue(null),
  getAuthHeader: jest.fn().mockResolvedValue({}),
}));

// Mock authStore — logged-in user by default for canvas/protected tests
jest.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => {
    const state = {
      user: { id: 'u1', email: 'test@test.com', user_metadata: {} },
      session: { access_token: 'tok' },
      isLoading: false,
      setUser: jest.fn(),
      setSession: jest.fn(),
      signOut: jest.fn(),
    };
    return selector(state);
  },
}));

// Mock useCanvasRealtime
jest.mock('@/hooks/useCanvasRealtime', () => ({
  useCanvasRealtime: () => ({
    canvasState: null,
    suggestions: [],
    isConnected: true,
    updateState: jest.fn(),
    presence: [],
    remoteOp: null,
    broadcastOp: jest.fn(),
  }),
}));

// Mock API module — all functions return empty/default by default
jest.mock('@/lib/api', () => ({
  searchFlights: jest.fn().mockResolvedValue([]),
  searchHotels: jest.fn().mockResolvedValue([]),
  searchTrains: jest.fn().mockResolvedValue([]),
  optimizeTrip: jest.fn().mockResolvedValue(null),
  compareLeg: jest.fn().mockResolvedValue(null),
  suggestDestinations: jest.fn().mockResolvedValue([]),
  getShareLink: jest.fn().mockResolvedValue({ mode: 'view', url: 'https://voyza.test/canvas/trip-1?share=tok' }),
  updateShareLink: jest.fn().mockResolvedValue({ mode: 'edit', url: 'https://voyza.test/canvas/trip-1?share=tok' }),
  joinCanvasByLink: jest.fn().mockResolvedValue({ role: 'editor', joined: true }),
  applyRoleToMembers: jest.fn().mockResolvedValue({ updated: 2, role: 'editor' }),
  listTripMembers: jest.fn().mockResolvedValue({ members: [] }),
  updateMemberRole: jest.fn().mockResolvedValue({ member: {} }),
  removeMember: jest.fn().mockResolvedValue({ success: true }),
  interpretPlan: jest.fn().mockResolvedValue({}),
  editPlan: jest.fn().mockResolvedValue({ type: 'answer', reply: 'Done' }),
  planChat: jest.fn().mockResolvedValue({ type: 'answer', reply: 'Done' }),
  planChatSuggestions: jest.fn().mockResolvedValue({
    suggestions: ['Why this order of cities?', 'Make Barcelona cheaper', 'Pin Rome to dates', 'Add a day'],
  }),
  getCanvasSession: jest.fn().mockResolvedValue({ session: { state: null }, role: 'viewer' }),
  saveCanvas: jest.fn().mockResolvedValue({ saved: true, savedAt: new Date().toISOString() }),
  getCanvasSuggestions: jest.fn().mockResolvedValue({ suggestions: [] }),
  postCanvasSuggestion: jest.fn().mockResolvedValue({ suggestion: {} }),
  updateSuggestionStatus: jest.fn().mockResolvedValue({ suggestion: {} }),
  inviteToCanvas: jest.fn().mockResolvedValue({ member: {}, inviteLink: 'https://voyza.app/invite/abc' }),
  saveTrip: jest.fn().mockResolvedValue({ tripId: 'trip-123', trip: {} }),
  getTrips: jest.fn().mockResolvedValue({ trips: [] }),
  getTrip: jest.fn().mockResolvedValue({ trip: {} }),
  deleteTrip: jest.fn().mockResolvedValue({ success: true }),
}));

// Mock styled-jsx (used by Flowchart)
jest.mock('styled-jsx/style', () => {
  return function MockStyle() { return null; };
});
