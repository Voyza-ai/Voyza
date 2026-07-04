'use client';

import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Trip } from '@/lib/types';
import { geocodeCities, GeoPoint } from '@/lib/geocode';
import { getCityColor, HOME_COLOR } from '@/lib/cityColors';

/**
 * Map tab — the trip drawn on the Earth.
 *
 * A numbered, card-colored pin per destination (plus a distinct Home pin),
 * connected by a dashed route in visit order (back to home on round-trips).
 * Reads the same trip object as the flowchart, so canvas / Voyza-AI edits
 * re-render pins and route automatically. Coordinates come from live
 * geocoding (lib/geocode) — cities the geocoder can't resolve are listed in
 * a corner note rather than pinned somewhere wrong.
 *
 * Rendered client-side only (Leaflet needs `window`) — the results page
 * imports this with next/dynamic({ ssr: false }).
 */

type MapViewProps = {
  trip: Trip;
};

type PinPoint = {
  name: string;
  point: GeoPoint;
  kind: 'home' | 'city';
  cityIndex: number; // -1 for home
};

/** Circular numbered marker matching the flowchart card palette. */
function pinIcon(label: string, bg: string): L.DivIcon {
  return L.divIcon({
    className: '', // no default leaflet styles
    html: `<div style="
      width:30px;height:30px;border-radius:9999px;
      background:${bg};color:#fff;border:2.5px solid #fff;
      display:flex;align-items:center;justify-content:center;
      font:600 12px/1 system-ui,sans-serif;
      box-shadow:0 1px 6px rgba(0,0,0,0.35);
    ">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -16],
  });
}

/** Fits the viewport to the trip whenever the pin set changes. */
function FitBounds({ pins }: { pins: PinPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (pins.length === 0) return;
    if (pins.length === 1) {
      map.setView([pins[0].point.lat, pins[0].point.lon], 6);
      return;
    }
    const bounds = L.latLngBounds(pins.map((p) => [p.point.lat, p.point.lon] as [number, number]));
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 7 });
  }, [map, pins]);
  return null;
}

const formatDate = (iso: string | undefined) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

export default function MapView({ trip }: MapViewProps) {
  const [pins, setPins] = useState<PinPoint[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Names in visit order; home first when the trip has an origin anchor.
  const names = useMemo(() => {
    const list: { name: string; kind: 'home' | 'city'; cityIndex: number }[] = [];
    if (trip.origin?.city) list.push({ name: trip.origin.city, kind: 'home', cityIndex: -1 });
    trip.cities.forEach((c, i) => list.push({ name: c.name, kind: 'city', cityIndex: i }));
    return list;
  }, [trip.origin?.city, trip.cities]);

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

  // Route in visit order; close the loop home on round-trips.
  const route = useMemo(() => {
    const path = pins.map((p) => [p.point.lat, p.point.lon] as [number, number]);
    const home = pins.find((p) => p.kind === 'home');
    if (home && trip.returnToHome !== false && path.length > 1) {
      path.push([home.point.lat, home.point.lon]);
    }
    return path;
  }, [pins, trip.returnToHome]);

  return (
    <div className="relative h-full min-h-0 rounded-2xl overflow-hidden border border-black/10">
      <MapContainer
        center={[30, 10]}
        zoom={2}
        minZoom={2}
        className="h-full w-full"
        scrollWheelZoom
        worldCopyJump
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {route.length > 1 && (
          <Polyline
            positions={route}
            pathOptions={{ color: '#2e6bc4', weight: 2.5, dashArray: '6 8', opacity: 0.8 }}
          />
        )}

        {pins.map((pin) => {
          const isHome = pin.kind === 'home';
          const color = isHome ? HOME_COLOR.text : getCityColor(pin.cityIndex).text;
          const label = isHome ? 'H' : String(pin.cityIndex + 1);
          const city = isHome ? null : trip.cities[pin.cityIndex];
          const nights = city
            ? Math.max(
                1,
                Math.round(
                  (new Date(city.dates.departure).getTime() - new Date(city.dates.arrival).getTime()) /
                    86_400_000,
                ),
              )
            : 0;
          return (
            <Marker
              key={`${pin.kind}-${pin.name}`}
              position={[pin.point.lat, pin.point.lon]}
              icon={pinIcon(label, color)}
            >
              <Popup>
                <div style={{ font: '13px/1.45 system-ui,sans-serif' }}>
                  <strong>{isHome ? `${pin.name} (Home)` : pin.name}</strong>
                  {city && (
                    <div style={{ color: '#555', marginTop: 2 }}>
                      {formatDate(city.dates.arrival)} → {formatDate(city.dates.departure)} ·{' '}
                      {nights} {nights === 1 ? 'night' : 'nights'}
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        <FitBounds pins={pins} />
      </MapContainer>

      {/* Status chips — geocoding progress + any unresolved cities. z-index
          above leaflet panes (400). */}
      {loading && (
        <div
          className="absolute top-3 left-3 z-[500] px-3 py-1.5 rounded-full text-[12px] bg-white/95 border border-black/10 shadow-sm text-gray-600"
        >
          Locating your cities…
        </div>
      )}
      {!loading && missing.length > 0 && (
        <div
          className="absolute top-3 left-3 z-[500] px-3 py-1.5 rounded-full text-[12px] bg-white/95 border border-black/10 shadow-sm text-gray-600"
          title={missing.join(', ')}
        >
          Couldn&apos;t locate: {missing.join(', ')}
        </div>
      )}
    </div>
  );
}
