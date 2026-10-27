/**
 * Place-aware key normalisation.
 *
 * The string work lives in `keys.ts`, which has no imports because it is
 * copied verbatim into the frontend — see the note at the top of that file.
 * This module adds the part that needs to know what a `Place` is, and
 * re-exports the rest so call sites have one place to import from.
 */

import type { KeyTier, Place } from './types';

export {
  normalizeKeys,
  keysForQuery,
  splitSegments,
  hasLatinForm,
} from './keys';

import { normalizeKeys } from './keys';

/** Every key a place is indexed under: its display name plus every alias. */
export function keysFor(place: Place): string[] {
  return tieredKeysFor(place).map((k) => k.key);
}

/** A key together with where it came from. */
export type TieredKey = { key: string; tier: KeyTier };

/**
 * Every key a place is indexed under, each carrying its provenance.
 *
 * Emitted best-tier-first and deduped on the key, so a string that is both a
 * curated alias and a dataset alternate name keeps the curated reading. That
 * ordering is the whole mechanism — see `KeyTier` for the Lomé/"rome" case it
 * exists to settle.
 *
 * Official codes are NOT here. They come from the typed `country` / `admin`
 * fields and are added by the index builder, which is the only place that
 * knows a code is a code rather than a two-letter name.
 */
export function tieredKeysFor(place: Place): TieredKey[] {
  const out: TieredKey[] = [];
  const seen = new Set<string>();

  const addAll = (texts: readonly string[], tier: KeyTier): void => {
    for (const text of texts) {
      for (const key of normalizeKeys(text)) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, tier });
      }
    }
  };

  addAll(place.curatedAliases ?? [], 'curated');
  addAll([place.name], 'canonical');
  addAll(place.aliases ?? [], 'alias');

  return out;
}

