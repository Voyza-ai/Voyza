import { visitOrderLabel } from '@/lib/visitOrder';

describe('visitOrderLabel', () => {
  it('collapses consecutive stops into a range', () => {
    // Paris (1) and Lyon (2) are both in France.
    expect(visitOrderLabel([0, 1])).toBe('1–2');
  });

  it('shows a lone stop as a single number', () => {
    expect(visitOrderLabel([2])).toBe('3');
    expect(visitOrderLabel([3])).toBe('4');
  });

  it('keeps a returned-to country honest instead of faking one stretch', () => {
    // France → Netherlands → France. Claiming "1–3" would say the traveller
    // never left, which is exactly the thing being described as wrong.
    expect(visitOrderLabel([0, 2])).toBe('1, 3');
  });

  it('mixes ranges and singles', () => {
    expect(visitOrderLabel([0, 1, 3])).toBe('1–2, 4');
    expect(visitOrderLabel([0, 1, 3, 4])).toBe('1–2, 4–5');
  });

  it('is 1-based, never showing a zero', () => {
    expect(visitOrderLabel([0])).toBe('1');
    expect(visitOrderLabel([0, 1, 2, 3])).not.toContain('0');
  });

  it('does not care about input order', () => {
    expect(visitOrderLabel([3, 1, 2])).toBe('2–4');
  });

  it('ignores duplicates', () => {
    expect(visitOrderLabel([1, 1, 2])).toBe('2–3');
  });

  it('handles an empty group', () => {
    expect(visitOrderLabel([])).toBe('');
  });
});
