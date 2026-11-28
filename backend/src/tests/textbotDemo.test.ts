/** DEMO MODE trip loader (services/textbot/runtime.ts): file trip + preset members, no DB. */
jest.mock('../config/env', () => ({ env: { SUPABASE_URL: 'https://t.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', PORT: 4000 } }));
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DemoTripLoader } from '../services/textbot/runtime';

describe('DemoTripLoader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-'));
  const file = join(dir, 'trip.json');
  writeFileSync(file, JSON.stringify({ id: 't-demo', title: 'Venice → Rome', cities: [] }));

  it('loads the file trip and maps phones to roles; bad entries are dropped', async () => {
    const d = new DemoTripLoader(file, '(215) 555-0001:owner, +12155550002:editor, nonsense:owner, +12155550003:admin');
    expect(d.tripId).toBe('t-demo');
    expect(d.people).toEqual([
      { phone: '+12155550001', userId: 'demo-user-1', role: 'owner' },
      { phone: '+12155550002', userId: 'demo-user-2', role: 'editor' },
      { phone: '+12155550003', userId: 'demo-user-4', role: 'viewer' },
    ]);
    expect((await d.load('t-demo'))?.title).toBe('Venice → Rome');
    expect(await d.load('other')).toBeNull();
    expect([...(await d.members('t-demo'))]).toEqual([
      ['demo-user-1', 'owner'], ['demo-user-2', 'editor'], ['demo-user-4', 'viewer'],
    ]);
  });
});
