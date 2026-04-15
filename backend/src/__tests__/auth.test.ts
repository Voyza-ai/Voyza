import { Request, Response, NextFunction } from 'express';

// Mock supabase
const mockGetUser = jest.fn();
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    auth: { getUser: mockGetUser },
    from: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: { id: 'trip-1' }, error: null }),
        }),
      }),
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          neq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: [], error: null }),
          }),
          single: jest.fn().mockResolvedValue({ data: null, error: null }),
        }),
        in: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    }),
  }),
}));

import { requireAuth } from '../middleware/auth';

function mockReq(headers: Record<string, string> = {}): Partial<Request> {
  return { headers } as any;
}

function mockRes(): Partial<Response> {
  return {} as any;
}

let nextCalled = false;
let nextError: any = null;
const mockNext: NextFunction = (err?: any) => {
  nextCalled = true;
  nextError = err ?? null;
};

beforeEach(() => {
  jest.clearAllMocks();
  nextCalled = false;
  nextError = null;
});

describe('requireAuth middleware', () => {
  test('returns 401 with no Authorization header', async () => {
    await requireAuth(mockReq() as Request, mockRes() as Response, mockNext);
    expect(nextCalled).toBe(true);
    expect(nextError).toBeTruthy();
    expect(nextError.statusCode).toBe(401);
  });

  test('returns 401 with invalid JWT', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });

    await requireAuth(
      mockReq({ authorization: 'Bearer invalid-token' }) as Request,
      mockRes() as Response,
      mockNext,
    );
    expect(nextError).toBeTruthy();
    expect(nextError.statusCode).toBe(401);
  });

  test('calls next() and sets req.user with valid JWT', async () => {
    const fakeUser = { id: 'u1', email: 'test@test.com' };
    mockGetUser.mockResolvedValue({ data: { user: fakeUser }, error: null });

    const req = mockReq({ authorization: 'Bearer valid-token' });
    await requireAuth(req as Request, mockRes() as Response, mockNext);

    expect(nextCalled).toBe(true);
    expect(nextError).toBeNull();
    expect((req as any).user).toEqual(fakeUser);
  });
});
