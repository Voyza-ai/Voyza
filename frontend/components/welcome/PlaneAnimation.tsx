'use client';

/**
 * Welcome-screen flight intro, v2 — "the trip drawn across the sky".
 *
 * A jet flies a banking S-curve and DRAWS A DASHED ROUTE behind it — the
 * same dashed-route language as the flowchart connectors and the Map tab —
 * while destination pins pulse into existence along the flight path. After
 * the flyby the whole scene doesn't vanish: it settles into a faint ambient
 * route-map layer behind the logo, so the intro literally becomes the page
 * background.
 *
 * Implementation notes:
 *   - One bezier S-path drives everything: <animateMotion rotate="auto">
 *     flies (and banks) the plane along the tangent, and the SAME path is
 *     revealed through a stroke-dashoffset MASK — so the dashed route's
 *     leading edge always trails the plane exactly, no keyframe drift.
 *   - pathLength="1" normalizes both animations to the same 0–1 clock.
 *   - Pure SVG/CSS (GPU-composited); no JS timers, SSR-safe.
 *   - prefers-reduced-motion: skips the flight, shows the settled route.
 */
export default function PlaneAnimation() {
  // Banking S-curve: swoop up from lower-left, glide through the middle,
  // climb out top-right. The S command keeps the join tangent-smooth.
  const FLIGHT_PATH = 'M -120 620 C 160 300 420 260 620 380 S 1040 560 1340 200';
  const DURATION = '2.4s';

  // Decorative "destinations" pinned just under the flight path, popping in
  // as the plane passes overhead. Colors echo the city-card palette.
  const PINS = [
    { x: 205, y: 442, color: '#FF9A7B', delay: 0.7 },
    { x: 620, y: 418, color: '#7BB8FF', delay: 1.3 },
    { x: 985, y: 520, color: '#7BE8B8', delay: 1.85 },
    { x: 1322, y: 242, color: '#C9A6FF', delay: 2.35 },
  ];

  return (
    <div
      className="fixed inset-0 overflow-hidden pointer-events-none z-[6]"
      aria-hidden
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
        className="voyza-flight-scene"
      >
        <defs>
          <path id="voyza-flight-path" d={FLIGHT_PATH} fill="none" pathLength="1" />

          <linearGradient id="voyza-route-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(79,142,247,0.35)" />
            <stop offset="55%" stopColor="rgba(124,150,255,0.75)" />
            <stop offset="100%" stopColor="rgba(190,215,255,0.95)" />
          </linearGradient>

          <filter id="voyza-plane-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Progressive reveal: a fat white stroke sweeps along the path
              inside a mask; whatever it has covered shows the dashed route. */}
          <mask id="voyza-route-reveal">
            <path
              className="voyza-route-mask"
              d={FLIGHT_PATH}
              pathLength="1"
              stroke="#fff"
              strokeWidth="26"
              strokeLinecap="round"
              fill="none"
            />
          </mask>
        </defs>

        <style>{`
          @keyframes voyzaRouteDraw {
            0%   { stroke-dashoffset: 1; }
            10%  { stroke-dashoffset: 1; }
            100% { stroke-dashoffset: 0.10; }
          }
          .voyza-route-mask {
            stroke-dasharray: 1;
            stroke-dashoffset: 1;
            animation: voyzaRouteDraw 2.4s cubic-bezier(0.42, 0, 0.58, 1) forwards;
          }

          /* The whole scene settles into a faint ambient layer once the
             flight completes — the intro becomes the page background. */
          @keyframes voyzaSceneSettle {
            0%   { opacity: 1; }
            100% { opacity: 0.22; }
          }
          .voyza-flight-scene {
            animation: voyzaSceneSettle 1.4s ease-out 2.7s forwards;
          }

          @keyframes voyzaPlaneFade {
            to { opacity: 0; }
          }
          .voyza-plane {
            animation: voyzaPlaneFade 0.45s ease-out 2.3s forwards;
          }

          /* Destination pins: pop + one expanding ring, then a slow idle pulse */
          @keyframes voyzaPinPop {
            0%   { opacity: 0; transform: scale(0); }
            60%  { opacity: 1; transform: scale(1.35); }
            100% { opacity: 1; transform: scale(1); }
          }
          @keyframes voyzaPinRing {
            0%   { opacity: 0.9; transform: scale(0.4); }
            100% { opacity: 0;   transform: scale(2.6); }
          }
          @keyframes voyzaPinIdle {
            0%, 100% { opacity: 0.85; }
            50%      { opacity: 0.45; }
          }
          .voyza-pin, .voyza-pin-ring {
            transform-box: fill-box;
            transform-origin: center;
            opacity: 0;
          }
          .voyza-pin {
            animation:
              voyzaPinPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
              voyzaPinIdle 3.4s ease-in-out 3.6s infinite;
          }
          .voyza-pin-ring {
            animation: voyzaPinRing 1.1s ease-out forwards;
          }

          @media (prefers-reduced-motion: reduce) {
            .voyza-route-mask { animation: none; stroke-dashoffset: 0.10; }
            .voyza-flight-scene { animation: none; opacity: 0.22; }
            .voyza-plane { animation: none; opacity: 0; }
            .voyza-pin { animation: none; opacity: 0.85; }
            .voyza-pin-ring { animation: none; opacity: 0; }
          }
        `}</style>

        {/* Soft glow under the route */}
        <g mask="url(#voyza-route-reveal)">
          <path
            d={FLIGHT_PATH}
            pathLength="1"
            stroke="rgba(79,142,247,0.30)"
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
            style={{ filter: 'blur(4px)' }}
          />
          {/* The dashed route itself — same language as connectors + Map */}
          <path
            d={FLIGHT_PATH}
            pathLength="1"
            stroke="url(#voyza-route-gradient)"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeDasharray="0.011 0.013"
            fill="none"
            style={{ filter: 'drop-shadow(0 0 5px rgba(79,142,247,0.55))' }}
          />
        </g>

        {/* Destination pins along the route */}
        {PINS.map((pin, i) => (
          <g key={i}>
            <circle
              className="voyza-pin-ring"
              cx={pin.x}
              cy={pin.y}
              r="9"
              fill="none"
              stroke={pin.color}
              strokeWidth="1.6"
              style={{ animationDelay: `${pin.delay + 0.12}s` }}
            />
            <circle
              className="voyza-pin"
              cx={pin.x}
              cy={pin.y}
              r="4.5"
              fill={pin.color}
              stroke="rgba(255,255,255,0.85)"
              strokeWidth="1.4"
              style={{
                animationDelay: `${pin.delay}s, 3.6s`,
                filter: `drop-shadow(0 0 6px ${pin.color})`,
              }}
            />
          </g>
        ))}

        {/* Plane — flies the path, banking with the tangent */}
        <g className="voyza-plane" filter="url(#voyza-plane-glow)">
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
            {/* Main delta wing */}
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
            {/* Far-side wing hint */}
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
