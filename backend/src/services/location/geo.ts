/**
 * Geometry for the two context signals. Nothing here knows about places.
 */

export type LatLon = { lat: number; lon: number };

const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in km. Same formula the rest of the backend uses. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Centroid of a set of points, averaged as unit vectors rather than as raw
 * degrees. The naive mean of longitudes puts the centroid of Tokyo and Los
 * Angeles in Kazakhstan; a trip that straddles the antimeridian is not exotic.
 *
 * Returns null for an empty set, and for the degenerate case where the points
 * cancel out (antipodal pair), where there is no meaningful centre to report.
 */
export function centroidOf(points: LatLon[]): LatLon | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const lat = toRad(p.lat);
    const lon = toRad(p.lon);
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
  }
  x /= points.length;
  y /= points.length;
  z /= points.length;
  if (Math.hypot(x, y, z) < 1e-9) return null;
  const lon = Math.atan2(y, x);
  const lat = Math.atan2(z, Math.hypot(x, y));
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}
