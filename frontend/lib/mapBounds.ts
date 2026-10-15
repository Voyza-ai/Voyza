/**
 * Longitude helpers for framing a trip that may wrap the globe.
 *
 * Map bounds are built west-to-east through longitude 0, so a trip from
 * Philadelphia (-75) to Tokyo (+140) reads as 215° wide and gets framed across
 * the Atlantic with every Japanese city off-screen — when the trip really
 * spans 145° the other way, over the Pacific.
 */

/**
 * The western edge of the tightest span containing every longitude.
 *
 * Points sit on a circle, so the tightest span is everything except the widest
 * empty gap between neighbours. The edge just east of that gap is where the
 * span starts.
 *
 * Returns a longitude in the input's own range; callers add 360 to any point
 * that falls west of it to get a contiguous, increasing range (which is what
 * MapLibre wants for bounds crossing the antimeridian).
 */
export function shortSpanWest(lons: number[]): number {
  if (lons.length === 0) return 0;
  const sorted = [...lons].sort((a, b) => a - b);
  // The wrap-around gap: from the easternmost point back to the westernmost.
  let widest = sorted[0] + 360 - sorted[sorted.length - 1];
  let west = sorted[0];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1] - sorted[i];
    if (gap > widest) {
      widest = gap;
      west = sorted[i + 1];
    }
  }
  return west;
}

/**
 * Longitudes rewritten as a contiguous increasing range starting at the west
 * edge. Values may exceed 180 — that is intentional and correct for bounds
 * that cross the antimeridian.
 */
export function unwrapLons(lons: number[]): number[] {
  const west = shortSpanWest(lons);
  return lons.map((lon) => (lon < west ? lon + 360 : lon));
}

/** Width in degrees of the tightest span containing every longitude. */
export function spanDegrees(lons: number[]): number {
  if (lons.length === 0) return 0;
  const unwrapped = unwrapLons(lons);
  return Math.max(...unwrapped) - Math.min(...unwrapped);
}

/**
 * Mean position of a group of points, safe across the antimeridian.
 *
 * A plain average of longitudes puts the midpoint of Auckland (175) and Suva
 * (-178) at longitude -1.5 — off the coast of Africa, the exact opposite side
 * of the planet. Averaging the unwrapped values and folding the result back
 * into -180..180 keeps it in the Pacific where it belongs.
 */
export function centroid(points: { lat: number; lon: number }[]): { lat: number; lon: number } {
  if (points.length === 0) return { lat: 0, lon: 0 };
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lons = unwrapLons(points.map((p) => p.lon));
  let lon = lons.reduce((sum, l) => sum + l, 0) / lons.length;
  // Fold back into the normal range.
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  return { lat, lon };
}
