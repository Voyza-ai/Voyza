import './mocks';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import BrowsePage from '@/app/browse/page';
import { PRESET_ITINERARIES, coverThumbUrl } from '@/data/presetItineraries';
import { cardCoverBackground, modalCoverBackground } from '@/components/browse/coverBackground';

// The real builders, wrapped so the page's use of them can be asserted.
jest.mock('@/components/browse/coverBackground', () => {
  const actual = jest.requireActual('@/components/browse/coverBackground');
  return {
    cardCoverBackground: jest.fn(actual.cardCoverBackground),
    modalCoverBackground: jest.fn(actual.modalCoverBackground),
  };
});

/**
 * Audit C6: /browse downloaded 3.3 MB of 1280px covers to draw cards ~366
 * CSS px wide. Cards now take the 960px rendition (≥ 732 device px at 2×);
 * the detail modal keeps 1280px, over the card's 960px so it never flashes
 * the bare gradient while the larger file loads.
 */
const FUJI = PRESET_ITINERARIES.find((p) => p.slug === 'japan-golden-route')!;
const urlsIn = (css: string) => Array.from(css.matchAll(/url\(([^)]+)\)/g)).map((m) => m[1]);

describe('coverThumbUrl', () => {
  it('rewrites a 1280px Commons thumbnail to the 960px rendition of the same file', () => {
    expect(
      coverThumbUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/1280px-Colosseo_2020.jpg'),
    ).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/960px-Colosseo_2020.jpg');
  });

  it('leaves anything else alone', () => {
    for (const u of [
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Big_Ben.jpg', // an original, not a thumb
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/640px-X.jpg', // other width
      'https://example.com/photos/1280px-x.jpg', // not Commons
    ]) {
      expect(coverThumbUrl(u)).toBe(u);
    }
    expect(coverThumbUrl(undefined)).toBeUndefined();
  });

  it('every bundled cover has a 960px rendition', () => {
    for (const p of PRESET_ITINERARIES.filter((x) => x.coverImage)) {
      expect(coverThumbUrl(p.coverImage)).toMatch(/\/960px-[^/]+$/);
    }
  });
});

describe('cover backgrounds: 960px on cards, 1280px over it in the modal', () => {
  it('a card draws only the 960px file', () => {
    expect(urlsIn(cardCoverBackground(FUJI))).toEqual([coverThumbUrl(FUJI.coverImage)]);
  });

  it('the modal draws the 1280px file on top of the 960px one (no gradient flash on open)', () => {
    expect(urlsIn(modalCoverBackground(FUJI))).toEqual([FUJI.coverImage, coverThumbUrl(FUJI.coverImage)]);
  });

  it('a preset without a photo keeps its gradient in both places', () => {
    const plain = { ...FUJI, coverImage: undefined };
    expect(cardCoverBackground(plain)).toBe(FUJI.coverGradient);
    expect(modalCoverBackground(plain)).toBe(FUJI.coverGradient);
  });

  it('/browse uses the card builder for cards and the modal builder for the open trip', () => {
    // jsdom drops multi-layer `background` shorthands, so assert the wiring.
    const card = cardCoverBackground as jest.Mock;
    const modal = modalCoverBackground as jest.Mock;
    card.mockClear();
    modal.mockClear();
    render(<BrowsePage />);
    expect(card).toHaveBeenCalledWith(expect.objectContaining({ slug: FUJI.slug }));
    expect(modal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(FUJI.title));
    expect(modal).toHaveBeenCalledWith(expect.objectContaining({ slug: FUJI.slug }));
  });
});
