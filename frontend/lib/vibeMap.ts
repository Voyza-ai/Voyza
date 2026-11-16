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

/** Is this one word something the chip map knows ("food", "beachy")? */
export function isVibeSynonym(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(VIBE_SYNONYMS, word.trim().toLowerCase());
}

function chipsForText(text: string): Vibe[] {
  const out: Vibe[] = [];
  for (const w of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    for (const v of VIBE_SYNONYMS[w] ?? []) {
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

/**
 * Up to two Vibe chips for the planner's vibe answer; [] when nothing maps.
 *
 * Takes the answer as one string or as the picked list. Several picked vibes
 * ("Culture, Food", or ['Culture', 'Food']) take turns: each vibe's first
 * chip comes before any vibe's second, so Culture + Food shows history and
 * food rather than culture's two chips and nothing for food.
 */
export function vibesFromAnswer(answer?: string | string[] | null): Vibe[] {
  if (!answer) return [];
  const items = (Array.isArray(answer) ? answer : answer.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  const perItem = items.map(chipsForText);
  const out: Vibe[] = [];
  const longest = Math.max(0, ...perItem.map((c) => c.length));
  for (let i = 0; i < longest; i++) {
    for (const chips of perItem) {
      const v = chips[i];
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out.slice(0, 2);
}
