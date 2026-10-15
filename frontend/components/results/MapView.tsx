'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  Home,
  PanelLeftOpen,
  Plane,
  Maximize2,
  X,
  Layers,
  Check,
  ChevronLeft,
} from 'lucide-react';
import { Trip } from '@/lib/types';
import { geocodeCities, GeoPoint } from '@/lib/geocode';
import { unwrapLons, centroid } from '@/lib/mapBounds';
import { visitOrderLabel } from '@/lib/visitOrder';
import { getCityColor, HOME_COLOR } from '@/lib/cityColors';
import {
  buildCitySpots,
  buildRecommendedSpots,
  geocodeSpots,
  distanceKm,
  CITY_FRAME_KM,
  type Spot,
  type SpotKind,
  type Suggestion,
} from '@/lib/citySpots';
import { searchActivities, searchRestaurants } from '@/lib/api';

/**
 * Map tab — the trip drawn on the Earth.
 *
 * Rendering: MapLibre GL over OpenFreeMap vector tiles (free, no API key).
 * Vector tiles are what make per-zoom detail control possible in later
 * passes — the previous raster basemap baked every road and label into the
 * image, so "country borders only when zoomed out" was impossible on it.
 *
 * Reads the same trip object as the flowchart, so canvas / BlueMurr-AI edits
 * re-render pins and route automatically.
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
/**
 * Roads come in one class at a time, not all at once.
 *
 * Lifting the whole `transportation` group to a single zoom meant the entire
 * network — every residential street and cycle path — switched on together the
 * moment you crossed it, which is what made a city view look like a spider's
 * web. Tiering it means a city first shows its shape (arteries and water), and
 * only reveals side streets when you're close enough for them to mean anything.
 */
const ROAD_TIERS: Array<[RegExp, number]> = [
  [/motorway/, 11],
  [/major/, 12],
  [/minor/, 14.5], // residential + service: the dense web
  [/path/, 16], // footpaths and cycleways
  [/railway_(transit|service)/, 16],
  [/railway/, 13],
  [/pier|area/, 15],
];
const ROAD_DEFAULT_MINZOOM = 13;

/**
 * Basemap text we don't want on a travel map. Road shields ("S100") never help
 * plan a trip; street and canal names are only useful once you're right down at
 * street level, and at city zoom they bury our own pins.
 */
const HIDDEN_LABEL = /shield/;
const STREET_LABEL_MINZOOM = 15;

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

// BlueMurr blue palette — recolours the (greyscale) positron basemap to match
// the app's brand blue and the #f0f4f8 page wash, so the map reads as part of
// BlueMurr rather than a generic OSM tile set.
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

function applyBlueMurrBlue(style: any) {
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

// Pickable basemap themes. `bluify` recolours the base to the BlueMurr palette;
// `swatch` is the little colour chip in the picker. The `voyza` key itself is a
// lowercase internal — it's the persisted localStorage value, and renaming it
// would silently reset every user's saved theme choice.
type StyleKey = 'voyza' | 'light';
const STYLES: Record<StyleKey, { label: string; url: string; swatch: string; bluify?: boolean }> = {
  voyza: { label: 'BlueMurr', url: POSITRON, swatch: '#bcd4f0', bluify: true },
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
        if (sl === 'transportation') {
          const tier = ROAD_TIERS.find(([re]) => re.test(id));
          raise(tier ? tier[1] : ROAD_DEFAULT_MINZOOM);
        } else if (sl === 'transportation_name') {
          // Shields off entirely; street names only at street level.
          raise(HIDDEN_LABEL.test(id) ? 24 : STREET_LABEL_MINZOOM);
        } else if (sl === 'waterway' || sl === 'water_name') {
          // "Herengracht", "Keizersgracht"… big italic canal names everywhere.
          if (layer.type === 'symbol') raise(STREET_LABEL_MINZOOM);
        } else if (sl === 'building') raise(BUILDING_MINZOOM);
        // Place labels are named differently across styles — match by class.
        else if (sl === 'place' && /state|province|region/i.test(id)) raise(STATE_LABEL_MINZOOM);
        else if (sl === 'place' && /city|town/i.test(id)) raise(CITY_LABEL_MINZOOM);
        // Rank-3 country layer (label_country_3 / …_other) — the microstates.
        else if (sl === 'place' && /country.*(3|other|minor)/i.test(id)) raise(MINOR_COUNTRY_MINZOOM);
      }
      if (cfg.bluify) applyBlueMurrBlue(style);
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
 * Spot pins — the places INSIDE a city. Deliberately a different visual class
 * from the big numbered city pins: smaller, white-filled, with a coloured ring
 * and a glyph, so "stops on the trip" and "places within a stop" never read as
 * the same thing. One colour + icon per kind.
 */
/**
 * Zoom thresholds for the itinerary level of detail.
 *
 * A city's spots belong to city scale, so the zoom decides when they appear —
 * scrolling into Tokyo shows them the same as clicking its pin does. Clicking
 * stays as a shortcut that flies you there; it is no longer the only way in.
 *
 * The two values differ on purpose. One shared threshold makes the view flap
 * between overview and city on the tiniest scroll while the camera sits on the
 * boundary, so entering needs a closer zoom than leaving: the band between
 * them holds whatever is already on screen.
 *
 * ENTER 10 is roughly "one metro area fills the map"; EXIT 9 is roughly
 * "a region". The old single threshold of 8 was region-and-a-half scale, which
 * is why a city's spots stayed drawn over two full zoom-out steps.
 */
const CITY_ENTER_ZOOM = 10;
const CITY_EXIT_ZOOM = 9;

/**
 * Below this, individual cities collapse into one pin per country — the top
 * rung of the ladder: countries → cities → the places inside a city.
 *
 * It earns its keep on trips that are actually spread out. A Philadelphia →
 * Japan trip with "Show home" on frames near zoom 1, where four Japanese city
 * dots overlap into an unreadable smudge; "Japan · 4 stops" says the same
 * thing legibly. A trip that fits in one region never frames this far out and
 * simply never sees this tier.
 */
const COUNTRY_ZOOM = 5;

/**
 * Padding for a framing move, clamped to the size of the map.
 *
 * The itinerary panel floats over the left edge, so framing has to reserve its
 * width or pins land underneath it. But a fixed 272px reservation is most of a
 * narrow pane, and what's left can be too small to fit the trip at all: a
 * Paris → Singapore → Stockholm trip spans 101° of longitude, which in ~110
 * usable pixels needs a zoom below 0. `fitBounds` clamps at the floor and
 * silently drops a city off the edge — Singapore simply wasn't on the map.
 *
 * So padding is a share of the viewport, never a fixed cost. On a roomy map it
 * is the panel's real width; on a cramped one it shrinks and the trip still
 * fits, which matters more than keeping a pin clear of an overlay.
 */
/** The itinerary panel's rendered width. */
const PANEL_W = 236;
/**
 * Padding positions a marker's ANCHOR, but a marker is drawn around it — a
 * country pill is ~90px wide and centred, so a point sitting exactly on the
 * padding line still has half its pill over the panel.
 */
const MARKER_ALLOWANCE = 70;
/**
 * Below this map width the panel cannot be afforded: reserving its width plus
 * marker clearance would take more than half the map, leaving too little to
 * frame the trip in. The panel closes itself instead — see `panelFits`.
 */
const MIN_MAP_W_FOR_PANEL = (PANEL_W + MARKER_ALLOWANCE) * 2;

/** Whether a map this wide can show the panel without starving the framing. */
const panelFits = (mapWidth: number) => mapWidth >= MIN_MAP_W_FOR_PANEL;

function framePadding(
  map: maplibregl.Map,
  panelOpen: boolean,
  base = { top: 56, bottom: 56, side: 56, panel: PANEL_W },
) {
  const el = map.getContainer();
  const w = el.clientWidth || 1;
  const h = el.clientHeight || 1;
  const side = Math.min(base.side, Math.round(w * 0.08));
  const left = panelOpen
    ? Math.min(base.panel + MARKER_ALLOWANCE, Math.round(w * 0.5))
    : side;
  return {
    top: Math.min(base.top, Math.round(h * 0.1)),
    bottom: Math.min(base.bottom, Math.round(h * 0.1)),
    right: side,
    left: Math.max(left, side),
  };
}

/**
 * Cache key for a city's resolved spots. Identity, not position — the trip can
 * be reordered or have a city inserted while the map is open, and everything
 * downstream (which places belong here) follows the city, not its slot.
 */
const cityCacheKey = (city?: { name: string; country: string }) =>
  city ? `${city.name}|${city.country}` : '';

/**
 * Bounds that take the SHORT way round the globe.
 *
 * Extending a LngLatBounds point by point always spans west-to-east through
 * longitude 0, so a Philadelphia (-75) → Tokyo (+140) trip is treated as 215°
 * wide and framed across the Atlantic, with every Japanese city off-screen.
 * The trip actually spans 145° the other way, over the Pacific.
 *
 * The longitude maths lives in lib/mapBounds so it can be unit-tested.
 */
function shortestBounds(points: GeoPoint[]): maplibregl.LngLatBounds {
  const bounds = new maplibregl.LngLatBounds();
  if (points.length === 0) return bounds;
  const lons = unwrapLons(points.map((p) => p.lon));
  points.forEach((p, i) => bounds.extend([lons[i], p.lat]));
  return bounds;
}

const SPOT_STYLE: Record<SpotKind, { color: string; label: string; paths: string[] }> = {
  airport: {
    color: '#475569',
    label: 'Airport',
    paths: [
      'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z',
    ],
  },
  hotel: {
    color: '#7c3aed',
    label: 'Hotel',
    paths: ['M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8', 'M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4', 'M12 4v6', 'M2 18h20'],
  },
  restaurant: {
    color: '#e11d48',
    label: 'Food',
    paths: ['M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2', 'M7 2v20', 'M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7'],
  },
  sightseeing: {
    color: '#d97706',
    label: 'Sights',
    paths: ['M3 22h18', 'M6 18v-7', 'M10 18v-7', 'M14 18v-7', 'M18 18v-7', 'M12 2 2 9h20Z'],
  },
  activity: {
    color: '#0d9488',
    label: 'Activities',
    paths: [
      'M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z',
      'M13 5v14',
    ],
  },
};

const spotSvg = (kind: SpotKind, size = 13) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${SPOT_STYLE[kind].color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${SPOT_STYLE[kind]
    .paths.map((d) => `<path d="${d}"/>`)
    .join('')}</svg>`;

/** Width a spot's name is allowed before it gets an ellipsis. */
const SPOT_LABEL_MAX = 130;

/**
 * A spot marker: 24px white disc with a coloured ring and glyph, and its name
 * on a small plate above it.
 *
 * The name is always visible — a pin you have to hover to identify doesn't
 * help you plan. Long names ("Holiday Inn Express Amsterdam - North Riverside
 * by IHG") are clipped so one hotel can't span the city; hovering lifts the
 * pin above its neighbours and shows the name in full.
 */
/**
 * A country standing in for the cities inside it. Deliberately a pill rather
 * than a dot: at this zoom a dot says nothing, while "Japan · 4 stops" tells
 * you what the trip covers before you've zoomed into anything.
 */
function makeCountryEl(
  country: string,
  position: string,
  stopsLabel: string,
  stops: number,
): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'cursor:pointer;';
  el.title = `${country} — ${stops === 1 ? 'stop' : 'stops'} ${stopsLabel}. Click to zoom in.`;

  const pill = document.createElement('div');
  // No transform here. MapLibre's `anchor: 'center'` already centres the marker
  // element on its coordinate; a second translate(-50%,-50%) shifted every pill
  // up and left by half its own width, parking "Netherlands" over the UK.
  pill.style.cssText = `
    display:flex;align-items:center;gap:6px;white-space:nowrap;
    background:#fff;border:1.5px solid ${BLUE.boundary};border-radius:9999px;
    padding:4px 10px;box-shadow:0 2px 8px rgba(23,43,77,0.16);
    font:600 12px/1 system-ui,sans-serif;color:${BLUE.textStrong};
  `;

  const name = document.createElement('span');
  name.textContent = country;
  pill.appendChild(name);

  // The trip's visit order, matching the numbers on the city pins one zoom
  // level in. A stop count here would collide with that numbering: two
  // one-stop countries would both read "1".
  const badge = document.createElement('span');
  badge.textContent = position;
  badge.style.cssText = `
    display:inline-flex;align-items:center;justify-content:center;
    min-width:17px;height:17px;padding:0 5px;border-radius:9999px;
    background:${BLUE.water};color:${BLUE.textStrong};
    font:700 10.5px/1 system-ui,sans-serif;
  `;
  pill.appendChild(badge);
  el.appendChild(pill);

  el.addEventListener('mouseenter', () => {
    pill.style.borderColor = BLUE.textStrong;
    el.style.zIndex = '20';
  });
  el.addEventListener('mouseleave', () => {
    pill.style.borderColor = BLUE.boundary;
    el.style.zIndex = '';
  });
  return el;
}

function makeSpotEl(spot: Spot): HTMLDivElement {
  const style = SPOT_STYLE[spot.kind];
  const el = document.createElement('div');
  // No `position` — MapLibre's own class supplies absolute (see makePinEl).
  el.style.cssText = 'width:24px;height:24px;';
  el.title = spot.detail ? `${spot.name} — ${spot.detail}` : spot.name;

  const label = document.createElement('div');
  label.textContent = spot.name;
  label.style.cssText = `
    position:absolute;bottom:28px;left:50%;transform:translateX(-50%);
    max-width:${SPOT_LABEL_MAX}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    font:600 10.5px/1.3 system-ui,sans-serif;color:#26324b;
    background:rgba(255,255,255,0.94);border:1px solid rgba(0,0,0,0.07);
    border-radius:5px;padding:1.5px 5px;box-shadow:0 1px 3px rgba(0,0,0,0.11);
    transition:max-width .12s ease;pointer-events:none;
  `;
  el.appendChild(label);

  const disc = document.createElement('div');
  // A suggestion is drawn hollow and dashed, in the same colour as the kind it
  // belongs to. Same family, clearly not part of the plan — the map must never
  // let "where you're going" and "where you could go" read alike.
  disc.style.cssText = `
    width:24px;height:24px;border-radius:9999px;
    background:${spot.recommended ? 'rgba(255,255,255,0.82)' : '#fff'};
    border:2px ${spot.recommended ? 'dashed' : 'solid'} ${style.color};
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 1px 5px rgba(0,0,0,${spot.recommended ? 0.12 : 0.2});cursor:default;
    ${spot.recommended ? 'opacity:0.9;' : ''}
  `;
  disc.innerHTML = spotSvg(spot.kind);
  el.appendChild(disc);

  if (spot.recommended) {
    // Small star so the distinction survives at a glance, and in greyscale.
    const star = document.createElement('div');
    star.textContent = '★';
    star.style.cssText = `
      position:absolute;top:-5px;right:-5px;font-size:11px;line-height:1;
      color:${style.color};text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 2px #fff;
      pointer-events:none;
    `;
    el.appendChild(star);
    label.style.borderStyle = 'dashed';
    label.style.color = '#5a6b8a';
  }

  // Hover reveals the full name and lifts it clear of any neighbour it
  // happens to be sitting behind.
  el.addEventListener('mouseenter', () => {
    label.style.maxWidth = '280px';
    label.style.background = '#ffffff';
    el.style.zIndex = '20';
  });
  el.addEventListener('mouseleave', () => {
    label.style.maxWidth = `${SPOT_LABEL_MAX}px`;
    label.style.background = 'rgba(255,255,255,0.94)';
    el.style.zIndex = '';
  });
  return el;
}

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
const SCRIM_LAYER = 'voyza-scrim';

/**
 * A white wash laid over the basemap (but under the pins, which are DOM and
 * always on top). Fading it in when a city opens pushes the streets back and
 * leaves the itinerary as the only thing with real contrast.
 */
function addScrim(map: maplibregl.Map) {
  if (map.getLayer(SCRIM_LAYER)) return;
  map.addLayer({
    id: SCRIM_LAYER,
    type: 'background',
    paint: { 'background-color': '#ffffff', 'background-opacity': 0 },
  });
}

export default function MapView({ trip }: MapViewProps) {
  const [pins, setPins] = useState<PinPoint[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  // Read by the framing code so the padding is current, WITHOUT making the
  // panel a framing trigger. Depending on `panelOpen` directly meant closing
  // and reopening the itinerary flew the camera back to the trip bounds every
  // time, throwing away wherever the user had navigated to.
  const panelOpenRef = useRef(true);
  // True when the panel was closed BY the layout rather than by the user, so
  // it can be restored on widening without overriding a deliberate close.
  const autoClosedRef = useRef(false);
  const [includeHome, setIncludeHome] = useState(false);
  const [ready, setReady] = useState(false);
  const [styleKey, setStyleKey] = useState<StyleKey>(readStoredStyle);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  // Bumped after a theme swap so the route layer (wiped by setStyle) re-adds.
  const [styleEpoch, setStyleEpoch] = useState(0);
  // Current camera zoom, mirrored into React so the country/city tier can
  // render from it. Updated on zoomend/moveend, never per animation frame.
  const [zoomLevel, setZoomLevel] = useState(2);

  // ─── Spot state (the places inside one city) ───
  // Which city's spots we're showing, whether the zoom is close enough to show
  // them, and the resolved spots themselves. Geocoding is LAZY per city: doing
  // every city up front would be dozens of rate-limited lookups (~1/sec).
  const [activeCityIndex, setActiveCityIndex] = useState<number | null>(null);
  // Mirror for the map's zoom listener, which is registered once and would
  // otherwise close over a stale activeCityIndex.
  const activeCityRef = useRef<number | null>(null);
  // True once the camera has actually framed the open city. The zoom-out exit
  // must not fire before then: with no camera move on click, the map is still
  // at trip zoom — below the exit threshold — so any stray `zoomend` would
  // close the city the moment it opened.
  const cityFramedRef = useRef(false);
  // Set when the city opened because the user zoomed into it rather than
  // clicking. They are already driving the camera, so the framing effect must
  // not yank it somewhere else underneath them.
  const enteredByZoomRef = useRef(false);
  // The viewport listener is registered once on the map, so it reads pins
  // through a ref rather than closing over the first render's array.
  const pinsRef = useRef<PinPoint[]>([]);
  // Set by the map-create effect; lets other effects re-run the level-of-detail
  // check when something other than the camera changes.
  const syncRef = useRef<() => void>(() => {});
  const [spots, setSpots] = useState<Spot[]>([]);
  const [spotsLoading, setSpotsLoading] = useState(false);
  const [spotsDropped, setSpotsDropped] = useState<string[]>([]);
  const spotCacheRef = useRef<Map<string, { spots: Spot[]; dropped: string[] }>>(new Map());
  const spotMarkersRef = useRef<maplibregl.Marker[]>([]);

  // ─── Recommendations (places near the city that AREN'T in the plan) ───
  // Opt-in, not automatic. Each suggestion costs a rate-limited geocode on top
  // of the itinerary's own, and quietly doubling a 15-second wait to show
  // things nobody asked for is the wrong default.
  const [recsOn, setRecsOn] = useState(false);
  const [recs, setRecs] = useState<Spot[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const recCacheRef = useRef<Map<string, Spot[]>>(new Map());
  const recMarkersRef = useRef<maplibregl.Marker[]>([]);
  const countryMarkersRef = useRef<maplibregl.Marker[]>([]);

  const shellRef = useRef<HTMLDivElement | null>(null);
  // Keep the mount-time theme stable so the create effect never re-runs on switch.
  const initialStyleRef = useRef<StyleKey>(styleKey);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  const hasHome = !!trip.origin?.city;

  // Names in visit order; home first when the trip has an origin anchor.
  //
  // `query` is what the geocoder is asked, and it carries the country. A bare
  // city name resolves to whatever the world considers most prominent, which
  // is not always a city: "Nara" comes back as the US National Archives in
  // Washington DC, putting a Japan trip's pin on the wrong continent and
  // stretching the map's bounds across the Atlantic.
  const names = useMemo(() => {
    const list: { name: string; query: string; kind: 'home' | 'city'; cityIndex: number }[] = [];
    if (trip.origin?.city) {
      list.push({
        name: trip.origin.city,
        query: trip.origin.city,
        kind: 'home',
        cityIndex: -1,
      });
    }
    trip.cities.forEach((c, i) =>
      list.push({
        name: c.name,
        query: c.country ? `${c.name}, ${c.country}` : c.name,
        kind: 'city',
        cityIndex: i,
      }),
    );
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
        // Low enough to frame a trip that crosses half the planet. At 2 the
        // camera could not zoom out far enough to fit "Show home" on a
        // Philadelphia → Japan trip: fitBounds clamped at the floor and left
        // the home pin off the edge. The itinerary panel floats over the map
        // and its padding claims ~45% of the width, so the fit needs room
        // below 1 as well.
        minZoom: 0,
        attributionControl: { compact: true },
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      // `load` is the normal signal, `idle` the backstop. A map constructed
      // while its container is still zero-height can finish its style but
      // never complete a first render, so `load` never arrives and the map
      // stays permanently blank with no pins — nothing recovers it, because
      // every marker effect is gated on `ready`. `idle` fires whenever the
      // map settles, so whichever happens first wins.
      let readied = false;
      const markReady = () => {
        if (readied || !map) return;
        readied = true;
        addScrim(map);
        setReady(true);
      };
      map.on('load', markReady);
      map.on('idle', markReady);
      // The level of detail follows the camera: zoom into a city and its spots
      // appear, zoom back out to trip scale and they go away again. Clicking a
      // pin is a shortcut to the same state, not the only route into it.
      //
      // `zoomend`/`moveend`, NOT the continuous `zoom`/`move`: those also fire
      // on the early frames of a zoom-IN animation, where the camera is still
      // below the threshold, which cleared the city the instant it opened.
      const syncCityToViewport = () => {
        const m = mapRef.current;
        if (!m) return;
        const z = m.getZoom();
        // Drives the country/city tier. Panning re-fires this with the same
        // zoom, and React bails on an unchanged number, so it costs nothing.
        setZoomLevel(z);
        const active = activeCityRef.current;
        const bounds = m.getBounds();
        const centre = m.getCenter();
        const cityPins = pinsRef.current.filter((p) => p.kind === 'city');

        // Nearest city to the middle of the screen, ignoring any that aren't
        // actually on it — zooming into empty ocean should open nothing.
        let best: PinPoint | null = null;
        let bestKm = Infinity;
        for (const p of cityPins) {
          if (!bounds.contains([p.point.lon, p.point.lat])) continue;
          const km = distanceKm({ lat: centre.lat, lon: centre.lng }, p.point);
          if (km < bestKm) {
            bestKm = km;
            best = p;
          }
        }

        if (active !== null) {
          // Leaving: only once the camera has settled, so a stray event mid
          // zoom-in can't close a city that is still being framed.
          if (z < CITY_EXIT_ZOOM && cityFramedRef.current) {
            setActiveCityIndex(null);
            return;
          }
          // "Am I still in this city?" is a question about distance, not about
          // the centroid being on screen. Framing a city zooms to its SPOTS,
          // and the city's own centroid often sits outside that tight box —
          // judged by `contains` the map would decide you had left Nara the
          // moment it finished flying you into Nara. Allow the visible radius
          // plus a town's worth of slack.
          const ne = bounds.getNorthEast();
          const viewRadiusKm = distanceKm(
            { lat: centre.lat, lon: centre.lng },
            { lat: ne.lat, lon: ne.lng },
          );
          const activePin = cityPins.find((p) => p.cityIndex === active);
          const stillHere =
            !!activePin &&
            distanceKm({ lat: centre.lat, lon: centre.lng }, activePin.point) <=
              viewRadiusKm + CITY_FRAME_KM;
          if (stillHere) return;

          // Panned off this city. Onto another one — follow it.
          if (best && z >= CITY_ENTER_ZOOM) {
            enteredByZoomRef.current = true;
            setActiveCityIndex(best.cityIndex);
            return;
          }
          // Onto nothing at all. Without this you stay stuck in the city you
          // just left: its spots keep rendering off-screen while you look at
          // open sea, because the zoom never dropped far enough to exit.
          // Guarded on `cityFramedRef` so a click-entry isn't closed during
          // the framing move, when the city can briefly sit out of bounds.
          if (cityFramedRef.current) setActiveCityIndex(null);
          return;
        }

        if (z >= CITY_ENTER_ZOOM && best) {
          // Entered by zoom, so the exit is armed immediately — there is no
          // framing move to wait for.
          enteredByZoomRef.current = true;
          cityFramedRef.current = true;
          setActiveCityIndex(best.cityIndex);
        }
      };
      map.on('zoomend', syncCityToViewport);
      map.on('moveend', syncCityToViewport);
      // Also callable from outside: the camera is not the only thing that can
      // leave the view and the level of detail disagreeing. A theme swap
      // rebuilds the style and drops the open city while the camera stays put
      // at city zoom, and no move event follows to put it right.
      syncRef.current = syncCityToViewport;
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
    geocodeCities(names.map((n) => n.query)).then((points) => {
      if (cancelled) return;
      const resolved: PinPoint[] = [];
      const failed: string[] = [];
      points.forEach((p, i) => {
        // Pins carry the display name, not the country-qualified query.
        if (p) {
          resolved.push({
            name: names[i].name,
            kind: names[i].kind,
            cityIndex: names[i].cityIndex,
            point: p,
          });
        } else failed.push(names[i].name);
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
  // ─── Country tier: cities grouped by the country they're in ───
  const countryPins = useMemo(() => {
    const groups = new Map<string, { points: GeoPoint[]; cityIndexes: number[] }>();
    for (const p of pins) {
      if (p.kind !== 'city') continue;
      const country = trip.cities[p.cityIndex]?.country?.trim();
      if (!country) continue;
      const g = groups.get(country) ?? { points: [], cityIndexes: [] };
      g.points.push(p.point);
      g.cityIndexes.push(p.cityIndex);
      groups.set(country, g);
    }
    const out: { country: string; point: GeoPoint; cityIndexes: number[] }[] = [];
    groups.forEach((g, country) => {
      out.push({
        country,
        point: centroid(g.points),
        cityIndexes: [...g.cityIndexes].sort((a, b) => a - b),
      });
    });
    // In the order the trip reaches them, so the countries can be numbered
    // 1..n and the list reads as the journey rather than as a lookup table.
    out.sort((a, b) => a.cityIndexes[0] - b.cityIndexes[0]);
    return out;
  }, [pins, trip.cities]);

  // Which tier the camera is on. Countries once zoomed out past the threshold,
  // on any trip with more than one stop. The win isn't only fewer pins — at
  // continental zoom "France / Netherlands / Czechia" reads far better than
  // three anonymous numbered dots overlapping each other, even though it is
  // the same count. A single-stop trip keeps its city, since naming the
  // country there tells you strictly less.
  const showCountries =
    activeCityIndex === null &&
    zoomLevel < COUNTRY_ZOOM &&
    countryPins.length > 0 &&
    pins.filter((p) => p.kind === 'city').length > 1;

  const legs = useMemo(() => {
    const ordered = [...pins].sort((a, b) => a.cityIndex - b.cityIndex);
    // At the country tier the pins are country pills, so a route drawn through
    // city coordinates floats free of them — a line to nowhere. Redraw it
    // country to country instead, collapsing consecutive stops in the same
    // country into one node, so the dashed path still reads as the journey.
    if (showCountries) {
      const byCountry = new Map(countryPins.map((c) => [c.country, c.point]));
      const seq: [number, number][] = [];
      let last = '';
      for (const p of ordered) {
        if (p.kind === 'home') continue;
        const country = trip.cities[p.cityIndex]?.country?.trim();
        const point = country ? byCountry.get(country) : undefined;
        if (!country || !point || country === last) continue;
        seq.push([point.lat, point.lon]);
        last = country;
      }
      const homePin = pins.find((p) => p.kind === 'home');
      if (homePin && includeHome) {
        seq.unshift([homePin.point.lat, homePin.point.lon]);
        if (trip.returnToHome !== false && seq.length > 1) {
          seq.push([homePin.point.lat, homePin.point.lon]);
        }
      }
      const outC: { coords: [number, number][]; home: boolean }[] = [];
      for (let i = 0; i < seq.length - 1; i++) {
        const isHomeLeg =
          !!homePin &&
          ((seq[i][0] === homePin.point.lat && seq[i][1] === homePin.point.lon) ||
            (seq[i + 1][0] === homePin.point.lat && seq[i + 1][1] === homePin.point.lon));
        outC.push({ coords: arc(seq[i], seq[i + 1]), home: isHomeLeg });
      }
      return outC;
    }

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
  }, [pins, trip.returnToHome, trip.cities, showCountries, countryPins, includeHome]);

  // ─── Draw the route line ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // Inside a city the inter-city legs aren't the subject — they just cut a
    // hard blue diagonal across the place you're actually looking at.
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features:
        activeCityIndex !== null
          ? []
          : legs
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
  }, [legs, includeHome, ready, styleEpoch, activeCityIndex]);

  // Fade the basemap back while a city is open.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    addScrim(map);
    if (map.getLayer(SCRIM_LAYER)) {
      // Enough to push the streets back, not so much that the city stops being
      // readable — you still need to see where things are to plan around them.
      map.setPaintProperty(SCRIM_LAYER, 'background-opacity', activeCityIndex !== null ? 0.28 : 0);
    }
  }, [activeCityIndex, ready, styleEpoch]);

  // ─── Rebuild the pin markers ───
  // Clicking a city frames the whole region around it (roughly a state/metro
  // area), so you can see the nearby cities — and, once Phase 3 lands, the
  // itinerary's own spot pins within the city.
  const focusCity = useCallback((index: number) => {
    const map = mapRef.current;
    const target = pins.find((p) => p.cityIndex === index && p.kind === 'city');
    if (!map || !target) return;
    // Clicked, not zoomed — the framing move below is wanted.
    enteredByZoomRef.current = false;
    setActiveCityIndex(index);
    // Deliberately NO camera move here. Opening a city used to jump the map to
    // zoom 11, trickle pins in for up to ~25s, then move a SECOND time to fit
    // them — three separate lurches. Instead the panel switches immediately as
    // feedback, and the effect below performs a single move once the places
    // are known. If they're already cached that happens instantly.
  }, [pins]);

  /**
   * Zoom from a country down to the cities inside it — the middle step of the
   * drill-down. Deliberately stops at city scale rather than opening a city:
   * with several stops in the country there is no single right one to open,
   * and the choice belongs to the traveller.
   */
  const focusCountry = useCallback(
    (cityIndexes: number[]) => {
      const map = mapRef.current;
      if (!map) return;
      const points = pins
        .filter((p) => p.kind === 'city' && cityIndexes.includes(p.cityIndex))
        .map((p) => p.point);
      if (points.length === 0) return;

      const padding = framePadding(map, panelOpenRef.current);
      if (points.length === 1) {
        map.easeTo({
          center: [points[0].lon, points[0].lat],
          zoom: Math.max(COUNTRY_ZOOM + 1.5, 7),
          padding,
          duration: 650,
        });
        return;
      }
      map.fitBounds(shortestBounds(points), { padding, maxZoom: 9, duration: 650 });
    },
    [pins],
  );

  // Keep the listener's mirrors in step.
  useEffect(() => {
    pinsRef.current = pins;
  }, [pins]);

  useEffect(() => {
    panelOpenRef.current = panelOpen;
  }, [panelOpen]);

  // Re-check the level of detail after changes the camera doesn't announce —
  // a theme swap, the pin set being rebuilt, the map first becoming ready.
  // Without this the map can sit at city zoom showing the trip overview.
  useEffect(() => {
    if (!ready) return;
    syncRef.current();
  }, [ready, styleEpoch, pins]);

  useEffect(() => {
    activeCityRef.current = activeCityIndex;
    // A city entered by zoom is framed by definition — the user's own camera
    // put it on screen, so the exit is armed at once. One entered by click has
    // no camera move yet, and must not be closed before the framing lands.
    cityFramedRef.current = activeCityIndex !== null && enteredByZoomRef.current;
  }, [activeCityIndex]);

  // City dots belong to the trip overview. Inside a city the itinerary spots
  // are the subject, and the big numbered dot just sits on top of them.
  // Zoomed right out, the countries stand in for them.
  const visibleCityPins = useMemo(() => {
    if (activeCityIndex !== null) return [];
    // Home belongs to no country, so the grouping can't stand in for it. Drop
    // it here and it vanishes at exactly the zoom where a New York → Japan
    // trip most needs to show where it starts from.
    if (showCountries) return pins.filter((p) => p.kind === 'home');
    return pins;
  }, [pins, activeCityIndex, showCountries]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = visibleCityPins.map((pin) => {
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
  }, [visibleCityPins, ready, focusCity]);

  // ─── Resolve the active city's spots (lazy, cached per city) ───
  useEffect(() => {
    if (activeCityIndex === null) {
      setSpots([]);
      setSpotsDropped([]);
      setSpotsLoading(false);
      return;
    }
    // Keyed by the city itself, NOT its position. Positions are not stable:
    // reordering the trip (or inserting a city) leaves index 2 pointing at a
    // different city, and an index-keyed cache then hands the newcomer the
    // previous occupant's places — Osaka's panel listing Kyoto's temples.
    const cacheKey = cityCacheKey(trip.cities[activeCityIndex]);
    if (!cacheKey) return;
    const cached = spotCacheRef.current.get(cacheKey);
    if (cached) {
      setSpots(cached.spots);
      setSpotsDropped(cached.dropped);
      setSpotsLoading(false);
      return;
    }
    const centerPin = pins.find((p) => p.cityIndex === activeCityIndex && p.kind === 'city');
    if (!centerPin) return;

    const seeds = buildCitySpots(trip, activeCityIndex);
    if (seeds.length === 0) {
      spotCacheRef.current.set(cacheKey, { spots: [], dropped: [] });
      setSpots([]);
      setSpotsDropped([]);
      return;
    }

    let cancelled = false;
    setSpotsLoading(true);
    setSpots([]);
    geocodeSpots(seeds, centerPin.point)
      .then((res) => {
        // Cache regardless of cancellation — the work is done and valid.
        spotCacheRef.current.set(cacheKey, res);
        if (cancelled) return;
        setSpots(res.spots);
        setSpotsDropped(res.dropped);
      })
      .catch(() => {
        if (!cancelled) setSpotsDropped(seeds.map((s) => s.name));
      })
      .finally(() => {
        if (!cancelled) setSpotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCityIndex, pins, trip]);

  // ─── Draw the spot markers ───
  // No zoom gate: opening a city is deliberate, so its spots show right away.
  // Memoised because the marker effect keys off it — a fresh array each render
  // tore every marker down and rebuilt it, which flickered the pins.
  const visibleSpots = useMemo(
    () => (activeCityIndex !== null ? spots : []),
    [activeCityIndex, spots],
  );

  // ─── Resolve recommendations for the open city (opt-in, cached per city) ───
  useEffect(() => {
    if (activeCityIndex === null || !recsOn) {
      setRecs([]);
      setRecsLoading(false);
      return;
    }
    const city = trip.cities[activeCityIndex];
    const key = cityCacheKey(city);
    if (!key) return;
    const cached = recCacheRef.current.get(key);
    if (cached) {
      setRecs(cached);
      setRecsLoading(false);
      return;
    }
    const centerPin = pins.find((p) => p.cityIndex === activeCityIndex && p.kind === 'city');
    if (!centerPin) return;

    let cancelled = false;
    setRecsLoading(true);
    setRecs([]);
    (async () => {
      // Ask for both kinds together; either can fail without sinking the other.
      const [acts, rests] = await Promise.all([
        searchActivities({ city: city.name, country: city.country }).catch(() => []),
        searchRestaurants({ city: city.name, country: city.country }).catch(() => []),
      ]);
      const suggestions: Suggestion[] = [
        ...acts.map((a) => ({ name: a.name, detail: a.reason ? 'Suggested' : undefined })),
        ...rests.map((r) => ({
          name: r.name,
          detail: [r.cuisine, r.priceRange].filter(Boolean).join(' · ') || 'Suggested',
          kindHint: 'restaurant' as const,
        })),
      ];
      const seeds = buildRecommendedSpots(city, suggestions);
      if (seeds.length === 0) {
        recCacheRef.current.set(key, []);
        if (!cancelled) setRecs([]);
        return;
      }
      const res = await geocodeSpots(seeds, centerPin.point);
      // `geocodeSpots` returns plain seeds; carry the flag back through so the
      // marker renderer still knows these are suggestions.
      const flagged = res.spots.map((s) => ({ ...s, recommended: true }));
      recCacheRef.current.set(key, flagged);
      if (!cancelled) setRecs(flagged);
    })()
      .catch(() => {
        if (!cancelled) setRecs([]);
      })
      .finally(() => {
        if (!cancelled) setRecsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCityIndex, recsOn, pins, trip]);

  const visibleRecs = useMemo(
    () => (activeCityIndex !== null && recsOn ? recs : []),
    [activeCityIndex, recsOn, recs],
  );

  /**
   * Frame the open city around its own spots, so every pin is separated
   * instead of clumped. The airport is excluded from the fit — it sits ~25km
   * out and including it squeezes the in-town spots back into a blob (measured:
   * 12px apart at region zoom, with 24px pins).
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || activeCityIndex === null || spotsLoading) return;
    // The user zoomed here themselves — they are driving the camera, and
    // moving it under them to "frame" what they are already looking at reads
    // as the map fighting the scroll. Only a click asks to be flown somewhere.
    if (enteredByZoomRef.current) return;
    const centre = pins.find((p) => p.cityIndex === activeCityIndex && p.kind === 'city');
    // Frame on what's actually in town: the airport sits ~25km out, and a day
    // trip can be 100km+ away. Including either zooms the view out until the
    // in-town spots collapse together (measured: 12px apart, 24px pins).
    const inTown = spots.filter(
      (s) =>
        s.kind !== 'airport' &&
        (!centre || distanceKm(centre.point, s.point) <= CITY_FRAME_KM),
    );
    // Arm the zoom-out exit only now that we're framing the city.
    const framed = () => {
      cityFramedRef.current = true;
    };

    // Nothing placeable in town — still go to the city rather than sit at
    // trip zoom looking like the click did nothing.
    if (inTown.length === 0) {
      if (!centre) return;
      map.easeTo({ center: [centre.point.lon, centre.point.lat], zoom: 12, duration: 600 });
      map.once('moveend', framed);
      return;
    }

    if (inTown.length === 1) {
      map.easeTo({ center: [inTown[0].point.lon, inTown[0].point.lat], zoom: 13.5, duration: 600 });
      map.once('moveend', framed);
      return;
    }
    const b = new maplibregl.LngLatBounds();
    inTown.forEach((s) => b.extend([s.point.lon, s.point.lat]));
    map.fitBounds(b, {
      // Extra room on the left: the itinerary panel floats over the map there,
      // and without this a spot (and its name) lands underneath it. Top gets a
      // little more too, since each pin carries its label above it.
      padding: framePadding(map, panelOpenRef.current, { top: 86, bottom: 70, side: 70, panel: 272 }),
      maxZoom: 15,
      duration: 700,
    });
    map.once('moveend', framed);
  }, [activeCityIndex, spots, spotsLoading, ready, pins]);

  /**
   * Nudge spot pins that land on top of each other.
   *
   * Real itineraries cluster: Shibuya Crossing and two Shibuya restaurants sit
   * a few hundred metres apart, while the view has to span 10km out to Asakusa
   * — measured at 16px apart with 24px pins, i.e. unclickable. Colliding pins
   * get a small pixel offset (never more than ~30px, so they stay next to the
   * truth) purely for legibility; the underlying coordinate is untouched.
   */
  const declutterSpots = useCallback(() => {
    const map = mapRef.current;
    // Both layers together. They occupy the same city at the same zoom, so
    // decluttering them separately just means each set avoids itself and then
    // lands on the other — in Milan that put the hotel, Luini, the Duomo and
    // the Pinacoteca in one unreadable knot.
    const markers = [...spotMarkersRef.current, ...recMarkersRef.current];
    if (!map || markers.length < 2) return;
    const RADIUS = 27;
    const placed: { x: number; y: number }[] = [];
    for (const marker of markers) {
      marker.setOffset([0, 0]);
      const base = map.project(marker.getLngLat());
      let dx = 0;
      let dy = 0;
      for (let attempt = 1; attempt <= 12; attempt++) {
        const clash = placed.some(
          (p) => Math.hypot(p.x - (base.x + dx), p.y - (base.y + dy)) < RADIUS,
        );
        if (!clash) break;
        // Walk around a widening ring until a free slot turns up.
        const angle = (attempt % 6) * (Math.PI / 3);
        const ring = RADIUS * (1 + Math.floor((attempt - 1) / 6) * 0.55);
        dx = Math.cos(angle) * ring;
        dy = Math.sin(angle) * ring;
      }
      marker.setOffset([dx, dy]);
      placed.push({ x: base.x + dx, y: base.y + dy });
    }
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    spotMarkersRef.current.forEach((m) => m.remove());
    spotMarkersRef.current = visibleSpots.map((spot) =>
      new maplibregl.Marker({ element: makeSpotEl(spot), anchor: 'center' })
        .setLngLat([spot.point.lon, spot.point.lat])
        .addTo(map),
    );
    // Recompute on ZOOM only, never on pan. Panning doesn't change the pixel
    // distance between two pins, so re-running it on every camera move just
    // reshuffled the nudges and made the pins visibly jump — most obviously
    // when clicking a row in the panel, which flies the map.
    const raf = requestAnimationFrame(declutterSpots);
    map.on('zoomend', declutterSpots);
    return () => {
      cancelAnimationFrame(raf);
      map.off('zoomend', declutterSpots);
      spotMarkersRef.current.forEach((m) => m.remove());
      spotMarkersRef.current = [];
    };
  }, [visibleSpots, ready, declutterSpots]);

  /**
   * Nudge country pills off each other.
   *
   * The spot version walks a ring, which suits small round pins. These are
   * wide name-plates — ~110px across and ~28px tall — so a ring just slides
   * them sideways into the next one. On a nine-country European tour that
   * left Switzerland, Germany, Austria, Italy and Hungary in one unreadable
   * heap. They separate vertically instead, alternating up and down from the
   * true position so the pill stays near the country it names.
   */
  const declutterCountries = useCallback(() => {
    const map = mapRef.current;
    const markers = countryMarkersRef.current;
    if (!map || markers.length < 2) return;
    const HALF_W = 62;
    const STEP = 30;
    const placed: { x: number; y: number }[] = [];
    for (const marker of markers) {
      marker.setOffset([0, 0]);
      const base = map.project(marker.getLngLat());
      let dy = 0;
      for (let attempt = 1; attempt <= 10; attempt++) {
        const clash = placed.some(
          (p) => Math.abs(p.x - base.x) < HALF_W * 2 && Math.abs(p.y - (base.y + dy)) < STEP,
        );
        if (!clash) break;
        // ±30, ±60, ±90 … so a pill never drifts far from its own country.
        const step = Math.ceil(attempt / 2) * STEP;
        dy = attempt % 2 === 1 ? -step : step;
      }
      marker.setOffset([0, dy]);
      placed.push({ x: base.x, y: base.y + dy });
    }
  }, []);

  // Country markers. Clicking one drills down to the cities inside it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const shown = showCountries ? countryPins : [];
    countryMarkersRef.current.forEach((m) => m.remove());
    countryMarkersRef.current = shown.map((c, i) => {
      // Numbered 1..n as countries, matching the panel and the "3 countries"
      // header. The city-level stop numbers live in the tooltip.
      const el = makeCountryEl(
        c.country,
        String(i + 1),
        visitOrderLabel(c.cityIndexes),
        c.cityIndexes.length,
      );
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        focusCountry(c.cityIndexes);
      });
      return new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([c.point.lon, c.point.lat])
        .addTo(map);
    });
    const raf = requestAnimationFrame(declutterCountries);
    map.on('zoomend', declutterCountries);
    return () => {
      cancelAnimationFrame(raf);
      map.off('zoomend', declutterCountries);
      countryMarkersRef.current.forEach((m) => m.remove());
      countryMarkersRef.current = [];
    };
  }, [showCountries, countryPins, ready, focusCountry, declutterCountries]);

  // Recommendation markers, kept in their own layer so toggling them off never
  // disturbs the itinerary's pins.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    recMarkersRef.current.forEach((m) => m.remove());
    recMarkersRef.current = visibleRecs.map((spot) =>
      new maplibregl.Marker({ element: makeSpotEl(spot), anchor: 'center' })
        .setLngLat([spot.point.lon, spot.point.lat])
        .addTo(map),
    );
    // Re-run the shared declutter now this layer exists, and keep it in step
    // on zoom — otherwise suggestions sit on top of the itinerary's own pins.
    const raf = requestAnimationFrame(declutterSpots);
    map.on('zoomend', declutterSpots);
    return () => {
      cancelAnimationFrame(raf);
      map.off('zoomend', declutterSpots);
      recMarkersRef.current.forEach((m) => m.remove());
      recMarkersRef.current = [];
    };
  }, [visibleRecs, ready, declutterSpots]);

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

    // The itinerary panel floats OVER the map's left edge, so uniform padding
    // frames pins underneath it — on a Paris/Amsterdam/Prague trip Amsterdam
    // landed fully behind the panel. Reserve the panel's width on the left,
    // exactly as the city-level framing below already does.
    const padding = framePadding(map, panelOpenRef.current);

    if (usable.length === 1) {
      map.jumpTo({ center: [usable[0].point.lon, usable[0].point.lat], zoom: 7, padding });
      return;
    }
    const bounds = shortestBounds(usable.map((p) => p.point));
    map.fitBounds(bounds, { padding, maxZoom: 9, animate: false });
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
      // Always tell MapLibre the box changed, including on the very first
      // observation. It caches its canvas size, so a map built before the
      // container had height stays that size until something says otherwise —
      // and skipping the first callback outright skipped exactly the event
      // that would have fixed it.
      mapRef.current?.resize();

      // Give the map back its width when the panel no longer fits. Below the
      // threshold there isn't room for the trip AND the panel, and the panel
      // would sit on top of the westernmost stop. Reopens itself when there's
      // room again — but only if IT closed the panel, never overriding a
      // deliberate close.
      const mapW = mapRef.current?.getContainer().clientWidth ?? 0;
      if (mapW > 0) {
        if (!panelFits(mapW) && panelOpenRef.current) {
          autoClosedRef.current = true;
          setPanelOpen(false);
        } else if (panelFits(mapW) && autoClosedRef.current && !panelOpenRef.current) {
          autoClosedRef.current = false;
          setPanelOpen(true);
        }
      }
      if (first) {
        // Don't re-frame on the initial observation, though: the opening fit
        // is already on its way and would only fight it.
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
    // Deliberately no re-frame. This used to re-fit once the panel finished
    // animating, so the padding matched its new width — but that threw the
    // camera back to the trip bounds on every open and close, losing wherever
    // the user had navigated to. Showing and hiding an overlay is not a
    // request to move the map. The padding still applies at the moments that
    // genuinely frame something: first fit, opening a city, drilling into a
    // country.
    //
    // A manual toggle also cancels any auto-close, so widening the window
    // later doesn't spring the panel back open against the user's wishes.
    autoClosedRef.current = false;
    setPanelOpen((v) => !v);
  }, []);

  /** The city currently opened in the panel, if any. */
  const activeCity = activeCityIndex !== null ? trip.cities[activeCityIndex] : undefined;

  /** Leave the city view and go back to the whole trip. */
  const closeCity = useCallback(() => {
    setActiveCityIndex(null);
    fitToTrip();
  }, [fitToTrip]);

  const flyToSpot = useCallback((spot: Spot) => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({
      center: [spot.point.lon, spot.point.lat],
      zoom: Math.max(map.getZoom(), 14),
      duration: 550,
    });
  }, []);

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
        // Capped at 40% of the map. At a fixed 236px the panel is more than
        // half of a narrow pane, and then no amount of framing padding can
        // both clear it and fit a widely-spread trip — one of the two has to
        // break, and both did in turn.
        className={`absolute top-3 left-3 z-[600] w-[236px] max-w-[40%] max-h-[calc(100%-1.5rem)] hidden md:flex flex-col transition-all duration-200 ease-out ${
          panelOpen
            ? 'opacity-100 translate-x-0 pointer-events-auto'
            : 'opacity-0 -translate-x-2 pointer-events-none'
        }`}
        aria-hidden={!panelOpen}
      >
        <div className="min-h-0 flex flex-col bg-white rounded-xl border border-black/10 shadow-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between gap-2">
            {activeCity ? (
              <button
                onClick={closeCity}
                className="flex items-center gap-1 min-w-0 text-left group/back"
                title="Back to all stops"
              >
                <ChevronLeft
                  size={14}
                  className="text-gray-400 group-hover/back:text-gray-700 transition-colors flex-shrink-0"
                />
                <span className="text-[12px] font-semibold text-gray-800 truncate">
                  {activeCity.name}
                </span>
              </button>
            ) : (
              <span className="text-[12px] font-semibold text-gray-800">
                {showCountries ? 'Countries' : 'Itinerary'}
              </span>
            )}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-[11px] text-gray-400">
                {activeCity
                  ? `${nightsBetween(activeCity.dates?.arrival, activeCity.dates?.departure)}n`
                  : showCountries
                    ? `${countryPins.length} ${countryPins.length === 1 ? 'country' : 'countries'}`
                    : `${trip.cities.length} ${trip.cities.length === 1 ? 'stop' : 'stops'}`}
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

          {/* ── City detail: what's planned inside the open city ── */}
          {activeCity && (
            <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1.5">
              {spotsLoading && (
                <p className="px-2 py-2 text-[11px] text-gray-400">Finding places…</p>
              )}
              {!spotsLoading && spots.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-gray-400">
                  Nothing to place on the map for this stop yet.
                </p>
              )}
              {spots.map((spot, i) => (
                <button
                  key={`${spot.kind}-${spot.name}-${i}`}
                  onClick={() => flyToSpot(spot)}
                  title={`Show ${spot.name} on the map`}
                  className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <span
                    className="w-5 h-5 rounded-full bg-white flex items-center justify-center flex-shrink-0 mt-0.5"
                    style={{ border: `2px solid ${SPOT_STYLE[spot.kind].color}` }}
                    dangerouslySetInnerHTML={{ __html: spotSvg(spot.kind, 9) }}
                  />
                  <span className="min-w-0">
                    <span className="block text-[11.5px] font-medium text-gray-800 leading-snug">
                      {spot.name}
                    </span>
                    {spot.detail && (
                      <span className="block text-[10px] text-gray-400 truncate">
                        {spot.detail}
                      </span>
                    )}
                  </span>
                </button>
              ))}
              {spotsDropped.length > 0 && !spotsLoading && (
                <p
                  className="px-2 pt-2 text-[10px] text-gray-400 border-t border-gray-100 mt-1"
                  title={spotsDropped.join(', ')}
                >
                  Couldn&apos;t place: {spotsDropped.join(', ')}
                </p>
              )}

              {/* ── Suggestions: places here that aren't in the plan ── */}
              <div className="border-t border-gray-100 mt-1.5 pt-1.5">
                <button
                  onClick={() => setRecsOn((v) => !v)}
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
                  title={
                    recsOn
                      ? 'Hide suggested places'
                      : 'Find well-known places here that aren’t in your plan'
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <span className="text-[11px]" style={{ color: '#94a3b8' }}>
                      ★
                    </span>
                    <span className="text-[11.5px] font-medium text-gray-700">
                      Also worth seeing
                    </span>
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {recsOn ? 'Hide' : 'Show'}
                  </span>
                </button>

                {recsOn && recsLoading && (
                  <p className="px-2 py-1.5 text-[11px] text-gray-400">Looking around…</p>
                )}
                {recsOn && !recsLoading && recs.length === 0 && (
                  <p className="px-2 py-1.5 text-[11px] text-gray-400">
                    Nothing to suggest beyond what you&apos;ve already planned.
                  </p>
                )}
                {recsOn &&
                  recs.map((spot, i) => (
                    <button
                      key={`rec-${spot.name}-${i}`}
                      onClick={() => flyToSpot(spot)}
                      title={`Show ${spot.name} on the map`}
                      className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{
                          border: `2px dashed ${SPOT_STYLE[spot.kind].color}`,
                          background: 'rgba(255,255,255,0.82)',
                        }}
                        dangerouslySetInnerHTML={{ __html: spotSvg(spot.kind, 9) }}
                      />
                      <span className="min-w-0">
                        <span className="block text-[11.5px] text-gray-600 leading-snug">
                          {spot.name}
                        </span>
                        {spot.detail && (
                          <span className="block text-[10px] text-gray-400 truncate">
                            {spot.detail}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          {/* ── Country tier: the panel follows the map. Listing four cities
                 while the map shows three country pills reads as two different
                 views of the same trip disagreeing with each other. ── */}
          {!activeCity && showCountries && (
            <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1.5">
              {countryPins.map((c, i) => (
                <button
                  key={c.country}
                  onClick={() => focusCountry(c.cityIndexes)}
                  title={`${c.country} — ${c.cityIndexes.length === 1 ? 'stop' : 'stops'} ${visitOrderLabel(c.cityIndexes)}. Zoom in.`}
                  className="w-full text-left flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  {/* The country's position in the journey, 1..n — so the list
                      counts up to the "N countries" in the header. Which stops
                      those are is in the subtitle and the tooltip. */}
                  <span
                    className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold"
                    style={{ background: BLUE.water, color: BLUE.textStrong }}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-gray-800 truncate">
                      {c.country}
                    </span>
                    <span className="block text-[10px] text-gray-400 truncate">
                      {c.cityIndexes.map((i) => trip.cities[i]?.name).filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              ))}
              <p className="px-2 pt-1.5 text-[10px] text-gray-400">
                Zoom in to see individual stops.
              </p>
            </div>
          )}

          {!activeCity && !showCountries && (
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
          )}

          {missing.length > 0 && !activeCity && (
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

        {/* Spot status + legend. Only while a city is open, since that's the
            only time spot pins are on the map. */}
        {!loading && activeCityIndex !== null && (
          <div className="absolute bottom-3 left-3 z-[500] flex flex-col gap-1.5 items-start">
            {spotsLoading && (
              <div className="px-3 py-1.5 rounded-full text-[12px] bg-white/95 border border-black/10 shadow-sm text-gray-600">
                Finding places in {trip.cities[activeCityIndex]?.name}…
              </div>
            )}
            {!spotsLoading && visibleSpots.length > 0 && (
              <div className="px-2.5 py-1.5 rounded-lg bg-white/95 border border-black/10 shadow-sm flex items-center gap-2.5 flex-wrap max-w-[420px]">
                {(Object.keys(SPOT_STYLE) as SpotKind[])
                  .filter((k) => visibleSpots.some((s) => s.kind === k))
                  .map((k) => (
                    <span key={k} className="flex items-center gap-1 text-[10.5px] text-gray-600">
                      <span
                        className="w-3.5 h-3.5 rounded-full bg-white flex items-center justify-center flex-shrink-0"
                        style={{ border: `2px solid ${SPOT_STYLE[k].color}` }}
                      />
                      {SPOT_STYLE[k].label}
                    </span>
                  ))}
                {spotsDropped.length > 0 && (
                  <span
                    className="text-[10.5px] text-gray-400"
                    title={`No location found for: ${spotsDropped.join(', ')}`}
                  >
                    · {spotsDropped.length} not placed
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
