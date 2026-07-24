'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Home, PanelLeftOpen, Plane, Maximize2, X, Layers, Check } from 'lucide-react';
import { Trip } from '@/lib/types';
import { geocodeCities, GeoPoint } from '@/lib/geocode';
import { getCityColor, HOME_COLOR } from '@/lib/cityColors';

/**
 * Map tab — the trip drawn on the Earth.
 *
 * Rendering: MapLibre GL over OpenFreeMap vector tiles (free, no API key).
 * Vector tiles are what make per-zoom detail control possible in later
 * passes — the previous raster basemap baked every road and label into the
 * image, so "country borders only when zoomed out" was impossible on it.
 *
 * Framing rule: the map fits the DESTINATIONS, not the home anchor. A New
 * York → Europe trip should open on Europe, where the itinerary actually is;
 * including home in the bounds squeezed five European cities into a ~50px
 * blob with an ocean either side. Home still gets a pin and its flight leg,
 * and "Show home" widens to include it on demand.
 *
 * Pins are the flowchart card colours (the pastel `bg`, with the matching
 * dark `text` for the number) so a city reads the same here as everywhere
 * else. Coordinates come from live geocoding (lib/geocode); cities the
 * geocoder can't resolve are reported rather than pinned somewhere wrong.
 *
 * Rendered client-side only (MapLibre needs `window`) — the results page
 * imports this with next/dynamic({ ssr: false }).
 */

// OpenFreeMap hosted vector style, then re-tuned for level-of-detail: the
// stock "bright" style draws the entire road network from zoom ~4 (world
// view), which buries a trip overview in orange lines. We push detail up the
// zoom ladder so the map reveals itself as you go in:
//   far out  → land, water, country borders + country names
//   country  → + state/region borders & labels, city dots
//   city     → + roads
//   in close → + buildings
const ROAD_MINZOOM = 11; // roads appear only once you're looking at a city
const BUILDING_MINZOOM = 14;
const STATE_LABEL_MINZOOM = 7;
// City labels ship from zoom ~3, so cities clutter the continental overview.
// Hold them until you're looking inside a country — the trip's own cities are
// marked by the numbered pins.
const CITY_LABEL_MINZOOM = 6;
// Rank-3+ countries (microstates like Monaco, Andorra, Vatican, San Marino,
// Luxembourg) also ship from ~zoom 2. The big countries (rank 1–2) stay for
// far-out context; the tiny ones only appear once you're in the region.
const MINOR_COUNTRY_MINZOOM = 5;

const POSITRON = 'https://tiles.openfreemap.org/styles/positron';

// Voyza blue palette — recolours the (greyscale) positron basemap to match
// the app's brand blue and the #f0f4f8 page wash, so the map reads as part of
// Voyza rather than a generic OSM tile set.
const BLUE = {
  land: '#eef3fb',
  water: '#bcd4f0',
  park: '#eef3fb', // same as land — parks/woods blend in, no patches on the map
  boundary: '#9fb8dc',
  road: '#cdd9ec',
  roadInner: '#ffffff',
  building: '#e4ebf6',
  buildingOutline: '#d3ddec',
  text: '#3b4a63',
  textStrong: '#26324b',
  halo: '#f4f7fc',
};

function applyVoyzaBlue(style: any) {
  // Assign each paint property only on layers of the matching type — a
  // source-layer like 'waterway' has BOTH a line and a symbol layer, and
  // setting line-color on the symbol one makes MapLibre reject the whole style.
  for (const layer of style.layers ?? []) {
    const id = String(layer.id || '');
    const sl = layer['source-layer'];
    const t = layer.type;
    const p = (layer.paint = layer.paint || {});
    if (t === 'background') {
      p['background-color'] = BLUE.land;
    } else if (t === 'fill') {
      if (sl === 'water') p['fill-color'] = BLUE.water;
      else if (id === 'park' || sl === 'park' || id === 'landcover_wood') p['fill-color'] = BLUE.park;
      else if (sl === 'landuse') p['fill-color'] = BLUE.land;
      else if (sl === 'landcover') p['fill-color'] = BLUE.land;
      else if (sl === 'building') {
        p['fill-color'] = BLUE.building;
        if ('fill-outline-color' in p) p['fill-outline-color'] = BLUE.buildingOutline;
      } else if (sl === 'transportation') p['fill-color'] = BLUE.land; // road areas/piers
    } else if (t === 'line') {
      if (sl === 'water' || sl === 'waterway') p['line-color'] = BLUE.water;
      else if (sl === 'boundary') p['line-color'] = BLUE.boundary;
      else if (sl === 'transportation') p['line-color'] = /inner/.test(id) ? BLUE.roadInner : BLUE.road;
    } else if (t === 'symbol') {
      if (sl === 'place') {
        p['text-color'] = /country|capital/.test(id) ? BLUE.textStrong : BLUE.text;
        p['text-halo-color'] = BLUE.halo;
      } else if (sl === 'transportation_name' || sl === 'aerodrome_label') {
        p['text-color'] = BLUE.text;
        p['text-halo-color'] = BLUE.halo;
      } else if (sl === 'water_name') {
        p['text-color'] = '#3f5c93';
      }
    }
  }
}

// Pickable basemap themes. `bluify` recolours the base to the Voyza palette;
// `swatch` is the little colour chip in the picker.
type StyleKey = 'voyza' | 'light';
const STYLES: Record<StyleKey, { label: string; url: string; swatch: string; bluify?: boolean }> = {
  voyza: { label: 'Voyza', url: POSITRON, swatch: '#bcd4f0', bluify: true },
  light: { label: 'Light', url: POSITRON, swatch: '#e7e7ea' },
};
const STYLE_STORAGE_KEY = 'voyza.mapStyle';

const readStoredStyle = (): StyleKey => {
  if (typeof window === 'undefined') return 'voyza';
  const s = window.localStorage.getItem(STYLE_STORAGE_KEY) as StyleKey | null;
  return s && s in STYLES ? s : 'voyza';
};

// Fetched + transformed once per theme, then shared across mounts/switches.
const stylePromises: Partial<Record<StyleKey, Promise<maplibregl.StyleSpecification | string>>> = {};

function loadMapStyle(key: StyleKey): Promise<maplibregl.StyleSpecification | string> {
  if (stylePromises[key]) return stylePromises[key]!;
  const cfg = STYLES[key];
  stylePromises[key] = fetch(cfg.url)
    .then((r) => r.json())
    .then((style: any) => {
      for (const layer of style.layers ?? []) {
        const sl = layer['source-layer'];
        const id = String(layer.id || '');
        const raise = (z: number) => {
          layer.minzoom = Math.max(layer.minzoom ?? 0, z);
        };
        if (sl === 'transportation' || sl === 'transportation_name') raise(ROAD_MINZOOM);
        else if (sl === 'building') raise(BUILDING_MINZOOM);
        // Place labels are named differently across styles — match by class.
        else if (sl === 'place' && /state|province|region/i.test(id)) raise(STATE_LABEL_MINZOOM);
        else if (sl === 'place' && /city|town/i.test(id)) raise(CITY_LABEL_MINZOOM);
        // Rank-3 country layer (label_country_3 / …_other) — the microstates.
        else if (sl === 'place' && /country.*(3|other|minor)/i.test(id)) raise(MINOR_COUNTRY_MINZOOM);
      }
      if (cfg.bluify) applyVoyzaBlue(style);
      return style as maplibregl.StyleSpecification;
    })
    // Any failure (offline, CORS) falls back to the stock URL so the map still
    // renders — just without the LOD tuning / recolour.
    .catch(() => cfg.url);
  return stylePromises[key]!;
}

type MapViewProps = {
  trip: Trip;
};

type PinPoint = {
  name: string;
  point: GeoPoint;
  kind: 'home' | 'city';
  cityIndex: number; // -1 for home
};

/**
 * Circular numbered marker in the flowchart card palette, with the city name
 * floating ABOVE the circle (not under it, where the pin covers it). The
 * wrapper stays 30×30 so the marker's `center` anchor keeps the circle on the
 * coordinate; the name is absolutely positioned outside that box.
 */
function makePinEl(label: string, bg: string, fg: string, name: string, onClick?: () => void): HTMLDivElement {
  const el = document.createElement('div');
  // NB: no `position` here — MapLibre's `.maplibregl-marker` class sets
  // position:absolute, and overriding it to relative drops the markers into
  // normal flow where they stack and drift off the route. The absolute label
  // below still anchors to this element (absolute elements are a positioning
  // context for their absolutely-positioned children).
  el.style.cssText = 'width:30px;height:30px;';

  if (name) {
    const lbl = document.createElement('div');
    lbl.textContent = name;
    lbl.style.cssText = `
      position:absolute;bottom:35px;left:50%;transform:translateX(-50%);
      white-space:nowrap;font:700 12px/1 system-ui,sans-serif;color:#26324b;
      text-shadow:0 0 3px #f4f7fc,0 1px 2px #f4f7fc,0 0 6px #f4f7fc,1px 0 3px #f4f7fc;
      pointer-events:none;
    `;
    el.appendChild(lbl);
  }

  const circle = document.createElement('div');
  circle.style.cssText = `
    width:30px;height:30px;border-radius:9999px;
    background:${bg};color:${fg};border:2px solid #fff;
    display:flex;align-items:center;justify-content:center;
    font:700 12px/1 system-ui,sans-serif;
    box-shadow:0 2px 8px rgba(0,0,0,0.22);
    cursor:${onClick ? 'pointer' : 'default'};
  `;
  circle.textContent = label;
  el.appendChild(circle);

  if (onClick) circle.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

/**
 * Great-circle-ish arc between two [lat, lon] points, so a long leg reads as
 * a flight path rather than a ruler line drawn through whatever it crosses.
 * Returns GeoJSON [lon, lat] positions ready for a LineString.
 */
function arc(a: [number, number], b: [number, number], segments = 48): [number, number][] {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const dist = Math.hypot(dLat, dLon);
  // A hint of curve, not a rainbow. Capped so an out-and-back pair (which bow
  // in opposite directions) doesn't turn a round trip into a big lens.
  const bow = Math.min(dist * 0.09, 4.5);
  const points: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mLat = lat1 + dLat * t;
    const mLon = lon1 + dLon * t;
    const lift = Math.sin(Math.PI * t) * bow;
    const nLat = dist === 0 ? 0 : -dLon / dist;
    const nLon = dist === 0 ? 0 : dLat / dist;
    points.push([mLon + nLon * lift, mLat + nLat * lift]); // [lon, lat]
  }
  return points;
}

const formatDate = (iso: string | undefined) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

const nightsBetween = (arrival?: string, departure?: string) => {
  if (!arrival || !departure) return 0;
  const [ay, am, ad] = arrival.split('-').map(Number);
  const [dy, dm, dd] = departure.split('-').map(Number);
  const a = new Date(ay, (am || 1) - 1, ad || 1);
  const d = new Date(dy, (dm || 1) - 1, dd || 1);
  return Math.max(0, Math.round((d.getTime() - a.getTime()) / 86_400_000));
};

const ROUTE_SOURCE = 'trip-route';
const ROUTE_LAYER = 'trip-route-line';

export default function MapView({ trip }: MapViewProps) {
  const [pins, setPins] = useState<PinPoint[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [includeHome, setIncludeHome] = useState(false);
  const [ready, setReady] = useState(false);
  const [styleKey, setStyleKey] = useState<StyleKey>(readStoredStyle);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  // Bumped after a theme swap so the route layer (wiped by setStyle) re-adds.
  const [styleEpoch, setStyleEpoch] = useState(0);

  const shellRef = useRef<HTMLDivElement | null>(null);
  // Keep the mount-time theme stable so the create effect never re-runs on switch.
  const initialStyleRef = useRef<StyleKey>(styleKey);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  const hasHome = !!trip.origin?.city;

  // Names in visit order; home first when the trip has an origin anchor.
  const names = useMemo(() => {
    const list: { name: string; kind: 'home' | 'city'; cityIndex: number }[] = [];
    if (trip.origin?.city) list.push({ name: trip.origin.city, kind: 'home', cityIndex: -1 });
    trip.cities.forEach((c, i) => list.push({ name: c.name, kind: 'city', cityIndex: i }));
    return list;
  }, [trip.origin?.city, trip.cities]);

  // ─── Create the map once (style is fetched + LOD-tuned first) ───
  useEffect(() => {
    let map: maplibregl.Map | null = null;
    let cancelled = false;
    loadMapStyle(initialStyleRef.current).then((style) => {
      if (cancelled || !containerRef.current) return;
      map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: [10, 30],
        zoom: 2,
        minZoom: 2,
        attributionControl: { compact: true },
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      map.on('load', () => setReady(true));
      mapRef.current = map;
    });
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // ─── Geocode the cities ───
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    geocodeCities(names.map((n) => n.name)).then((points) => {
      if (cancelled) return;
      const resolved: PinPoint[] = [];
      const failed: string[] = [];
      points.forEach((p, i) => {
        if (p) resolved.push({ ...names[i], point: p });
        else failed.push(names[i].name);
      });
      setPins(resolved);
      setMissing(failed);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [names]);

  const cityPins = useMemo(
    () => pins.filter((p) => p.kind === 'city').sort((a, b) => a.cityIndex - b.cityIndex),
    [pins],
  );

  // Route legs in visit order; close the loop home on round-trips.
  const legs = useMemo(() => {
    const ordered = [...pins].sort((a, b) => a.cityIndex - b.cityIndex);
    const path = ordered.map((p) => [p.point.lat, p.point.lon] as [number, number]);
    const home = pins.find((p) => p.kind === 'home');
    if (home && trip.returnToHome !== false && path.length > 1) {
      path.push([home.point.lat, home.point.lon]);
    }
    const out: { coords: [number, number][]; home: boolean }[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const isHomeLeg =
        !!home &&
        ((path[i][0] === home.point.lat && path[i][1] === home.point.lon) ||
          (path[i + 1][0] === home.point.lat && path[i + 1][1] === home.point.lon));
      out.push({ coords: arc(path[i], path[i + 1]), home: isHomeLeg });
    }
    return out;
  }, [pins, trip.returnToHome]);

  // ─── Draw the route line ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: legs
        .filter((leg) => includeHome || !leg.home)
        .map((leg) => ({
          type: 'Feature',
          properties: { home: leg.home },
          geometry: { type: 'LineString', coordinates: leg.coords },
        })),
    };

    const existing = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (existing) {
      existing.setData(data);
      return;
    }
    map.addSource(ROUTE_SOURCE, { type: 'geojson', data });
    map.addLayer({
      id: ROUTE_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['get', 'home'], '#94a3b8', '#2e6bc4'],
        'line-opacity': ['case', ['get', 'home'], 0.65, 0.85],
        'line-width': ['case', ['get', 'home'], 2, 2.6],
        'line-dasharray': [2, 2.2],
      },
    });
    // styleEpoch: a theme swap wipes custom sources/layers, so re-add on bump.
  }, [legs, includeHome, ready, styleEpoch]);

  // ─── Rebuild the pin markers ───
  // Clicking a city frames the whole region around it (roughly a state/metro
  // area), so you can see the nearby cities — and, once Phase 3 lands, the
  // itinerary's own spot pins within the city.
  const focusCity = useCallback((index: number) => {
    const map = mapRef.current;
    const target = pins.find((p) => p.cityIndex === index && p.kind === 'city');
    if (!map || !target) return;
    map.easeTo({
      center: [target.point.lon, target.point.lat],
      zoom: 9.3,
      duration: 650,
    });
  }, [pins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = pins.map((pin) => {
      const isHome = pin.kind === 'home';
      const palette = isHome ? HOME_COLOR : getCityColor(pin.cityIndex);
      const label = isHome ? '⌂' : String(pin.cityIndex + 1);
      const el = makePinEl(
        label,
        palette.bg,
        palette.text,
        pin.name,
        isHome ? undefined : () => focusCity(pin.cityIndex),
      );
      return new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([pin.point.lon, pin.point.lat])
        .addTo(map);
    });
    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
    };
  }, [pins, ready, focusCity]);

  // ─── Hide the basemap's own labels for the trip's cities ───
  // Each trip city is already labelled by its numbered pin; without this the
  // basemap draws a second label for the same place once city labels turn on
  // (~zoom 6), so you'd see e.g. "Prague" twice. Nearby non-trip cities keep
  // their labels. Applied at runtime (not baked into the shared style) and
  // re-applied after a theme switch, which resets the layers' filters.
  const excludeNames = useMemo(() => {
    const list = trip.cities.map((c) => c.name);
    if (trip.origin?.city) list.push(trip.origin.city);
    return Array.from(new Set(list.filter(Boolean)));
  }, [trip.cities, trip.origin?.city]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || excludeNames.length === 0) return;
    const sig = JSON.stringify(excludeNames);
    // Match whatever the label actually displays: name_en/name (Latin places)
    // or name:latin (romanised form of non-Latin places like Tokyo/Kyoto).
    const exclude = [
      '!',
      [
        'any',
        ['in', ['coalesce', ['get', 'name_en'], ['get', 'name'], ''], ['literal', excludeNames]],
        ['in', ['coalesce', ['get', 'name:latin'], ''], ['literal', excludeNames]],
      ],
    ];
    for (const layer of map.getStyle().layers ?? []) {
      if ((layer as any)['source-layer'] !== 'place') continue;
      if (!/city|town|capital/i.test(layer.id)) continue;
      const cur = (layer as any).filter;
      // Skip if we've already combined this layer (guards against re-nesting).
      if (cur && JSON.stringify(cur).includes(sig)) continue;
      const combined = cur ? ['all', cur, exclude] : exclude;
      try {
        map.setFilter(layer.id, combined as any);
      } catch {
        /* layer/schema differs in this theme — leave it as-is */
      }
    }
  }, [ready, styleEpoch, excludeNames]);

  // ─── Frame the map to the trip ───
  const fitToTrip = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.resize(); // pane size can be stale after a tab switch / sidebar dock

    const framed = includeHome ? pins : pins.filter((p) => p.kind === 'city');
    const usable = framed.length > 0 ? framed : pins;
    if (usable.length === 0) return;

    if (usable.length === 1) {
      map.jumpTo({ center: [usable[0].point.lon, usable[0].point.lat], zoom: 7 });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    usable.forEach((p) => bounds.extend([p.point.lon, p.point.lat]));
    map.fitBounds(bounds, { padding: 40, maxZoom: 9, animate: false });
  }, [pins, includeHome]);

  // Re-frame when the pin set or the home toggle changes.
  useEffect(() => {
    if (!ready || pins.length === 0) return;
    fitToTrip();
    // A second pass after the container has certainly settled (first mount can
    // measure a frame early).
    const t = setTimeout(fitToTrip, 200);
    return () => clearTimeout(t);
  }, [ready, pins, includeHome, fitToTrip]);

  // The pane's box changes for reasons React never re-renders us for — the
  // chat sidebar docking at a breakpoint, the window resizing. MapLibre caches
  // its size, so watch the element and resize + re-frame on any change.
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let first = true;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitToTrip());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fitToTrip]);

  const togglePanel = useCallback(() => {
    setPanelOpen((v) => !v);
    setTimeout(() => fitToTrip(), 240);
  }, [fitToTrip]);

  // Swap the basemap theme. HTML markers survive setStyle (they're DOM, not
  // part of the style); the route source/layer do NOT, so bump styleEpoch once
  // the new style has settled to re-add them.
  const switchStyle = useCallback((key: StyleKey) => {
    setStyleKey(key);
    setStyleMenuOpen(false);
    try {
      window.localStorage.setItem(STYLE_STORAGE_KEY, key);
    } catch {
      /* private mode — the choice just won't persist */
    }
    const map = mapRef.current;
    if (!map) return;
    loadMapStyle(key).then((style) => {
      if (mapRef.current !== map) return;
      map.setStyle(style);
      map.once('idle', () => setStyleEpoch((e) => e + 1));
    });
  }, []);

  return (
    <div ref={shellRef} className="relative h-full min-h-0">
      {/* ─── Itinerary panel — floats OVER the map, closes with the ✕ ─── */}
      <aside
        className={`absolute top-3 left-3 z-[600] w-[236px] max-h-[calc(100%-1.5rem)] hidden md:flex flex-col transition-all duration-200 ease-out ${
          panelOpen
            ? 'opacity-100 translate-x-0 pointer-events-auto'
            : 'opacity-0 -translate-x-2 pointer-events-none'
        }`}
        aria-hidden={!panelOpen}
      >
        <div className="min-h-0 flex flex-col bg-white/97 backdrop-blur-sm rounded-xl border border-black/10 shadow-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-gray-800">Itinerary</span>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-gray-400">
                {trip.cities.length} {trip.cities.length === 1 ? 'stop' : 'stops'}
              </span>
              <button
                onClick={togglePanel}
                title="Close itinerary"
                className="w-5 h-5 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-800 hover:bg-gray-100 transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1.5">
            {hasHome && (
              <button
                onClick={() => setIncludeHome(true)}
                className="w-full text-left flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-gray-50 transition-colors"
              >
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: HOME_COLOR.bg, border: `1px solid ${HOME_COLOR.border}` }}
                >
                  <Home size={12} style={{ color: HOME_COLOR.text }} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-gray-800 truncate">
                    {trip.origin?.city}
                  </span>
                  <span className="block text-[10px] text-gray-400">Home</span>
                </span>
              </button>
            )}

            {trip.cities.map((city, i) => {
              const c = getCityColor(i);
              const nights = nightsBetween(city.dates?.arrival, city.dates?.departure);
              const located = cityPins.some((p) => p.cityIndex === i);
              return (
                <button
                  key={`${city.name}-${i}`}
                  onClick={() => focusCity(i)}
                  disabled={!located}
                  title={located ? `Show ${city.name} on the map` : `Couldn't locate ${city.name}`}
                  className={`w-full text-left flex items-start gap-2.5 px-2 py-2 rounded-xl transition-colors ${
                    located ? 'hover:bg-gray-50' : 'opacity-45 cursor-default'
                  }`}
                >
                  <span
                    className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold"
                    style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}` }}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-gray-800 truncate">
                      {city.name}
                    </span>
                    <span className="block text-[10px] text-gray-400 truncate">
                      {formatDate(city.dates?.arrival)}
                      {nights > 0 && (
                        <>
                          {' · '}
                          {nights}
                          {nights === 1 ? ' night' : ' nights'}
                        </>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {missing.length > 0 && (
            <div className="px-3.5 py-2 border-t border-gray-100 text-[10px] text-gray-400">
              Couldn&apos;t locate: {missing.join(', ')}
            </div>
          )}
        </div>
      </aside>

      {/* ─── Map — full width; the itinerary floats on top of it ─── */}
      <div className="relative h-full w-full rounded-2xl overflow-hidden border border-black/10">
        <div ref={containerRef} className="h-full w-full" />

        {/* Re-opens the itinerary; hidden while the panel is up. */}
        {!panelOpen && (
          <button
            onClick={togglePanel}
            title="Show itinerary"
            className="absolute top-3 left-3 z-[600] h-8 px-2.5 rounded-lg bg-white/95 border border-black/10 shadow-sm flex items-center gap-1.5 text-[11px] font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            <PanelLeftOpen size={14} />
            Itinerary
          </button>
        )}

        {/* Framing controls. "Show home" only matters when there's a home
            anchor sitting outside the destination cluster. */}
        <div className="absolute top-3 right-3 z-[500] flex items-center gap-1.5">
          {hasHome && (
            <button
              onClick={() => setIncludeHome((v) => !v)}
              title={includeHome ? 'Frame just the destinations' : 'Zoom out to include your home city'}
              className={`h-8 px-2.5 rounded-lg border shadow-sm text-[11px] font-medium flex items-center gap-1.5 transition-colors ${
                includeHome
                  ? 'bg-[#2e6bc4] text-white border-[#2e6bc4]'
                  : 'bg-white/95 text-gray-600 border-black/10 hover:text-gray-900'
              }`}
            >
              <Plane size={12} />
              Show home
            </button>
          )}
          <button
            onClick={fitToTrip}
            title="Re-fit the map to your trip"
            className="w-8 h-8 rounded-lg bg-white/95 border border-black/10 shadow-sm flex items-center justify-center text-gray-600 hover:text-gray-900 transition-colors"
          >
            <Maximize2 size={14} />
          </button>

          {/* Theme picker */}
          <div className="relative">
            <button
              onClick={() => setStyleMenuOpen((v) => !v)}
              title="Map style"
              className={`w-8 h-8 rounded-lg border shadow-sm flex items-center justify-center transition-colors ${
                styleMenuOpen
                  ? 'bg-[#2e6bc4] text-white border-[#2e6bc4]'
                  : 'bg-white/95 text-gray-600 border-black/10 hover:text-gray-900'
              }`}
            >
              <Layers size={14} />
            </button>
            {styleMenuOpen && (
              <>
                {/* click-away catcher */}
                <div className="fixed inset-0 z-[590]" onClick={() => setStyleMenuOpen(false)} />
                <div className="absolute top-9 right-0 z-[600] w-36 bg-white rounded-xl border border-black/10 shadow-lg p-1">
                  {(Object.keys(STYLES) as StyleKey[]).map((key) => {
                    const s = STYLES[key];
                    const active = key === styleKey;
                    return (
                      <button
                        key={key}
                        onClick={() => switchStyle(key)}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] transition-colors ${
                          active ? 'bg-gray-100 font-medium text-gray-900' : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <span
                          className="w-4 h-4 rounded-md border border-black/10 flex-shrink-0"
                          style={{ background: s.swatch }}
                        />
                        <span className="flex-1 text-left">{s.label}</span>
                        {active && <Check size={13} className="text-[#2e6bc4]" />}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        {loading && (
          <div className="absolute bottom-3 left-3 z-[500] px-3 py-1.5 rounded-full text-[12px] bg-white/95 border border-black/10 shadow-sm text-gray-600">
            Locating your cities…
          </div>
        )}
      </div>
    </div>
  );
}
