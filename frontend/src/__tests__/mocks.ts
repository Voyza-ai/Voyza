// Shared mock setup for all tests

// Mock next/navigation
export const mockPush = jest.fn();
export const mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useSearchParams: () => mockSearchParams,
  useParams: () => ({ tripId: 'trip-test-123' }),
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
  const motion = new Proxy(
    {},
    {
      get: (_target: any, prop: string) => {
        return React.forwardRef((props: any, ref: any) => {
          const {
            initial, animate, exit, transition, variants, whileHover,
            whileTap, onAnimationComplete, layout, layoutId,
            ...rest
          } = props;
          return React.createElement(prop, { ...rest, ref });
        });
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: any) => children,
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

// Mock useCanvasRealtime
jest.mock('@/hooks/useCanvasRealtime', () => ({
  useCanvasRealtime: () => ({
    canvasState: null,
    suggestions: [],
    isConnected: true,
    updateState: jest.fn(),
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
  interpretPlan: jest.fn().mockResolvedValue({}),
  editPlan: jest.fn().mockResolvedValue({ message: 'Done', trip: null }),
  getCanvasSession: jest.fn().mockResolvedValue({ session: { state: null }, role: 'viewer' }),
  saveCanvas: jest.fn().mockResolvedValue({ saved: true, savedAt: new Date().toISOString() }),
  getCanvasSuggestions: jest.fn().mockResolvedValue({ suggestions: [] }),
  postCanvasSuggestion: jest.fn().mockResolvedValue({ suggestion: {} }),
  updateSuggestionStatus: jest.fn().mockResolvedValue({ suggestion: {} }),
  inviteToCanvas: jest.fn().mockResolvedValue({ member: {}, inviteLink: 'https://voyza.app/invite/abc' }),
}));

// Mock styled-jsx (used by Flowchart)
jest.mock('styled-jsx/style', () => {
  return function MockStyle() { return null; };
});
