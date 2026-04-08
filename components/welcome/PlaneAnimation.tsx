'use client';

/**
 * Welcome-screen plane animation.
 *
 * Uses SVG <animateMotion> + <mpath> to fly a plane silhouette along a single
 * smooth quadratic bezier arc. The vapor trail is the SAME path, drawn
 * progressively via stroke-dasharray — so the trail is guaranteed to match
 * the plane's flight path perfectly at every frame (no keyframe drift).
 *
 * Benefits over the old keyframe approach:
 *   - One bezier curve instead of a 21-point polyline → no "elbowing" wobble
 *   - Auto-rotation along the path tangent (rotate="auto") → no manual angles
 *   - GPU-composited (SVG animations don't trigger layout/paint on siblings)
 *   - viewBox-relative → scales to any screen without JS
 *   - Trail is literally the flight path → never diverges from the plane
 */
export default function PlaneAnimation() {
  // A single quadratic bezier arc:
  //   start:   (-150, 620)   — off-screen lower-left
  //   control: ( 600, -180)  — above the top-center (pulls the curve into a parabola)
  //   end:     (1350, 620)   — off-screen lower-right
  const FLIGHT_PATH = 'M -150 620 Q 600 -180 1350 620';
  const DURATION = '2.2s';

  return (
    <div
      className="fixed inset-0 overflow-hidden pointer-events-none z-20"
      aria-hidden
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* The motion path the plane follows. pathLength="1" normalizes
              stroke-dasharray/offset to 0–1 so the trail progress matches
              animateMotion progress exactly (which is also 0–1). */}
          <path id="voyza-flight-path" d={FLIGHT_PATH} fill="none" pathLength="1" />

          {/* Soft gradient for the vapor trail — bright near the plane, fading back */}
          <linearGradient id="voyza-trail-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(79,142,247,0)" />
            <stop offset="40%" stopColor="rgba(79,142,247,0.25)" />
            <stop offset="85%" stopColor="rgba(135,180,255,0.9)" />
            <stop offset="100%" stopColor="rgba(200,220,255,1)" />
          </linearGradient>

          {/* Soft glow for the plane */}
          <filter id="voyza-plane-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <style>{`
          @keyframes voyzaDrawTrail {
            /* Hold the trail invisible and un-drawn until the plane has
               already cleared the left edge, then draw it so its leading
               edge permanently lags the plane by ~12% of the path length. */
            0%   { stroke-dashoffset: 1;    opacity: 0; }
            12%  { stroke-dashoffset: 1;    opacity: 0; }
            18%  { opacity: 0.9; }
            100% { stroke-dashoffset: 0.12; opacity: 0.9; }
          }
          @keyframes voyzaFadeTrail {
            0%   { opacity: 0.9; }
            100% { opacity: 0; }
          }
          .voyza-trail {
            stroke-dasharray: 1;
            stroke-dashoffset: 1;
            animation:
              voyzaDrawTrail 2.2s cubic-bezier(0.42, 0, 0.58, 1) forwards,
              voyzaFadeTrail 1.2s ease-out 2.0s forwards;
          }
          .voyza-plane-fade {
            animation: voyzaFadeTrail 0.4s ease-out 2.1s forwards;
          }
        `}</style>

        {/* === Vapor trail — the flight path drawn progressively ===
            pathLength="1" normalizes the dash scale to 0–1 so the trail's
            leading edge advances at exactly the same rate as the plane. */}
        <path
          className="voyza-trail"
          d={FLIGHT_PATH}
          pathLength="1"
          stroke="url(#voyza-trail-gradient)"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          style={{
            filter: 'drop-shadow(0 0 6px rgba(79,142,247,0.6))',
          }}
        />

        {/* === Plane silhouette, centered at (0,0), nose pointing +x === */}
        <g className="voyza-plane-fade" filter="url(#voyza-plane-glow)">
          {/* Drive the plane along the flight path with auto-rotation to match the tangent */}
          <animateMotion
            dur={DURATION}
            fill="freeze"
            rotate="auto"
            calcMode="spline"
            keyTimes="0;1"
            keySplines="0.42 0 0.58 1"
          >
            <mpath href="#voyza-flight-path" />
          </animateMotion>

          {/*
            Side-view commercial jet silhouette.
            Center of rotation is (0,0); nose at x ≈ +52; tail at x ≈ -52.
            Built from simple shapes so it reads clearly at any size.
          */}
          <g
            transform="scale(1.5)"
            fill="rgba(230,240,255,0.98)"
            stroke="rgba(79,142,247,0.65)"
            strokeWidth="1.2"
            strokeLinejoin="round"
          >
            {/* Main fuselage */}
            <path
              d="
                M -48 0
                Q -48 -7 -38 -8
                L 30 -8
                Q 46 -8 52 0
                Q 46 8 30 8
                L -38 8
                Q -48 7 -48 0
                Z
              "
            />
            {/* Cockpit window */}
            <path
              d="M 38 -5 Q 48 -4 50 0 Q 48 0 38 0 Z"
              fill="rgba(79,142,247,0.55)"
              stroke="none"
            />
            {/* Vertical tail fin */}
            <path
              d="
                M -48 -6
                L -56 -22
                Q -58 -25 -54 -25
                L -40 -25
                Q -36 -25 -34 -22
                L -30 -8
                Z
              "
              fill="rgba(200,220,255,0.95)"
            />
            {/* Main delta wing (below center, sweeps aft) */}
            <path
              d="
                M 8 6
                L -8 6
                L -28 26
                Q -30 28 -26 28
                L 10 28
                Q 14 28 16 26
                L 18 8
                Z
              "
              fill="rgba(200,220,255,0.9)"
            />
            {/* Far-side wing hint (smaller, above center, for 3/4 feel) */}
            <path
              d="
                M 6 -6
                L -6 -6
                L -18 -16
                Q -20 -17 -17 -17
                L 8 -17
                Q 10 -17 11 -16
                L 12 -7
                Z
              "
              fill="rgba(180,210,255,0.6)"
            />
            {/* Horizontal stabilizer */}
            <path
              d="
                M -42 -1
                L -54 -6
                Q -56 -6 -56 -4
                L -56 4
                Q -56 6 -54 6
                L -42 1
                Z
              "
              fill="rgba(200,220,255,0.9)"
            />
            {/* Cabin window strip */}
            <line
              x1="-30"
              y1="-1"
              x2="28"
              y2="-1"
              stroke="rgba(79,142,247,0.6)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
