import './mocks';
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@/components/shared/NotificationBell', () => ({ __esModule: true, default: () => null }));

import CategoryPage from '@/app/trips/[category]/page';
import { fetchCategoryServer } from '@/lib/presetsServer';

/**
 * Audit E2: production has no /api/presets until promotion, so Express's
 * catch-all answers every category fetch with a 404. That must render the
 * "temporarily unavailable" state, not a hard 404 page — only the presets
 * API's own "Category not found" is a real not-found.
 */
const realFetch = global.fetch;
const respond = (status: number, body: unknown) => {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as any;
};
afterAll(() => {
  global.fetch = realFetch;
});

describe('fetchCategoryServer 404 mapping (E2)', () => {
  it('a backend WITHOUT the presets API (generic Express 404) is "unavailable", not not-found', async () => {
    // Verbatim body production returned on 2026-10-29.
    respond(404, { error: 'Not Found', path: '/api/presets/category/beach-escapes' });
    expect(await fetchCategoryServer('beach-escapes')).toBeNull();
  });

  it('a 404 whose body is not JSON is "unavailable" too', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    })) as any;
    expect(await fetchCategoryServer('beach-escapes')).toBeNull();
  });

  it("the presets API's own unknown-category answer is still a real not-found", async () => {
    respond(404, { error: 'Category not found' });
    expect(await fetchCategoryServer('nope')).toBe('not-found');
  });

  it('the category page renders the unavailable state for a generic 404, and only 404s a real unknown category', async () => {
    respond(404, { error: 'Not Found', path: '/api/presets/category/beach-escapes' });
    render(await CategoryPage({ params: { category: 'beach-escapes' } }));
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();

    respond(404, { error: 'Category not found' });
    await expect(CategoryPage({ params: { category: 'nope' } })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
