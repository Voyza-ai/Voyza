/**
 * "Where are you flying from?" answered with dates must not become the home
 * city. An audit (2026-11-18) typed "January 12 to 19, 2027" there and the
 * planner took it as the origin. guardHomeAnswers now refuses an origin that
 * is clearly not a place (dates, a bare number) and re-asks, keeping any
 * dates the model read from the same message.
 */
import { guardHomeAnswers } from '../services/homeAnswers';

const asked = [{ role: 'assistant' as const, content: 'Where are you flying from?' }];

describe('guardHomeAnswers', () => {
  it('dates typed as the home city: refused and re-asked; the dates the model read are kept', () => {
    const message = 'January 12 to 19, 2027';
    const out = guardHomeAnswers({
      message,
      history: asked,
      known: { destinations: ['Paris'] },
      result: {
        reply: 'Great, flying from January 12 to 19, 2027!',
        updates: { origin: 'January 12 to 19, 2027', dates: { start: '2027-01-12', end: '2027-01-19' } },
        action: 'ask',
      } as any,
    });
    expect(out.updates.origin).toBeUndefined();
    expect(out.updates.dates).toEqual({ start: '2027-01-12', end: '2027-01-19' });
    expect(out.reply).toBe("That looks like dates — I've noted them. Which city are you flying from?");
    expect(out.action).toBe('ask');
    expect((out as any).asking).toBe('origin');
  });

  it('without dates from the model it still re-asks, without claiming to have noted them', () => {
    const out = guardHomeAnswers({
      message: 'January 12 to 19, 2027',
      history: asked,
      known: {},
      result: { reply: 'ok', updates: { origin: 'January 12 to 19, 2027' }, action: 'ask' } as any,
    });
    expect(out.updates.origin).toBeUndefined();
    expect(out.reply).toBe('That looks like dates — which city are you flying from?');
  });

  it('a real city answered to the question is still taken (control)', () => {
    const out = guardHomeAnswers({
      message: 'New York',
      history: asked,
      known: {},
      result: { reply: 'Great!', updates: { origin: 'New York' }, action: 'ask' } as any,
    });
    expect(out.updates.origin).toBe('New York');
  });
});
