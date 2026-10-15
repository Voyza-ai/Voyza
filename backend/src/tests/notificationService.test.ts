jest.mock('../config/env', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

const mockWarn = jest.fn();
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: (...args: any[]) => mockWarn(...args), error: jest.fn() },
}));

// Per-table supabase mock: user_profiles lookups resolve `profileResponse`,
// notification inserts record their payload and resolve `insertResponse`.
let profileResponse: any = { data: { preferences: {}, deleted_at: null }, error: null };
let insertResponse: any = { error: null };
const insertedRows: any[] = [];

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === 'user_profiles') {
        const chain: any = {};
        chain.select = jest.fn().mockReturnValue(chain);
        chain.eq = jest.fn().mockReturnValue(chain);
        chain.single = jest.fn().mockImplementation(() => Promise.resolve(profileResponse));
        return chain;
      }
      if (table === 'notifications') {
        return {
          insert: jest.fn().mockImplementation((row: any) => {
            insertedRows.push(row);
            return Promise.resolve(insertResponse);
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import {
  createNotification,
  isNotificationTypeEnabled,
} from '../services/notifications';

beforeEach(() => {
  jest.clearAllMocks();
  insertedRows.length = 0;
  profileResponse = { data: { preferences: {}, deleted_at: null }, error: null };
  insertResponse = { error: null };
});

describe('isNotificationTypeEnabled', () => {
  it('defaults ON for empty/missing preferences', () => {
    expect(isNotificationTypeEnabled({}, 'canvas_invite')).toBe(true);
    expect(isNotificationTypeEnabled(null, 'canvas_invite')).toBe(true);
    expect(isNotificationTypeEnabled(undefined, 'suggestion_decided')).toBe(true);
  });

  it('only an explicit false opts out', () => {
    expect(
      isNotificationTypeEnabled({ notifications: { canvas_invite: false } }, 'canvas_invite'),
    ).toBe(false);
    // truthy / missing / unrelated keys stay ON
    expect(
      isNotificationTypeEnabled({ notifications: { canvas_invite: true } }, 'canvas_invite'),
    ).toBe(true);
    expect(
      isNotificationTypeEnabled({ notifications: { suggestion_decided: false } }, 'canvas_invite'),
    ).toBe(true);
    expect(isNotificationTypeEnabled({ emailNotifications: false }, 'canvas_invite')).toBe(true);
  });
});

describe('createNotification', () => {
  const input = {
    userId: 'u1',
    type: 'canvas_invite' as const,
    title: 'You were invited',
    body: 'body',
    data: { tripId: 't1' },
  };

  it('inserts with snake_case mapping and defaults', async () => {
    await createNotification(input);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toEqual({
      user_id: 'u1',
      type: 'canvas_invite',
      title: 'You were invited',
      body: 'body',
      data: { tripId: 't1' },
    });
  });

  it('skips insert when the user opted out of the type', async () => {
    profileResponse = {
      data: { preferences: { notifications: { canvas_invite: false } }, deleted_at: null },
      error: null,
    };
    await createNotification(input);
    expect(insertedRows).toHaveLength(0);
  });

  it('skips recipients pending deletion — except the deletion notice itself', async () => {
    profileResponse = { data: { preferences: {}, deleted_at: '2026-09-01' }, error: null };
    await createNotification(input);
    expect(insertedRows).toHaveLength(0);

    await createNotification({
      userId: 'u1',
      type: 'account_deletion_scheduled',
      title: 'Deletion scheduled',
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].type).toBe('account_deletion_scheduled');
  });

  it('skips when the recipient has no profile', async () => {
    profileResponse = { data: null, error: { message: 'not found' } };
    await createNotification(input);
    expect(insertedRows).toHaveLength(0);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('never throws — insert errors are swallowed with a warning', async () => {
    insertResponse = { error: { message: 'boom' } };
    await expect(createNotification(input)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      'createNotification: insert failed (non-fatal)',
      expect.objectContaining({ message: 'boom' }),
    );
  });
});
