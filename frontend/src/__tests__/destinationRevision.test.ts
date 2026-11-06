import { mightBeRevision } from '@/lib/destinationRevision';

describe('mightBeRevision (client pre-filter)', () => {
  it('never fires before destinations exist', () => {
    expect(mightBeRevision('actually Venice', [])).toBe(false);
  });
  it.each(['New York', '4 people', 'Boston', 'one way', 'June 10'])('plain answer skips the server: %s', (m) => {
    expect(mightBeRevision(m, ['Rome', 'Florence'])).toBe(false);
  });
  it.each(['actually Venice not Venezuela', 'drop Milan', 'add Nice', 'swap Rome for Naples', 'florence is too much'])(
    'checks with the server: %s',
    (m) => {
      expect(mightBeRevision(m, ['Rome', 'Florence', 'Milan'])).toBe(true);
    },
  );
});
