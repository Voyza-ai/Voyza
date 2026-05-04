export const CITY_COLORS = [
  // Coral — replaces the previous Terracotta (#FDE8D8 / #7C3A1E) because
  // its peachy bg visually collided with the new HOME_COLOR warm beige
  // below. Pushed to a more saturated pink-orange so destinations and the
  // origin/home slot stay clearly distinguishable on split-day cards.
  { bg: '#FFD9C9', text: '#8B2E1A', border: '#F5B098', name: 'Coral' },
  { bg: '#D6EAF8', text: '#1A4A6B', border: '#A8D0EF', name: 'Coastal Blue' },
  { bg: '#D5F0E4', text: '#1A5C3A', border: '#A0DFC0', name: 'Sage' },
  { bg: '#EDE0F5', text: '#4A2075', border: '#D4B8ED', name: 'Lavender' },
  { bg: '#FEF3C7', text: '#7C5A00', border: '#F5DFA0', name: 'Golden' },
  { bg: '#FCE4EC', text: '#7C1A3A', border: '#F0B8CC', name: 'Rose' },
  { bg: '#E0F0FF', text: '#1A3A5C', border: '#A8D4F5', name: 'Sky' },
];

/**
 * Reserved theme for the user's origin/home slot on split-day cards in
 * the schedule view. Deliberately *not* part of `CITY_COLORS` so a
 * destination cycling through the palette can never pick the same warm
 * beige and collide with the home zone.
 *
 * Header still labels the slot with the literal origin city name (e.g.
 * "New York City → Florence") — this color is just the zone's tint.
 */
export const HOME_COLOR = {
  bg: '#EDE3CC',
  text: '#5C4A2E',
  border: '#D4C5A0',
  name: 'Home',
};

// Returns the color object for a city based on its position
// Cycles through the 7 colors — city 8 gets color 1 again
export function getCityColor(index: number) {
  return CITY_COLORS[index % CITY_COLORS.length];
}
