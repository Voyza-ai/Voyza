import type { Vibe } from './types';

/**
 * Maps the planner's free-text vibe answer ("culture", "somewhere relaxing
 * and beachy") onto the canonical Vibe chips the city cards render. Browse
 * presets carry hand-picked vibes; AI-planned trips only have whatever the
 * user typed, so this keeps their result cards from looking bare.
 */

const VIBE_SYNONYMS: Record<string, Vibe[]> = {
  history: ['history'],
  historic: ['history'],
  historical: ['history'],
  culture: ['history', 'art'],
  cultural: ['history', 'art'],
  museum: ['art', 'history'],
  museums: ['art', 'history'],
  art: ['art'],
  artsy: ['art'],
  food: ['food'],
  foodie: ['food'],
  culinary: ['food'],
  eating: ['food'],
  beach: ['beach'],
  beachy: ['beach'],
  coast: ['beach'],
  coastal: ['beach'],
  island: ['beach'],
  islands: ['beach'],
  relax: ['beach'],
  relaxing: ['beach'],
  chill: ['beach'],
  nightlife: ['nightlife'],
  party: ['nightlife'],
  partying: ['nightlife'],
  clubbing: ['nightlife'],
  nature: ['nature'],
  outdoors: ['nature'],
  outdoor: ['nature'],
  hiking: ['nature'],
  adventure: ['nature'],
  adventurous: ['nature'],
  mountains: ['nature'],
  scenic: ['nature'],
  city: ['city'],
  urban: ['city'],
  metropolitan: ['city'],
  shopping: ['city'],
  romance: ['romance'],
  romantic: ['romance'],
  honeymoon: ['romance'],
  couples: ['romance'],
};

/** Up to two Vibe chips for a free-text vibe answer; [] when nothing maps. */
export function vibesFromAnswer(answer?: string | null): Vibe[] {
  if (!answer) return [];
  const words = answer.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const out: Vibe[] = [];
  for (const w of words) {
    for (const v of VIBE_SYNONYMS[w] ?? []) {
      if (!out.includes(v)) out.push(v);
    }
  }
  return out.slice(0, 2);
}
