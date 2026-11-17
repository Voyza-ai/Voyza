/**
 * Mobile design tokens — taken from the product's own DNA, not invented:
 * the brand blue, the dark #0f0f1a AI surface, the pastel city palette
 * (lib/cityColors) and the dashed-route motif of the flowchart connectors.
 */
export const M = {
  blue: '#2563eb',
  blueDeep: '#1d4ed8',
  blueSoft: '#eef3fb',
  ink: '#0f172a',
  sub: '#64748b',
  line: '#e5e7eb',
  bg: '#f0f4f8',
  card: '#ffffff',
  ai: '#0f0f1a',
  train: '#22c088',
  flight: '#2e6bc4',
} as const;

/** The flowchart's dashed route, drawn vertically. */
export function dashedRoute(color: string, vertical = true): string {
  return vertical
    ? `repeating-linear-gradient(180deg, ${color} 0px, ${color} 6px, transparent 6px, transparent 11px)`
    : `repeating-linear-gradient(90deg, ${color} 0px, ${color} 6px, transparent 6px, transparent 11px)`;
}
