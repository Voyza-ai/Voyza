/** Geometry and a coarse spatial index. Build-time only. */

export type LatLon = { lat: number; lon: number };

/** IUGG mean Earth radius, km. */
const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in km. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * One-degree-cell grid. 4,008 airports x 171,590 cities is 688 million
 * haversines brute force; the grid turns each query into a handful of cells.
 */
export class Grid<T extends LatLon> {
  private cells = new Map<string, T[]>();

  constructor(items: Iterable<T>) {
    for (const item of items) {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
      const key = `${Math.floor(item.lat)}|${Math.floor(item.lon)}`;
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(item);
      else this.cells.set(key, [item]);
    }
  }

  /** Items within `radiusKm`, each with its distance. Unordered. */
  within(origin: LatLon, radiusKm: number): Array<{ item: T; km: number }> {
    const dLat = radiusKm / 111.32;
    const cosLat = Math.max(0.01, Math.cos((origin.lat * Math.PI) / 180));
    const dLon = radiusKm / (111.32 * cosLat);
    const out: Array<{ item: T; km: number }> = [];
    const latFrom = Math.floor(origin.lat - dLat);
    const latTo = Math.floor(origin.lat + dLat);
    const lonFrom = Math.floor(origin.lon - dLon);
    const lonTo = Math.floor(origin.lon + dLon);
    for (let la = latFrom; la <= latTo; la++) {
      for (let lo = lonFrom; lo <= lonTo; lo++) {
        const bucket = this.cells.get(`${la}|${lo}`);
        if (!bucket) continue;
        for (const item of bucket) {
          const km = haversineKm(origin, item);
          if (km <= radiusKm) out.push({ item, km });
        }
      }
    }
    return out;
  }
}

/** Distances are shown to travellers, so one decimal is the useful precision. */
export function roundKm(km: number): number {
  return Math.round(km * 10) / 10;
}

/**
 * Five decimals is about a metre. Computed centroids otherwise land in the
 * artifact as `24.35232526612121`, which is 20 bytes of noise per field and a
 * diff that churns on float rounding.
 */
export function roundCoord(degrees: number): number {
  return Math.round(degrees * 1e5) / 1e5;
}
