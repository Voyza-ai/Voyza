export const CITY_COLORS = [
  { bg: '#FDE8D8', text: '#7C3A1E', border: '#F5C4A0', name: 'Terracotta' },
  { bg: '#D6EAF8', text: '#1A4A6B', border: '#A8D0EF', name: 'Coastal Blue' },
  { bg: '#D5F0E4', text: '#1A5C3A', border: '#A0DFC0', name: 'Sage' },
  { bg: '#EDE0F5', text: '#4A2075', border: '#D4B8ED', name: 'Lavender' },
  { bg: '#FEF3C7', text: '#7C5A00', border: '#F5DFA0', name: 'Golden' },
  { bg: '#FCE4EC', text: '#7C1A3A', border: '#F0B8CC', name: 'Rose' },
  { bg: '#E0F0FF', text: '#1A3A5C', border: '#A8D4F5', name: 'Sky' },
];

// Returns the color object for a city based on its position
// Cycles through the 7 colors — city 8 gets color 1 again
export function getCityColor(index: number) {
  return CITY_COLORS[index % CITY_COLORS.length];
}
