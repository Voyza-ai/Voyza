'use client';

import { useEffect, useRef } from 'react';

/**
 * Welcome-screen flight intro, v3.1 — JS-driven.
 *
 * The plane is the SAME lucide plane glyph used across the app (connectors,
 * transport pills), flown along the route by a requestAnimationFrame
 * timeline instead of SMIL. Why: previous versions animated via
 * <animateMotion> and hid the plane under `prefers-reduced-motion` — on
 * machines with macOS Reduce Motion enabled the plane was permanently
 * invisible while everything else ran. The rAF timeline drives the plane
 * transform, the route reveal, and the pin pops from ONE clock, so what
 * you see is always consistent, on every machine.
 *
 * Choreography (3s): eased lift-off → cruise → level-out. The jet draws a
 * dashed route (flowchart/Map language); destination pins pop as it
 * passes; then the whole scene settles into a faint ambient layer behind
 * the logo instead of vanishing.
 */

type PlaneAnimationProps = {
  /** Render the settled ambient state immediately (no flight). */
  ambient?: boolean;
};

// Route arc — kept LOW on the screen (crest ≈ 56% height) so it sweeps
// under the logo/CTA instead of through them.
const FLIGHT_PATH = 'M -140 690 C 200 500 380 430 640 460 S 1100 590 1360 340';
const DURATION_MS = 3200;
/** Fraction of the path the drawn route lags behind the plane's nose. */
const ROUTE_LAG = 0.085;

// Destination pins just under the route, with the timeline fraction at
// which each pops (as the plane passes overhead).
const PINS = [
  { x: 255, y: 545, color: '#E2725B', at: 0.24 },
  { x: 640, y: 500, color: '#3D8BFF', at: 0.5 },
  { x: 1010, y: 585, color: '#2FB57C', at: 0.74 },
  { x: 1330, y: 372, color: '#9B7BF5', at: 0.95 },
];

// lucide "plane" glyph (24×24), same icon the app uses for flights.
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
      // Skip the flight: settled route, pins on, no plane.
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

      // Plane position + heading along the path tangent.
      const d = e * total;
      const pt = measure.getPointAtLength(d);
      const ahead = measure.getPointAtLength(Math.min(d + 2, total));
      const deg = (Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180) / Math.PI;
      plane.setAttribute('transform', `translate(${pt.x} ${pt.y}) rotate(${deg})`);

      // Route reveal lags the nose slightly (mask stroke, pathLength=1).
      mask.style.strokeDashoffset = String(Math.max(1 - e + ROUTE_LAG * e, ROUTE_LAG));

      // Pins pop as the plane passes.
      PINS.forEach((pin, i) => {
        if (e >= pin.at) showPin(i);
      });

      if (p < 1) {
        raf = requestAnimationFrame(frame);
      } else {
        // Flight done: fade the jet, settle the scene to ambient.
        plane.style.opacity = '0';
        window.setTimeout(settle, 350);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [ambient]);

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-[6]" aria-hidden>
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
          <linearGradient id="voyza-route-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(79,142,247,0.30)" />
            <stop offset="60%" stopColor="rgba(124,160,255,0.70)" />
            <stop offset="100%" stopColor="rgba(196,218,255,0.95)" />
          </linearGradient>

          {/* Progressive route reveal — the mask stroke's dashoffset is
              driven each frame by the same clock as the plane. */}
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
          /* Scene settles into a faint ambient layer after the flight */
          .voyza-flight-scene {
            opacity: 1;
            transition: opacity 1.4s ease-out;
          }
          .voyza-flight-scene.voyza-settled { opacity: 0.22; }

          .voyza-plane-icon {
            transition: opacity 0.45s ease-out;
          }

          /* Pins: hidden until the plane passes, then pop + ring */
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
            0%   { opacity: 0.85; transform: scale(0.4); }
            100% { opacity: 0;    transform: scale(2.5); }
          }
          @keyframes voyzaPinIdle {
            0%, 100% { opacity: 0.85; }
            50%      { opacity: 0.5; }
          }
          .voyza-pin-on .voyza-pin-dot {
            animation:
              voyzaPinPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
              voyzaPinIdle 3.6s ease-in-out 1.2s infinite;
          }
          .voyza-pin-on .voyza-pin-ring {
            animation: voyzaPinRing 1s ease-out forwards;
          }
        `}</style>

        {/* Hidden measuring copy of the path (rAF samples it) */}
        <path ref={measureRef} d={FLIGHT_PATH} fill="none" stroke="none" />

        {/* Soft under-glow + the dashed route — both mask-revealed */}
        <g mask="url(#voyza-route-reveal)">
          <path
            d={FLIGHT_PATH}
            pathLength="1"
            stroke="rgba(120,170,255,0.28)"
            strokeWidth="8"
            strokeLinecap="round"
            fill="none"
            style={{ filter: 'blur(5px)' }}
          />
          <path
            d={FLIGHT_PATH}
            pathLength="1"
            stroke="url(#voyza-route-grad)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray="0.010 0.012"
            fill="none"
            style={{ filter: 'drop-shadow(0 0 5px rgba(79,142,247,0.5))' }}
          />
        </g>

        {/* Destination pins */}
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
              stroke="rgba(255,255,255,0.9)"
              strokeWidth="1.4"
              style={{ filter: `drop-shadow(0 0 6px ${pin.color})` }}
            />
          </g>
        ))}

        {/* The plane — the app's own flight glyph (top-down, like a
            flight-tracker marker following the route), flown by the rAF
            clock. The glyph natively points ~45° up-right; the inner
            rotate(45) re-noses it to +x so the tangent heading applies
            cleanly. Rendered crisp: white body, thin blue outline, a small
            grounded shadow — NOT a soft glow (which washed it to a blob). */}
        <g ref={planeRef} className="voyza-plane-icon">
          <g transform="rotate(45) scale(2.6) translate(-12 -12)">
            {/* faint contact glow under the craft, keeps it lifted off the sky */}
            <path
              d={LUCIDE_PLANE_D}
              fill="none"
              stroke="rgba(79,142,247,0.5)"
              strokeWidth="2.4"
              strokeLinejoin="round"
              style={{ filter: 'blur(2px)', opacity: 0.6 }}
            />
            <path
              d={LUCIDE_PLANE_D}
              fill="#f2f7ff"
              stroke="#2e6bc4"
              strokeWidth="0.9"
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ filter: 'drop-shadow(0 1.5px 1.5px rgba(8,12,30,0.55))' }}
            />
            {/* center spine accent — a hint of the fuselage in brand blue */}
            <path
              d="M13 8 L11 16"
              stroke="rgba(79,142,247,0.55)"
              strokeWidth="1.1"
              strokeLinecap="round"
              fill="none"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
