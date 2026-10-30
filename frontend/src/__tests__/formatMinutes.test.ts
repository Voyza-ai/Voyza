import { formatMinutes } from '@/lib/dateHelpers';

describe('formatMinutes', () => {
  it.each([
    [53, '53m'],
    [50, '50m'],
    [60, '1h'],
    [120, '2h'],
    [125, '2h 5m'],
    [645, '10h 45m'],
    [89.6, '1h 30m'],
    [0, '0m'],
  ])('%p minutes → %p', (mins, label) => {
    expect(formatMinutes(mins)).toBe(label);
  });

  it('never "0h …" and never a trailing space', () => {
    for (let m = 0; m < 1500; m += 7) {
      const s = formatMinutes(m);
      expect(s).not.toMatch(/^0h/);
      expect(s).toBe(s.trim());
    }
  });
});
