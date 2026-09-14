"use client";

import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

type HeroTower3DProps = {
  className?: string;
  phoneScreenSrc?: string;
  duration?: number;
};

type CSSVariables = CSSProperties & {
  [key: `--${string}`]: string | number;
};

type IconKind = "lock" | "check" | "file" | "globe";

function EvidenceIcon({ kind }: { kind: IconKind }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "lock" && (
        <>
          <path d="M20 27v-9a12 12 0 0 1 24 0v9M15 27h34v24L32 60 15 51Z" />
          <circle cx="32" cy="39" r="3" />
          <path d="M32 42v7" />
        </>
      )}

      {kind === "check" && (
        <>
          <circle cx="32" cy="32" r="25" />
          <path d="m19 32 9 9 18-20" />
        </>
      )}

      {kind === "file" && (
        <path d="M15 5h23l12 13v41H15ZM38 5v14h12M23 29h19M23 37h19M23 45h14" />
      )}

      {kind === "globe" && (
        <>
          <circle cx="32" cy="32" r="27" />
          <ellipse cx="32" cy="32" rx="12" ry="27" />
          <path d="M5 32h54M10 17h44M10 47h44M32 5v54" />
        </>
      )}
    </svg>
  );
}

function Block({
  front,
  side,
}: {
  front: ReactNode;
  side: ReactNode;
}) {
  return (
    <div className="ev-block">
      <div className="ev-face ev-front">{front}</div>
      <div className="ev-face ev-back">{side}</div>
      <div className="ev-face ev-left">{side}</div>
      <div className="ev-face ev-right">{side}</div>
      <div className="ev-face ev-top">
        <span />
      </div>
      <div className="ev-face ev-bottom" />
    </div>
  );
}

export function HeroTower3D({
  className,
  phoneScreenSrc,
  duration = 9,
}: HeroTower3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cycle = Number.isFinite(duration) ? Math.max(6, duration) : 9;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const finePointer = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    );

    let visible = true;
    let frame = 0;
    let x = 0;
    let y = 0;
    let targetX = 0;
    let targetY = 0;

    const paint = () => {
      x += (targetX - x) * 0.075;
      y += (targetY - y) * 0.075;

      host.style.setProperty("--look-x", `${x}deg`);
      host.style.setProperty("--look-y", `${y}deg`);

      const moving =
        Math.abs(targetX - x) + Math.abs(targetY - y) > 0.01;

      frame = moving ? requestAnimationFrame(paint) : 0;
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      x = y = targetX = targetY = 0;

      host.style.setProperty("--look-x", "0deg");
      host.style.setProperty("--look-y", "0deg");
    };

    const sync = () => {
      const running =
        visible && !document.hidden && !reducedMotion.matches;

      host.style.setProperty("--play", running ? "running" : "paused");

      if (!running || !finePointer.matches) reset();
    };

    const move = (event: PointerEvent) => {
      if (
        reducedMotion.matches ||
        !finePointer.matches ||
        !visible ||
        document.hidden ||
        event.pointerType === "touch"
      ) {
        return;
      }

      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const clamp = (value: number) => Math.max(0, Math.min(1, value));

      targetX =
        -(clamp((event.clientY - rect.top) / rect.height) - 0.5) * 5;
      targetY =
        (clamp((event.clientX - rect.left) / rect.width) - 0.5) * 12;

      schedule();
    };

    const leave = () => {
      targetX = targetY = 0;

      if (!reducedMotion.matches && visible && !document.hidden) {
        schedule();
      }
    };

    const resize = () => {
      const scale = Math.min(
        host.clientWidth / 560,
        host.clientHeight / 1040,
        1.25,
      );

      host.style.setProperty("--scene-scale", String(Math.max(0.1, scale)));
    };

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(resize)
        : null;

    const intersectionObserver =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            sync();
          })
        : null;

    resizeObserver?.observe(host);
    intersectionObserver?.observe(host);

    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("pointercancel", leave);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", sync);
    reducedMotion.addEventListener("change", sync);
    finePointer.addEventListener("change", sync);

    resize();
    sync();

    return () => {
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      cancelAnimationFrame(frame);

      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("pointercancel", leave);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", sync);
      finePointer.removeEventListener("change", sync);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={`evidence-hero ${className ?? ""}`}
      style={{ "--cycle": `${cycle}s` } as CSSVariables}
      aria-hidden="true"
    >
      <div className="ev-aura" />

      <div className="ev-fit">
        <div className="ev-camera">
          <div className="ev-platform">
            <div className="ev-disc ev-disc-bottom" />
            <div className="ev-disc ev-disc-top" />
            <div className="ev-impact" />
          </div>

          <div className="ev-pedestal">
            <Block
              front={<EvidenceIcon kind="globe" />}
              side={<EvidenceIcon kind="globe" />}
            />
          </div>

          <div className="ev-floor-ring ev-floor-ring-low" />
          <div className="ev-floor-ring ev-floor-ring-high" />

          <div className="ev-unit ev-document">
            <div className="ev-hop">
              <div className="ev-turn">
                <Block
                  front={
                    <span className="ev-document-icon">
                      <EvidenceIcon kind="file" />
                    </span>
                  }
                  side={<EvidenceIcon kind="file" />}
                />
              </div>
            </div>
          </div>

          <div className="ev-unit ev-time">
            <div className="ev-hop">
              <div className="ev-turn">
                <Block
                  front={
                    <>
                      <div className="ev-copy">
                        <strong>↗ TS</strong>
                        <span>2024-05-31 14:28:31 UTC</span>
                      </div>
                      <EvidenceIcon kind="check" />
                    </>
                  }
                  side={<EvidenceIcon kind="check" />}
                />
              </div>
            </div>
          </div>

          <div className="ev-unit ev-hash">
            <div className="ev-hop">
              <div className="ev-turn">
                <Block
                  front={
                    <>
                      <EvidenceIcon kind="lock" />
                      <div className="ev-copy">
                        <strong>SHA-256</strong>
                        <span>7A3F…8B21</span>
                      </div>
                    </>
                  }
                  side={<EvidenceIcon kind="lock" />}
                />
              </div>
            </div>
          </div>

          <div className="ev-phone-lift">
            <div className="ev-phone">
              <div className="ev-phone-back">◈</div>

              <div className="ev-screen">
                {phoneScreenSrc ? (
                  <img
                    src={phoneScreenSrc}
                    alt=""
                    draggable={false}
                    decoding="async"
                  />
                ) : (
                  <div className="ev-screen-art">
                    <div className="ev-orb" />
                    <span className="ev-screen-eyebrow">PROOVRA</span>

                    <div className="ev-screen-title">
                      Proof.
                      <br />
                      Preserved.
                    </div>

                    <span className="ev-screen-status">
                      ● &nbsp; INTEGRITY RECORDED
                    </span>
                  </div>
                )}

                <div className="ev-notch" />
                <div className="ev-screen-glass" />
              </div>
            </div>

            <div className="ev-phone-ring" />
          </div>
        </div>
      </div>

      <style>{styles}</style>
    </div>
  );
}

const styles = `
  .evidence-hero {
    --cycle: 9s;
    --play: running;
    --scene-scale: .6;
    --look-x: 0deg;
    --look-y: 0deg;
    position: relative;
    width: 100%;
    height: 640px;
    isolation: isolate;
    overflow: hidden;
    overflow: clip;
  }

  .evidence-hero *,
  .evidence-hero *::before,
  .evidence-hero *::after {
    box-sizing: border-box;
  }

  .evidence-hero .ev-aura {
    position: absolute;
    inset: 4% -15% -12%;
    pointer-events: none;
    background:
      radial-gradient(ellipse at 48% 78%, #9764ff30, transparent 52%),
      radial-gradient(ellipse at 57% 45%, #2adeff10, transparent 48%);
  }

  .evidence-hero .ev-fit {
    position: absolute;
    width: 560px;
    height: 1040px;
    left: 50%;
    top: 50%;
    margin: -520px 0 0 -280px;
    transform: scale(var(--scene-scale));
    perspective: 1800px;
  }

  .evidence-hero .ev-camera {
    position: absolute;
    inset: 160px 0 0;
    transform:
      rotateX(calc(-12deg + var(--look-x)))
      rotateY(calc(-23deg + var(--look-y)));
    transform-style: preserve-3d;
  }

  .evidence-hero .ev-unit {
    position: absolute;
    left: 140px;
    width: 280px;
    height: 108px;
    transform-style: preserve-3d;
  }

  .evidence-hero .ev-document {
    top: 505px;
    --jump: -45px;
    --direction: 1;
  }

  .evidence-hero .ev-time {
    top: 380px;
    --jump: -88px;
    --direction: -1;
  }

  .evidence-hero .ev-hash {
    top: 255px;
    --jump: -132px;
    --direction: 1;
  }

  .evidence-hero .ev-hop,
  .evidence-hero .ev-turn {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
  }

  .evidence-hero .ev-hop {
    animation: ev-hop-v3 var(--cycle) infinite;
  }

  .evidence-hero .ev-turn {
    animation: ev-turn-v3 var(--cycle) infinite;
  }

  .evidence-hero .ev-block {
    --w: 280px;
    --h: 108px;
    --d: 160px;
    position: relative;
    width: var(--w);
    height: var(--h);
    transform-style: preserve-3d;
  }

  .evidence-hero .ev-face {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 19px;
    border: 1px solid #5753b5;
    border-radius: 8px;
    backface-visibility: hidden;
    color: #ecf4ff;
    background: linear-gradient(145deg, #141451, #050521 65%, #0d1045);
    box-shadow:
      inset 0 2px 2px #a8c0ff4d,
      inset 0 -3px 10px #040412;
  }

  .evidence-hero .ev-front,
  .evidence-hero .ev-back {
    width: var(--w);
    height: var(--h);
  }

  .evidence-hero .ev-front {
    transform: translateZ(calc(var(--d) / 2));
  }

  .evidence-hero .ev-back {
    transform: rotateY(180deg) translateZ(calc(var(--d) / 2));
  }

  .evidence-hero .ev-left,
  .evidence-hero .ev-right {
    width: var(--d);
    height: var(--h);
    left: calc((var(--w) - var(--d)) / 2);
    background: linear-gradient(135deg, #202975, #070b2d 70%);
  }

  .evidence-hero .ev-left {
    transform: rotateY(-90deg) translateZ(calc(var(--w) / 2));
  }

  .evidence-hero .ev-right {
    transform: rotateY(90deg) translateZ(calc(var(--w) / 2));
  }

  .evidence-hero .ev-top,
  .evidence-hero .ev-bottom {
    width: var(--w);
    height: var(--d);
    top: calc((var(--h) - var(--d)) / 2);
  }

  .evidence-hero .ev-top {
    transform: rotateX(90deg) translateZ(calc(var(--h) / 2));
    background: linear-gradient(130deg, #444087, #121541 52%, #2076af);
    border-color: #9299ef;
  }

  .evidence-hero .ev-bottom {
    transform: rotateX(-90deg) translateZ(calc(var(--h) / 2));
    box-shadow: inset 0 0 24px #08ceff60, 0 0 14px #00d9ff50;
  }

  .evidence-hero .ev-top span {
    width: 78%;
    height: 76%;
    border-radius: 50%;
    border: 2px solid #32e9ff;
    box-shadow: 0 0 10px #16dfff, inset 0 0 15px #0ddaff70;
  }

  .evidence-hero .ev-face svg {
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    color: #34edff;
  }

  .evidence-hero .ev-hash .ev-front svg {
    color: #eaf2ff;
  }

  .evidence-hero .ev-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }

  .evidence-hero .ev-copy strong {
    font-weight: 500;
    font-size: 23px;
    letter-spacing: -.8px;
  }

  .evidence-hero .ev-copy span {
    font: 13px ui-monospace, SFMono-Regular, monospace;
    letter-spacing: -.5px;
  }

  .evidence-hero .ev-time .ev-front {
    gap: 12px;
  }

  .evidence-hero .ev-time .ev-front svg {
    width: 32px;
  }

  .evidence-hero .ev-document-icon {
    display: grid;
    place-items: center;
    width: 72px;
    height: 87px;
    border-radius: 9px;
    background: linear-gradient(140deg, #e1faff, #6cdcff 46%, #725aff);
    box-shadow: 0 0 18px #3488ff60, inset 0 0 0 2px #d0f5ff;
    transform: rotate(-4deg);
  }

  .evidence-hero .ev-document-icon svg {
    color: #243dd4;
    height: 65px;
    width: 53px;
  }

  .evidence-hero .ev-pedestal {
    position: absolute;
    left: 150px;
    top: 650px;
    transform-style: preserve-3d;
  }

  .evidence-hero .ev-pedestal .ev-block {
    --w: 260px;
    --h: 93px;
    --d: 170px;
  }

  .evidence-hero .ev-pedestal .ev-face {
    background: linear-gradient(145deg, #064d76, #071637);
    border-color: #39caff85;
  }

  .evidence-hero .ev-pedestal svg {
    width: 72px;
    height: 72px;
  }

  .evidence-hero .ev-platform {
    position: absolute;
    left: 55px;
    top: 770px;
    width: 450px;
    height: 0;
    transform-style: preserve-3d;
  }

  .evidence-hero .ev-disc {
    position: absolute;
    width: 450px;
    height: 340px;
    top: -170px;
    border-radius: 50%;
    transform: rotateX(90deg);
  }

  .evidence-hero .ev-disc-bottom {
    margin-top: 14px;
    background: linear-gradient(120deg, #372c74, #0a1538);
    border: 3px solid #4b6bd4;
    box-shadow: 0 12px 24px #18113c55;
  }

  .evidence-hero .ev-disc-top {
    background: radial-gradient(
      ellipse,
      #ffbf5666,
      #a557ff66 40%,
      #193668 70%
    );
    border: 2px solid #aa93ff;
    box-shadow: inset 0 0 24px #4c8aff, 0 0 15px #9672ff55;
  }

  .evidence-hero .ev-floor-ring {
    position: absolute;
    left: 110px;
    width: 340px;
    height: 220px;
    border: 3px solid #bb8bff;
    border-radius: 50%;
    transform: rotateX(90deg);
    box-shadow: 0 0 12px #a342ff, inset 0 0 13px #7541ff;
  }

  .evidence-hero .ev-floor-ring-low {
    top: 635px;
    border-color: #ffd38b;
    box-shadow: 0 0 12px #ff6a1f, inset 0 0 12px #ff581d;
  }

  .evidence-hero .ev-floor-ring-high {
    top: 525px;
  }

  .evidence-hero .ev-impact {
    position: absolute;
    width: 380px;
    height: 280px;
    left: 35px;
    top: -140px;
    border: 2px solid #91eeff;
    border-radius: 50%;
    transform: rotateX(90deg);
    opacity: 0;
    animation: ev-impact-v3 var(--cycle) infinite;
  }

  .evidence-hero .ev-phone-lift {
    position: absolute;
    left: 207px;
    top: 38px;
    width: 146px;
    height: 205px;
    transform-style: preserve-3d;
    animation: ev-phone-v3 var(--cycle) infinite;
  }

  .evidence-hero .ev-phone {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    transform: rotateY(5deg);
  }

  .evidence-hero .ev-screen,
  .evidence-hero .ev-phone-back {
    position: absolute;
    inset: 0;
    border-radius: 23px;
    border: 5px solid #070a16;
    outline: 2px solid #7992b6;
    overflow: hidden;
    backface-visibility: hidden;
    background: #080e22;
  }

  .evidence-hero .ev-screen {
    transform: translateZ(6px);
  }

  .evidence-hero .ev-phone-back {
    transform: rotateY(180deg) translateZ(6px);
    display: grid;
    place-items: center;
    color: #a2b6e3;
    background: linear-gradient(135deg, #52617f, #111c31);
    font-size: 36px;
  }

  .evidence-hero .ev-screen img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .evidence-hero .ev-notch {
    position: absolute;
    width: 60px;
    height: 13px;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    background: #050811;
    border-radius: 0 0 10px 10px;
  }

  .evidence-hero .ev-screen-glass {
    position: absolute;
    inset: 0;
    background: linear-gradient(120deg, #ffffff22, transparent 42%, #ffffff08);
    pointer-events: none;
  }

  .evidence-hero .ev-screen-art {
    position: absolute;
    inset: 0;
    padding: 29px 12px 12px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: radial-gradient(
      ellipse at 90% 20%,
      #24688b,
      #141a44 48%,
      #050a1d
    );
    color: #eff9ff;
  }

  .evidence-hero .ev-screen-eyebrow {
    font-size: 8px;
    letter-spacing: 2px;
    position: relative;
  }

  .evidence-hero .ev-screen-title {
    font-size: 25px;
    line-height: 1.05;
    letter-spacing: -1px;
    margin-top: 33px;
    position: relative;
  }

  .evidence-hero .ev-screen-status {
    position: absolute;
    bottom: 15px;
    font-size: 6px;
    letter-spacing: .6px;
    color: #6bf5ee;
  }

  .evidence-hero .ev-orb {
    position: absolute;
    width: 110px;
    height: 110px;
    border-radius: 50%;
    border: 1px solid #61efff;
    box-shadow: inset 0 0 25px #448cff, 0 0 28px #385dff66;
    right: -35px;
    top: 15px;
  }

  .evidence-hero .ev-phone-ring {
    position: absolute;
    width: 200px;
    height: 115px;
    left: -27px;
    bottom: -65px;
    border-radius: 50%;
    border: 3px solid #ffbc63;
    transform: rotateX(90deg);
    box-shadow: 0 0 10px #ff580e, inset 0 0 10px #ff7217;
  }

  /* Lift first, rotate while separated, then land bottom to top. */

  @keyframes ev-hop-v3 {
    0%, 12% {
      transform: translateY(0);
      animation-timing-function: ease-in-out;
    }
    18% {
      transform: translateY(5px);
      animation-timing-function: cubic-bezier(.16, 1, .3, 1);
    }
    34%, 57% {
      transform: translateY(var(--jump));
      animation-timing-function: cubic-bezier(.55, 0, .85, .45);
    }
    72% {
      transform: translateY(3px);
      animation-timing-function: ease-out;
    }
    77% {
      transform: translateY(-5px);
      animation-timing-function: ease-in-out;
    }
    83%, 100% {
      transform: translateY(0);
    }
  }

  @keyframes ev-turn-v3 {
    0%, 32% {
      transform: rotateY(0deg);
      animation-timing-function: cubic-bezier(.65, 0, .25, 1);
    }
    58%, 100% {
      transform: rotateY(calc(360deg * var(--direction)));
    }
  }

  .evidence-hero .ev-time .ev-hop {
    animation-name: ev-hop-mid-v3;
  }

  .evidence-hero .ev-hash .ev-hop {
    animation-name: ev-hop-top-v3;
  }

  @keyframes ev-hop-mid-v3 {
    0%, 12% {
      transform: translateY(0);
      animation-timing-function: ease-in-out;
    }
    18% {
      transform: translateY(5px);
      animation-timing-function: cubic-bezier(.16, 1, .3, 1);
    }
    34%, 57% {
      transform: translateY(var(--jump));
      animation-timing-function: cubic-bezier(.55, 0, .85, .45);
    }
    75% {
      transform: translateY(3px);
      animation-timing-function: ease-out;
    }
    80% {
      transform: translateY(-5px);
      animation-timing-function: ease-in-out;
    }
    86%, 100% {
      transform: translateY(0);
    }
  }

  @keyframes ev-hop-top-v3 {
    0%, 12% {
      transform: translateY(0);
      animation-timing-function: ease-in-out;
    }
    18% {
      transform: translateY(5px);
      animation-timing-function: cubic-bezier(.16, 1, .3, 1);
    }
    34%, 57% {
      transform: translateY(var(--jump));
      animation-timing-function: cubic-bezier(.55, 0, .85, .45);
    }
    78% {
      transform: translateY(3px);
      animation-timing-function: ease-out;
    }
    83% {
      transform: translateY(-5px);
      animation-timing-function: ease-in-out;
    }
    89%, 100% {
      transform: translateY(0);
    }
  }

  @keyframes ev-phone-v3 {
    0%, 12% {
      transform: translateY(0);
      animation-timing-function: ease-in-out;
    }
    18% {
      transform: translateY(5px);
      animation-timing-function: cubic-bezier(.16, 1, .3, 1);
    }
    34%, 57% {
      transform: translateY(-155px) rotateY(-9deg);
      animation-timing-function: cubic-bezier(.55, 0, .85, .45);
    }
    78% {
      transform: translateY(3px);
      animation-timing-function: ease-out;
    }
    83% {
      transform: translateY(-5px);
      animation-timing-function: ease-in-out;
    }
    89%, 100% {
      transform: translateY(0);
    }
  }

  @keyframes ev-impact-v3 {
    0%, 71% {
      opacity: 0;
      transform: rotateX(90deg) scale(.8);
    }
    73% {
      opacity: .65;
      transform: rotateX(90deg) scale(.9);
      animation-timing-function: ease-out;
    }
    89%, 100% {
      opacity: 0;
      transform: rotateX(90deg) scale(1.3);
    }
  }

  .evidence-hero .ev-hop,
  .evidence-hero .ev-turn,
  .evidence-hero .ev-phone-lift,
  .evidence-hero .ev-impact {
    animation-play-state: var(--play);
  }

  @media (prefers-reduced-motion: reduce) {
    .evidence-hero .ev-hop,
    .evidence-hero .ev-turn,
    .evidence-hero .ev-phone-lift,
    .evidence-hero .ev-impact {
      animation: none;
    }

    .evidence-hero .ev-camera {
      transform: rotateX(-12deg) rotateY(-23deg);
    }
  }
`;

export default HeroTower3D;