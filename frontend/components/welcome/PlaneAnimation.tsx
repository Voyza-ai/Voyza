'use client';

import { useEffect, useRef } from 'react';

/**
 * Landing flight intro — "ink on paper" edition.
 *
 * A small plane (the app's own flight glyph) draws a dashed ink route
 * low across the dusk sky, popping a pastel destination pin
 * as it passes each stop — the vintage flight-map line, in Voyza's route
 * language (same dashes as the flowchart connectors and the Map tab).
 * After landing, the route stays in the sky as a settled decoration.
 *
 * Driven by a requestAnimationFrame timeline (no SMIL): earlier versions
 * used <animateMotion> and hid the plane under prefers-reduced-motion,
 * which made it permanently invisible on machines with macOS Reduce
 * Motion enabled. One JS clock drives plane, route reveal, and pins.
 */

type PlaneAnimationProps = {
  /** Render the settled state immediately (no flight). */
  ambient?: boolean;
};

// Low arc — sweeps across the bottom third, under the hero + buttons
// (user feedback: keep the dashed line low, not through the content).
const FLIGHT_PATH = 'M -140 690 C 200 500 380 430 640 460 S 1100 590 1360 340';
const DURATION_MS = 3200;
/** Fraction of the path the drawn route lags behind the plane's nose. */
const ROUTE_LAG = 0.085;

// Sky-ink + pastel palette (city-card colors for the pins).
const INK = '#7BA8FF';
const PINS = [
  { x: 255, y: 545, color: '#E2725B', at: 0.22 },
  { x: 640, y: 500, color: '#3D8BFF', at: 0.5 },
  { x: 1010, y: 585, color: '#2FB57C', at: 0.75 },
  { x: 1330, y: 372, color: '#9B7BF5', at: 0.95 },
];

// lucide "plane" glyph (24×24) — the same icon used across the app.
const LUCIDE_PLANE_D =
  'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z';

/** easeInOutCubic — slow lift-off, cruise, gentle level-out. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export default function PlaneAnimation({ ambient = false }: PlaneAnimationProps) {
  const sceneRef = useRef<SVGSVGElement>(null);
  const measureRef = useRef<SVGPathElement>(null);
  const planeRef = useRef<SVGGElement>(null);
  const maskRef = useRef<SVGPathElement>(null);
  const pinRefs = useRef<(SVGGElement | null)[]>([]);

  useEffect(() => {
    const scene = sceneRef.current;
    const measure = measureRef.current;
    const plane = planeRef.current;
    const mask = maskRef.current;
    if (!scene || !measure || !plane || !mask) return;

    const showPin = (i: number) => {
      const el = pinRefs.current[i];
      if (el && !el.classList.contains('voyza-pin-on')) el.classList.add('voyza-pin-on');
    };
    const settle = () => scene.classList.add('voyza-settled');

    if (ambient) {
      mask.style.strokeDashoffset = String(ROUTE_LAG);
      plane.style.opacity = '0';
      PINS.forEach((_, i) => showPin(i));
      settle();
      return;
    }

    const total = measure.getTotalLength();
    let raf = 0;
    const t0 = performance.now();

    const frame = (now: number) => {
      const p = Math.min((now - t0) / DURATION_MS, 1);
      const e = ease(p);

      const d = e * total;
      const pt = measure.getPointAtLength(d);
      const ahead = measure.getPointAtLength(Math.min(d + 2, total));
      const deg = (Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180) / Math.PI;
      plane.setAttribute('transform', `translate(${pt.x} ${pt.y}) rotate(${deg})`);

      mask.style.strokeDashoffset = String(Math.max(1 - e + ROUTE_LAG * e, ROUTE_LAG));

      PINS.forEach((pin, i) => {
        if (e >= pin.at) showPin(i);
      });

      if (p < 1) {
        raf = requestAnimationFrame(frame);
      } else {
        plane.style.opacity = '0';
        window.setTimeout(settle, 350);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [ambient]);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-[1]" aria-hidden>
      <svg
        ref={sceneRef}
        width="100%"
        height="100%"
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
        className="voyza-flight-scene"
      >
        <defs>
          {/* Progressive route reveal — dashoffset driven by the rAF clock */}
          <mask id="voyza-route-reveal">
            <path
              ref={maskRef}
              d={FLIGHT_PATH}
              pathLength="1"
              stroke="#fff"
              strokeWidth="30"
              strokeLinecap="round"
              fill="none"
              style={{ strokeDasharray: 1, strokeDashoffset: 1 }}
            />
          </mask>
        </defs>

        <style>{`
          /* Ink settles (stays readable on paper, just recedes a little) */
          .voyza-flight-scene {
            opacity: 1;
            transition: opacity 1.2s ease-out;
          }
          .voyza-flight-scene.voyza-settled { opacity: 0.32; }

          .voyza-plane-icon { transition: opacity 0.45s ease-out; }

          .voyza-pin-dot, .voyza-pin-ring {
            transform-box: fill-box;
            transform-origin: center;
            opacity: 0;
          }
          @keyframes voyzaPinPop {
            0%   { opacity: 0; transform: scale(0); }
            60%  { opacity: 1; transform: scale(1.3); }
            100% { opacity: 1; transform: scale(1); }
          }
          @keyframes voyzaPinRing {
            0%   { opacity: 0.7; transform: scale(0.4); }
            100% { opacity: 0;   transform: scale(2.4); }
          }
          .voyza-pin-on .voyza-pin-dot {
            animation: voyzaPinPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
          }
          .voyza-pin-on .voyza-pin-ring {
            animation: voyzaPinRing 0.9s ease-out forwards;
          }
        `}</style>

        {/* Hidden measuring copy of the path (rAF samples it) */}
        <path ref={measureRef} d={FLIGHT_PATH} fill="none" stroke="none" />

        {/* The dashed ink route — crisp, no glow */}
        <g mask="url(#voyza-route-reveal)">
          <path
            d={FLIGHT_PATH}
            pathLength="1"
            stroke={INK}
            strokeOpacity="0.6"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeDasharray="0.011 0.013"
            fill="none"
          />
        </g>

        {/* Destination pins — pastel dots with an ink-outline pop ring */}
        {PINS.map((pin, i) => (
          <g
            key={i}
            ref={(el) => {
              pinRefs.current[i] = el;
            }}
          >
            <circle
              className="voyza-pin-ring"
              cx={pin.x}
              cy={pin.y}
              r="9"
              fill="none"
              stroke={pin.color}
              strokeWidth="1.5"
            />
            <circle
              className="voyza-pin-dot"
              cx={pin.x}
              cy={pin.y}
              r="4.5"
              fill={pin.color}
              stroke="#ffffff"
              strokeWidth="1.6"
            />
          </g>
        ))}

        {/* The plane — ink-stamped flight glyph on the rAF clock. The glyph
            natively points ~45° up-right; rotate(45) re-noses it to +x. */}
        <g ref={planeRef} className="voyza-plane-icon">
          <g transform="rotate(45) scale(2.1) translate(-12 -12)">
            <path
              d={LUCIDE_PLANE_D}
              fill="#EAF2FF"
              stroke="#4f8ef7"
              strokeWidth="0.7"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
