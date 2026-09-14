"use client";

/**
 * HeroTower3D
 * -----------
 * The marketing hero "evidence tower".
 *
 * We use the original pre-rendered studio artwork (a high-quality PNG) so the
 * hero keeps the exact look, colours, lighting and reflections of the approved
 * render — something a hand-built real-time 3D scene cannot match.
 *
 * Motion: a continuous, premium 3D turntable *sway* rather than a full flat
 * 360° spin. A flat image cannot survive a full spin — at 90° it collapses to a
 * paper-thin edge. Instead we oscillate the Y rotation within a safe range
 * (never reaching the thin edge), add a gentle vertical float and a slight
 * counter-tilt, so it reads as a solid 3D object gently turning under studio
 * light. Honours `prefers-reduced-motion`.
 */

const HERO_TOWER = "/assets/hero/proovra-hero-tower-trimmed.png";

export function HeroTower3D({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      <div className="proovra-tower3d-stage">
        <div className="proovra-tower3d-float">
          <div className="proovra-tower3d-spinner">
            <img
              src={HERO_TOWER}
              alt=""
              aria-hidden="true"
              className="proovra-tower3d-img"
            />
          </div>
        </div>
      </div>

      <style>{`
        .proovra-tower3d-stage {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          perspective: 1200px;
          perspective-origin: 50% 42%;
        }

        /* Gentle vertical float — adds life + a sense of hovering under light. */
        .proovra-tower3d-float {
          width: 100%;
          height: 100%;
          transform-style: preserve-3d;
          animation: proovra-tower3d-float 6s ease-in-out infinite;
          will-change: transform;
        }

        /* Continuous 3D turntable sway that never reaches the thin edge. */
        .proovra-tower3d-spinner {
          width: 100%;
          height: 100%;
          transform-style: preserve-3d;
          animation: proovra-tower3d-sway 9s ease-in-out infinite;
          will-change: transform;
        }

        .proovra-tower3d-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          filter: drop-shadow(0 24px 34px rgba(23, 16, 68, 0.28));
        }

        /* -34deg → +34deg keeps both the left and right faces of the tower
           visible with real parallax, but stays well clear of the 90° edge. */
        @keyframes proovra-tower3d-sway {
          0%   { transform: rotateY(-34deg); }
          50%  { transform: rotateY(34deg); }
          100% { transform: rotateY(-34deg); }
        }

        @keyframes proovra-tower3d-float {
          0%   { transform: translateY(0) rotateX(0deg); }
          50%  { transform: translateY(-2.2%) rotateX(1.4deg); }
          100% { transform: translateY(0) rotateX(0deg); }
        }

        @media (prefers-reduced-motion: reduce) {
          .proovra-tower3d-float,
          .proovra-tower3d-spinner { animation: none; }
        }
      `}</style>
    </div>
  );
}

export default HeroTower3D;
