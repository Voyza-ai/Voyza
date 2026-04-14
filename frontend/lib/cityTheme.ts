import { Vibe } from './types';

// Country base palette — each country gets a hue.
// Returns hex strings so they can be composed with rgba in styles.
const COUNTRY_HUES: Record<string, { base: string; soft: string; name: string }> = {
  Italy: { base: '#e0734a', soft: 'rgba(224,115,74,0.10)', name: 'terracotta' },
  Spain: { base: '#f59e0b', soft: 'rgba(245,158,11,0.10)', name: 'sunset' },
  Portugal: { base: '#14b8a6', soft: 'rgba(20,184,166,0.10)', name: 'azulejo' },
  France: { base: '#a78bfa', soft: 'rgba(167,139,250,0.10)', name: 'lavender' },
  Greece: { base: '#3b82f6', soft: 'rgba(59,130,246,0.10)', name: 'aegean' },
  Japan: { base: '#f472b6', soft: 'rgba(244,114,182,0.10)', name: 'sakura' },
  Germany: { base: '#94a3b8', soft: 'rgba(148,163,184,0.10)', name: 'slate' },
  Netherlands: { base: '#fb923c', soft: 'rgba(251,146,60,0.10)', name: 'orange' },
  default: { base: '#4f8ef7', soft: 'rgba(79,142,247,0.10)', name: 'voyza' },
};

// Vibe accent palette — used for the gradient overlay and ambient glow
const VIBE_HUES: Record<Vibe, string> = {
  history: '#d4a574', // weathered gold
  art: '#a78bfa', // violet
  food: '#f87171', // rose
  beach: '#22d3ee', // cyan
  nightlife: '#ec4899', // magenta
  nature: '#34d399', // emerald
  city: '#60a5fa', // sky
  romance: '#f9a8d4', // pink
};

export type CityTheme = {
  countryBase: string;
  countrySoft: string;
  countryName: string;
  vibeAccent: string; // primary vibe color
  gradient: string; // CSS gradient for the main card — light wash on white
  subGradient: string; // Slightly more muted version for the activities sub-card
  borderRest: string;
  borderActive: string;
  glow: string;
  numberColor: string;
};

export function getCityTheme(country: string, vibes?: Vibe[]): CityTheme {
  const c = COUNTRY_HUES[country] ?? COUNTRY_HUES.default;
  const primaryVibe = vibes?.[0];
  const vibeAccent = primaryVibe ? VIBE_HUES[primaryVibe] : c.base;

  return {
    countryBase: c.base,
    countrySoft: c.soft,
    countryName: c.name,
    vibeAccent,
    // Main card — vivid flat color fill. Strongly tinted.
    gradient: `${c.base}90`,
    // Sub-card — lighter but still clearly colored
    subGradient: `${c.base}50`,
    borderRest: `${c.base}aa`,
    borderActive: `${c.base}dd`,
    glow: 'none',
    numberColor: `${c.base}cc`,
  };
}

export const VIBE_LABEL: Record<Vibe, string> = {
  history: 'History',
  art: 'Art',
  food: 'Food',
  beach: 'Beach',
  nightlife: 'Nightlife',
  nature: 'Nature',
  city: 'City',
  romance: 'Romance',
};

export function getVibeColor(vibe: Vibe): string {
  return VIBE_HUES[vibe];
}
