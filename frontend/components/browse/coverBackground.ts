import { coverThumbUrl, type PresetItinerary } from '@/data/presetItineraries';

/**
 * CSS backgrounds for a preset's cover photo on /browse.
 *
 * Cards draw the cover at its 960px rendition (coverThumbUrl): they are
 * ~366 CSS px wide, so 960 still oversamples at 2×, and the 1280px files
 * cost 3.3 MB for one page of cards (audit C6). The detail modal keeps the
 * 1280px file, layered OVER the 960px one the card already loaded, so the
 * modal shows a photo the instant it opens and sharpens when the larger
 * file lands — never the bare gradient.
 */
const SCRIM = 'linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.55) 100%)';

export const cardCoverBackground = (preset: PresetItinerary): string =>
  preset.coverImage
    ? `${SCRIM}, url(${coverThumbUrl(preset.coverImage)}) center/cover no-repeat, ${preset.coverGradient}`
    : preset.coverGradient;

export const modalCoverBackground = (preset: PresetItinerary): string => {
  if (!preset.coverImage) return preset.coverGradient;
  const thumb = coverThumbUrl(preset.coverImage);
  const underlay = thumb !== preset.coverImage ? `, url(${thumb}) center/cover no-repeat` : '';
  return `${SCRIM}, url(${preset.coverImage}) center/cover no-repeat${underlay}, ${preset.coverGradient}`;
};
