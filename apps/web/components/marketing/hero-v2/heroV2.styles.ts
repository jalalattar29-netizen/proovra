/**
 * Hero V2 styles, delivered as one hoisted <style> element (see HeroV2.tsx).
 *
 * WHY NOT A STYLESHEET FILE. The web app's CSS surfaces are a counted budget
 * (services/api/test/phase-r10-visual-maturity.test.ts, R10 Group 14: at most
 * 30 .css files, one per product surface). The marketing site has no
 * stylesheet of its own: its components style themselves with Tailwind and,
 * where a component needs real CSS (container queries, 3D transforms,
 * descendant rules), an inline <style> — as the homepage hero this replaced
 * did. Hero V2 follows that convention instead of adding a 31st surface.
 *
 * SCOPING. Every class is prefixed "hv2-", so nothing here can match markup
 * outside the hero and nothing outside can match it; that prefix is the whole
 * isolation contract a CSS module used to provide.
 *
 * Comments are stripped once at module load, so they cost nothing on the wire.
 */

const RAW = `/*
 * PROOVRA Hero V2 — approved reference composition.
 *
 * The visual stage is laid out in the reference's own coordinate system: a
 * 1020 × 610 canvas (the right-hand composition of hero-approved-reference).
 * Every position and size inside it is expressed in \`--u\`, one reference
 * pixel, which the stage resolves against its own rendered width through
 * container query units. The stage therefore scales as one rigid drawing and
 * the flow lines (an SVG in the same coordinate system) always land exactly
 * on the cards they connect.
 *
 * Below the stage breakpoint the same card components are reused in a
 * stacked layout; each wrapper sets its own \`--u\` so a card fills it.
 */

.hv2-hero {
  position: relative;
  overflow: hidden;
  background: #f7f8fe;
  color: #0b1433;
  font-family: var(--font-jakarta), Inter, system-ui, sans-serif;
  --navy: #0b1f5e;
  --navy-deep: #081640;
  --blue: #2457e6;
  --blue-bright: #3b82f6;
  --violet: #7c3aed;
  --cyan: #22d3ee;
  --ink: #0b1433;
  --slate: #475569;
  --muted: #64748b;
  --line: rgba(148, 163, 184, 0.28);
  --icon-stroke: 1.75;
}

/* ---------------------------------------------------------------- backdrop */

.hv2-backdrop {
  position: absolute;
  inset: 0 0 auto 0;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}

/*
 * The city asset (1983 × 793) already carries its own bright, clean left
 * side for the copy. It is drawn at its natural aspect ratio and never above
 * its native resolution at the reference width: its height follows the
 * viewport width, with a floor that keeps the skyline behind the whole stage
 * (≈700px at 1672px, a 0.88× downscale; 44vw on narrower desktops so the
 * asset's bright left side is not cropped away behind the copy). Only the bottom edge is faded into
 * the page; no full-surface wash sits over the skyline.
 */
.hv2-city {
  position: absolute;
  top: 0;
  right: 0;
  width: 100%;
  height: max(calc(100vw * 793 / 1983), min(700px, 44vw));
  object-fit: cover;
  object-position: right center;
  -webkit-mask-image: linear-gradient(180deg, #000 78%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 78%, transparent 100%);
}

/* Readability for the copy column only; fades out before the stage begins. */
.hv2-backdropWash {
  position: absolute;
  inset: 0;
  background:
    /* Atmospheric haze under the navigation bar. */
    linear-gradient(180deg, rgba(255, 255, 255, 0.72) 0px, rgba(255, 255, 255, 0.3) 90px, rgba(255, 255, 255, 0) 150px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0.8) 26%, rgba(255, 255, 255, 0.35) 36%, rgba(255, 255, 255, 0) 44%);
}

@media (max-width: 1199px) {
  .hv2-city {
    height: max(calc(100vw * 793 / 1983), 520px);
    opacity: 0.55;
  }
  .hv2-backdropWash {
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0.72) 40%, rgba(247, 248, 254, 0.9) 70%, #f7f8fe 100%);
  }
}

/* ------------------------------------------------------------------ layout */

.hv2-inner {
  position: relative;
  z-index: 1;
  margin: 0 auto;
  max-width: 1672px;
  padding: calc(var(--marketing-header-height, 76px) + 28px) 20px 32px;
}

@media (min-width: 768px) {
  .hv2-inner {
    --marketing-header-height: 88px;
    padding-left: 32px;
    padding-right: 32px;
  }
}

@media (min-width: 1024px) {
  .hv2-inner {
    --marketing-header-height: 96px;
  }
}

.hv2-top {
  display: flex;
  flex-direction: column;
  gap: 40px;
}

@media (min-width: 1200px) {
  .hv2-inner {
    padding: 0 0 28px;
  }
  .hv2-top {
    display: grid;
    grid-template-columns: 37.1% 61%;
    column-gap: 0;
    align-items: start;
    padding-top: var(--marketing-header-height, 96px);
  }
}

/* -------------------------------------------------------------- copy column */

.hv2-copy {
  display: flex;
  flex-direction: column;
  max-width: 640px;
}

@media (min-width: 1200px) {
  .hv2-copy {
    padding-left: 14.5%;
    padding-top: 28px;
    max-width: none;
  }
}

.hv2-eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--blue);
}

.hv2-headline {
  margin: 22px 0 0;
  font-weight: 800;
  color: #070b1a;
}

/* Three short statements, then the gradient positioning line — the same
   two-part headline the production HeroSection used. */
.hv2-headlineLines {
  display: block;
  font-size: clamp(34px, 9vw, 46px);
  line-height: 1.04;
  letter-spacing: -0.035em;
}

.hv2-headlineAccent {
  display: block;
  margin-top: 14px;
  max-width: 560px;
  font-size: clamp(22px, 5.6vw, 28px);
  line-height: 1.16;
  letter-spacing: -0.02em;
  /* Original HeroSection emphasis gradient. */
  background: linear-gradient(90deg, #f97316 0%, #ec4899 50%, #7c3aed 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  /* Keep descenders of the gradient run inside the clip. */
  padding-bottom: 0.06em;
}

@media (min-width: 1200px) {
  .hv2-headline {
    margin-top: 2vw;
  }
  .hv2-headlineLines {
    font-size: clamp(34px, 2.75vw, 50px);
    white-space: nowrap;
  }
  .hv2-headlineAccent {
    margin-top: 0.8vw;
    max-width: 28vw;
    font-size: clamp(20px, 1.72vw, 31px);
  }
  .hv2-eyebrow {
    font-size: clamp(11px, 0.8vw, 13.5px);
  }
}

@media (min-width: 1672px) {
  .hv2-headline {
    margin-top: 34px;
  }
  .hv2-headlineAccent {
    max-width: 470px;
  }
  .hv2-lede {
    max-width: 468px;
  }
}

.hv2-lede {
  margin: 18px 0 0;
  max-width: 560px;
  font-size: 16.5px;
  line-height: 1.6;
  color: var(--slate);
}

@media (min-width: 1200px) {
  .hv2-lede {
    max-width: 28vw;
    font-size: clamp(14px, 0.98vw, 17px);
    margin-top: 1.2vw;
  }
}

.hv2-ctas {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 26px;
}

@media (min-width: 1200px) {
  .hv2-ctas {
    flex-wrap: nowrap;
    margin-top: 1.9vw;
    gap: 0.85vw;
  }
}

.hv2-ctaPrimary,
.hv2-ctaSecondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 52px;
  padding: 0 26px;
  border-radius: 10px;
  font-size: 15.5px;
  font-weight: 600;
  white-space: nowrap;
  transition: background-color 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
}

@media (min-width: 1200px) {
  .hv2-ctaPrimary,
  .hv2-ctaSecondary {
    height: clamp(48px, 3.4vw, 58px);
    padding: 0 clamp(20px, 1.9vw, 32px);
    font-size: clamp(14.5px, 1vw, 17px);
  }
}

.hv2-ctaPrimary:focus-visible,
.hv2-ctaSecondary:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}

.hv2-ctaPrimary {
  background: linear-gradient(180deg, #102a74 0%, var(--navy) 100%);
  color: #fff;
  box-shadow: 0 14px 30px rgba(11, 31, 94, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.hv2-ctaPrimary:hover {
  background: linear-gradient(180deg, #13318a 0%, #0d256e 100%);
}

.hv2-ctaSecondary {
  background: rgba(255, 255, 255, 0.86);
  color: var(--ink);
  border: 1px solid rgba(37, 87, 230, 0.32);
  box-shadow: 0 8px 24px rgba(30, 64, 175, 0.08);
}

.hv2-ctaSecondary:hover {
  border-color: rgba(37, 87, 230, 0.55);
  box-shadow: 0 10px 28px rgba(30, 64, 175, 0.14);
}

.hv2-assurances {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 22px;
  margin: 26px 0 0;
  padding: 0;
  list-style: none;
}

@media (min-width: 1200px) {
  .hv2-assurances {
    flex-wrap: nowrap;
    margin-top: 2.1vw;
    gap: 10px 1.5vw;
  }
}

.hv2-assurance {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  font-weight: 500;
  color: #1e293b;
  white-space: nowrap;
}

@media (min-width: 1200px) {
  .hv2-assurance {
    gap: 0.5vw;
    font-size: clamp(10.5px, 0.7vw, 12px);
  }
}

.hv2-assuranceMark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: linear-gradient(180deg, #5b4ff0 0%, #4338ca 100%);
  color: #fff;
  box-shadow: 0 3px 8px rgba(67, 56, 202, 0.3);
}

/* -------------------------------------------------------------------- stage */

.hv2-stageWrap {
  display: none;
  container-type: inline-size;
  width: 100%;
  max-width: 1020px;
  margin: 0 auto;
}

@media (min-width: 1024px) {
  .hv2-stageWrap {
    display: block;
  }
}

@media (min-width: 1200px) {
  .hv2-stageWrap {
    max-width: none;
    margin: 0;
  }
}

.hv2-stage {
  --u: calc(100cqw / 1020);
  position: relative;
  width: 100%;
  aspect-ratio: 1020 / 610;
}

.hv2-at {
  position: absolute;
}

/* Flow lines ------------------------------------------------------------- */

.hv2-flow {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.hv2-pulses {
  opacity: 0.95;
}

@media (prefers-reduced-motion: reduce) {
  .hv2-pulses {
    display: none;
  }
}

.hv2-node {
  display: flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--u) * 38);
  height: calc(var(--u) * 38);
  margin: calc(var(--u) * -19) 0 0 calc(var(--u) * -19);
  border-radius: calc(var(--u) * 10);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.92), rgba(224, 231, 255, 0.78));
  border: calc(var(--u) * 1) solid rgba(255, 255, 255, 0.95);
  box-shadow:
    0 0 0 calc(var(--u) * 1) rgba(99, 102, 241, 0.18),
    0 calc(var(--u) * 6) calc(var(--u) * 18) rgba(59, 91, 219, 0.28),
    0 0 calc(var(--u) * 16) rgba(96, 165, 250, 0.45);
  color: var(--blue);
}

.hv2-nodeViolet {
  color: var(--violet);
}

.hv2-node svg {
  width: calc(var(--u) * 18);
  height: calc(var(--u) * 18);
}

/* Shared card surfaces --------------------------------------------------- */

.hv2-glassCard {
  background: linear-gradient(165deg, rgba(255, 255, 255, 0.96) 0%, rgba(246, 248, 255, 0.9) 100%);
  border: calc(var(--u) * 1) solid rgba(255, 255, 255, 0.95);
  border-radius: calc(var(--u) * 14);
  box-shadow:
    0 0 0 calc(var(--u) * 1) rgba(148, 163, 255, 0.22),
    0 calc(var(--u) * 10) calc(var(--u) * 28) rgba(30, 41, 99, 0.16);
  backdrop-filter: blur(8px);
}

/* Source cards ----------------------------------------------------------- */

/*
 * Source cards. Box: 198 × 90 stage units — one glass card the photo fills.
 *   format chips — upper-right corner, over the sky/margin of each photo;
 *   source label — slim single-line glass label on the lower-left edge.
 * Both are dark, translucent glass so they read as part of the photograph
 * rather than as panels laid on top of it.
 */
.hv2-source {
  position: relative;
  width: calc(var(--u) * 198);
  height: calc(var(--u) * 90);
  padding: calc(var(--u) * 3);
  border-radius: calc(var(--u) * 12);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.7), rgba(224, 231, 255, 0.45));
  border: calc(var(--u) * 1) solid rgba(255, 255, 255, 0.9);
  box-shadow:
    0 0 0 calc(var(--u) * 1) rgba(129, 140, 248, 0.25),
    0 calc(var(--u) * 12) calc(var(--u) * 26) rgba(15, 23, 72, 0.28),
    0 0 calc(var(--u) * 16) rgba(96, 165, 250, 0.35);
}

.hv2-sourceMedia {
  position: absolute;
  inset: calc(var(--u) * 3);
  overflow: hidden;
  border-radius: calc(var(--u) * 9);
  background: #0b1433;
}

.hv2-sourceMedia img {
  object-fit: cover;
}

/* Specular sweep across the glass over the photo. */
.hv2-sourceMedia::after {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(118deg, rgba(255, 255, 255, 0.24) 0%, rgba(255, 255, 255, 0) 32%),
    linear-gradient(0deg, rgba(8, 15, 40, 0.35) 0%, rgba(8, 15, 40, 0) 34%);
  pointer-events: none;
}

.hv2-sourceFormats {
  position: absolute;
  top: calc(var(--u) * 8);
  right: calc(var(--u) * 8);
  display: flex;
  gap: calc(var(--u) * 3);
}

.hv2-sourceFormats span,
.hv2-sourceLabel {
  background: rgba(8, 15, 40, 0.52);
  border: calc(var(--u) * 1) solid rgba(255, 255, 255, 0.28);
  backdrop-filter: blur(8px) saturate(1.3);
  -webkit-backdrop-filter: blur(8px) saturate(1.3);
  color: #f1f5ff;
}

.hv2-sourceFormats span {
  display: flex;
  align-items: center;
  height: calc(var(--u) * 14);
  padding: 0 calc(var(--u) * 4.5);
  border-radius: calc(var(--u) * 4);
  font-size: max(calc(var(--u) * 7.5), 6.5px);
  font-weight: 700;
  letter-spacing: 0.05em;
}

.hv2-sourceLabel {
  position: absolute;
  left: calc(var(--u) * 8);
  bottom: calc(var(--u) * 8);
  display: inline-flex;
  align-items: center;
  gap: calc(var(--u) * 5);
  height: calc(var(--u) * 20);
  padding: 0 calc(var(--u) * 8) 0 calc(var(--u) * 6);
  border-radius: calc(var(--u) * 6);
  font-size: max(calc(var(--u) * 9.5), 7px);
  font-weight: 600;
  letter-spacing: 0.005em;
  white-space: nowrap;
}

.hv2-sourceLabel svg {
  flex: none;
  width: calc(var(--u) * 12);
  height: calc(var(--u) * 12);
  color: #a5c8ff;
}

/* --------------------------------------------- stage-only 3D orientation */

/*
 * Why these numbers: a rotation only reads as depth when the projected near
 * edge is visibly taller than the far edge. The first pass (24° at an
 * 800-unit eye distance, 9° at 1100, 4° at 1400) was applied correctly but
 * projected to edge ratios of 1.11, 1.04 and ~1.00 — too small to see, so the
 * cards read as flat. The values below target ≈1.22 for both side stacks,
 * measured in the browser.
 *
 * Each card is also scaled down slightly before it turns, as if set back in
 * depth; that keeps every near edge inside its row so neighbours never touch.
 */

/*
 * Sources turn inward toward the evidence record, hinged on their right edge
 * (where the flow lines start), so the left edge swings toward the viewer.
 * Near edge: 90 × 0.94 × 1.235 ≈ 104 units, inside the 108-unit row pitch.
 */
.hv2-stage .hv2-source {
  transform-origin: 100% 50%;
  transform: perspective(calc(var(--u) * 520)) rotateY(30deg) scale(0.94);
}

/*
 * Outputs mirror the sources from the right, hinged on their left edge (where
 * the flow lines arrive): the outer edge swings toward the viewer. Tuned to
 * the same near/far edge ratio as the source stack (≈1.22) while keeping the
 * row gaps the cards had before; QR, report preview, avatars and share field
 * stay legible.
 */
.hv2-stage .hv2-output {
  transform-origin: 0% 50%;
  transform: perspective(calc(var(--u) * 720)) rotateY(-30deg) scale(0.86);
}

/* The evidence record stays upright: its depth comes from the glass frame,
   glow and pedestal, not from a rotation. */

/* Evidence record -------------------------------------------------------- */

.hv2-record {
  position: relative;
  width: calc(var(--u) * 308);
  height: calc(var(--u) * 530);
}

.hv2-recordFrame {
  position: absolute;
  inset: 0;
  border-radius: calc(var(--u) * 24);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.5) 0%, rgba(199, 210, 254, 0.28) 55%, rgba(165, 180, 252, 0.32) 100%);
  border: calc(var(--u) * 1.5) solid rgba(255, 255, 255, 0.92);
  box-shadow:
    0 0 0 calc(var(--u) * 1) rgba(129, 140, 248, 0.45),
    0 0 calc(var(--u) * 26) rgba(96, 165, 250, 0.55),
    0 0 calc(var(--u) * 70) rgba(124, 58, 237, 0.25),
    inset 0 0 calc(var(--u) * 22) rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(10px);
}

/* Specular edge highlight, as on the prepared glass-frame asset. */
.hv2-recordFrame::before {
  content: "";
  position: absolute;
  inset: calc(var(--u) * -1.5);
  border-radius: inherit;
  background:
    radial-gradient(calc(var(--u) * 90) calc(var(--u) * 4) at 30% 0%, rgba(255, 255, 255, 0.95), transparent 70%),
    radial-gradient(calc(var(--u) * 4) calc(var(--u) * 80) at 0% 32%, rgba(186, 230, 253, 0.95), transparent 70%),
    radial-gradient(calc(var(--u) * 4) calc(var(--u) * 90) at 100% 70%, rgba(196, 181, 253, 0.9), transparent 70%),
    radial-gradient(calc(var(--u) * 110) calc(var(--u) * 4) at 62% 100%, rgba(191, 219, 254, 0.95), transparent 70%);
  pointer-events: none;
}

.hv2-recordCard {
  position: absolute;
  left: calc(var(--u) * 14);
  right: calc(var(--u) * 15);
  top: calc(var(--u) * 9);
  bottom: calc(var(--u) * 12);
  display: flex;
  flex-direction: column;
  padding: calc(var(--u) * 14) calc(var(--u) * 15) calc(var(--u) * 14);
  border-radius: calc(var(--u) * 17);
  background: #ffffff;
  box-shadow: 0 calc(var(--u) * 10) calc(var(--u) * 30) rgba(30, 41, 99, 0.18);
}

.hv2-recordHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: calc(var(--u) * 34);
}

.hv2-recordBrand {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--u) * 7);
  font-size: calc(var(--u) * 15);
  font-weight: 800;
  letter-spacing: 0.02em;
  color: var(--ink);
}

.hv2-recordBrand img {
  width: calc(var(--u) * 24);
  height: calc(var(--u) * 24);
  object-fit: contain;
}

.hv2-pill {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--u) * 5);
  height: calc(var(--u) * 26);
  padding: 0 calc(var(--u) * 9) 0 calc(var(--u) * 5);
  border-radius: calc(var(--u) * 8);
  background: #e7f8ef;
  border: calc(var(--u) * 1) solid #bfead2;
  color: #0f5132;
  font-size: max(calc(var(--u) * 10.5), 8.5px);
  font-weight: 600;
  white-space: nowrap;
}

.hv2-pillMark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--u) * 16);
  height: calc(var(--u) * 16);
  border-radius: 999px;
  background: #16a34a;
  color: #fff;
}

.hv2-pillMark svg {
  width: calc(var(--u) * 10);
  height: calc(var(--u) * 10);
}

.hv2-recordMedia {
  position: relative;
  margin-top: calc(var(--u) * 12);
  height: calc(var(--u) * 126);
  border-radius: calc(var(--u) * 9);
  overflow: hidden;
  background: #0b1433;
}

.hv2-recordMedia img {
  object-fit: cover;
  object-position: center 52%;
}

.hv2-recordMediaShade {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(8, 15, 40, 0) 55%, rgba(8, 15, 40, 0.45) 100%);
}

.hv2-play {
  position: absolute;
  left: 50%;
  top: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--u) * 42);
  height: calc(var(--u) * 42);
  margin: calc(var(--u) * -21) 0 0 calc(var(--u) * -21);
  border-radius: 999px;
  background: rgba(8, 15, 40, 0.42);
  border: calc(var(--u) * 1.5) solid rgba(255, 255, 255, 0.92);
  color: #fff;
  backdrop-filter: blur(4px);
}

.hv2-play svg {
  width: calc(var(--u) * 17);
  height: calc(var(--u) * 17);
  margin-left: calc(var(--u) * 2);
}

.hv2-recordName {
  margin: calc(var(--u) * 12) 0 0;
  font-size: calc(var(--u) * 14.5);
  font-weight: 700;
  color: var(--ink);
  letter-spacing: -0.005em;
}

.hv2-recordMeta {
  margin: calc(var(--u) * 2) 0 0;
  font-size: max(calc(var(--u) * 10.5), 8.5px);
  color: var(--muted);
  white-space: nowrap;
}

.hv2-recordRows {
  display: flex;
  flex-direction: column;
  margin: calc(var(--u) * 8) 0 0;
  padding: 0;
  list-style: none;
}

.hv2-recordRow {
  display: flex;
  align-items: center;
  gap: calc(var(--u) * 10);
  height: calc(var(--u) * 44);
  border-top: calc(var(--u) * 1) solid #eef1f6;
}

.hv2-recordRowIcon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: calc(var(--u) * 28);
  color: var(--blue);
}

.hv2-recordRowIcon svg {
  width: calc(var(--u) * 20);
  height: calc(var(--u) * 20);
}

.hv2-recordRowText {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: calc(var(--u) * 1);
}

.hv2-recordRowTitle {
  font-size: max(calc(var(--u) * 11), 9px);
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
}

.hv2-recordRowTitle em {
  font-style: normal;
  color: var(--blue);
}

.hv2-recordRowValue {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: max(calc(var(--u) * 10.5), 8px);
  color: var(--muted);
  white-space: nowrap;
}

.hv2-recordRowTrail {
  flex: none;
  display: flex;
  color: #94a3b8;
}

.hv2-recordRowTrail svg {
  width: calc(var(--u) * 15);
  height: calc(var(--u) * 15);
}

.hv2-trailOk {
  color: #16a34a;
}

.hv2-trailAction {
  color: var(--blue);
}

.hv2-miniMap {
  position: relative;
  flex: none;
  width: calc(var(--u) * 72);
  height: calc(var(--u) * 38);
  border-radius: calc(var(--u) * 6);
  overflow: hidden;
  background:
    linear-gradient(28deg, transparent 46%, #ffffff 46%, #ffffff 54%, transparent 54%),
    linear-gradient(-62deg, transparent 47%, #ffffff 47%, #ffffff 52%, transparent 52%),
    linear-gradient(90deg, transparent 70%, rgba(255, 255, 255, 0.85) 70%, rgba(255, 255, 255, 0.85) 74%, transparent 74%),
    radial-gradient(circle at 18% 78%, #cfe9d6 0 22%, transparent 23%),
    radial-gradient(circle at 86% 18%, #cfe3f6 0 20%, transparent 21%),
    #e8edf3;
  box-shadow: inset 0 0 0 calc(var(--u) * 1) #dbe2ea;
  color: var(--blue);
}

.hv2-miniMap svg {
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(var(--u) * 16);
  height: calc(var(--u) * 16);
  transform: translate(-50%, -62%);
  fill: rgba(37, 87, 230, 0.16);
}

.hv2-recordButton {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: calc(var(--u) * 6);
  height: calc(var(--u) * 36);
  margin-top: auto;
  border-radius: calc(var(--u) * 8);
  background: linear-gradient(180deg, #13307f 0%, var(--navy) 100%);
  color: #fff;
  font-size: max(calc(var(--u) * 11.5), 9px);
  font-weight: 600;
  box-shadow: 0 calc(var(--u) * 6) calc(var(--u) * 14) rgba(11, 31, 94, 0.28);
}

.hv2-recordButton svg {
  width: calc(var(--u) * 13);
  height: calc(var(--u) * 13);
}

/* Pedestal --------------------------------------------------------------- */

.hv2-glow {
  object-fit: fill;
  opacity: 1;
  pointer-events: none;
}

.hv2-pedestal {
  object-fit: fill;
  pointer-events: none;
  filter: saturate(1.05);
}

.hv2-pedestalFace {
  mix-blend-mode: multiply;
  opacity: 0.85;
}

.hv2-pedestalText {
  fill: #e6ecff;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  white-space: pre;
  paint-order: stroke;
  stroke: rgba(8, 18, 51, 0.55);
  stroke-width: 0.6px;
}

.hv2-pedestalTextDot {
  fill: #93c5fd;
}

.hv2-pedestalDot {
  width: calc(var(--u) * 3);
  height: calc(var(--u) * 3);
  border-radius: 999px;
  background: #93c5fd;
  box-shadow: 0 0 calc(var(--u) * 6) #60a5fa;
}

/* Output cards ----------------------------------------------------------- */

.hv2-output {
  position: relative;
  width: calc(var(--u) * 300);
  padding: calc(var(--u) * 16) calc(var(--u) * 16) calc(var(--u) * 16) calc(var(--u) * 16);
  border-radius: calc(var(--u) * 14);
}

.hv2-outputHead {
  display: flex;
  align-items: flex-start;
  gap: calc(var(--u) * 12);
}

.hv2-badgeIcon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: calc(var(--u) * 34);
  height: calc(var(--u) * 34);
  border-radius: 999px;
  background: linear-gradient(180deg, #3b6cf6 0%, #1f4fd8 100%);
  color: #fff;
  box-shadow:
    0 0 0 calc(var(--u) * 3) rgba(59, 108, 246, 0.12),
    0 calc(var(--u) * 4) calc(var(--u) * 10) rgba(31, 79, 216, 0.3);
}

.hv2-badgeIcon svg {
  width: calc(var(--u) * 17);
  height: calc(var(--u) * 17);
}

.hv2-outputTitle {
  margin: calc(var(--u) * 1) 0 0;
  font-size: calc(var(--u) * 13.5);
  font-weight: 700;
  color: var(--ink);
  line-height: 1.25;
  white-space: nowrap;
}

.hv2-outputBody {
  margin: calc(var(--u) * 3) 0 0;
  font-size: max(calc(var(--u) * 11), 9px);
  line-height: 1.38;
  color: var(--slate);
}

.hv2-verifyRow {
  display: flex;
  align-items: flex-end;
  gap: calc(var(--u) * 12);
  margin-top: calc(var(--u) * 10);
}

.hv2-verifyThumb {
  position: relative;
  flex: 1;
  height: calc(var(--u) * 66);
  border-radius: calc(var(--u) * 7);
  overflow: hidden;
  background: #0b1433;
}

.hv2-verifyThumb img {
  object-fit: cover;
  object-position: center 58%;
}

.hv2-qr {
  flex: none;
  width: calc(var(--u) * 76);
  height: calc(var(--u) * 76);
  margin-top: calc(var(--u) * -20);
  padding: calc(var(--u) * 5);
  border-radius: calc(var(--u) * 7);
  background: #fff;
  box-shadow: 0 0 0 calc(var(--u) * 1) #e2e8f0;
}

.hv2-qr svg {
  display: block;
  width: 100%;
  height: 100%;
}

.hv2-reportShot {
  position: absolute;
  top: calc(var(--u) * 6);
  right: calc(var(--u) * -22);
  width: calc(var(--u) * 106);
  height: calc(var(--u) * 94);
  pointer-events: none;
}

.hv2-reportShot img {
  object-fit: contain;
  filter: drop-shadow(0 calc(var(--u) * 8) calc(var(--u) * 12) rgba(30, 41, 99, 0.22));
}

.hv2-pdfTag {
  position: absolute;
  right: calc(var(--u) * 50);
  bottom: calc(var(--u) * 2);
  display: inline-flex;
  align-items: center;
  gap: calc(var(--u) * 3);
  height: calc(var(--u) * 18);
  padding: 0 calc(var(--u) * 6);
  border-radius: calc(var(--u) * 4);
  background: #fff;
  box-shadow: 0 calc(var(--u) * 2) calc(var(--u) * 6) rgba(15, 23, 42, 0.18);
  color: #dc2626;
  font-size: max(calc(var(--u) * 9), 7.5px);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.hv2-pdfTag svg {
  width: calc(var(--u) * 10);
  height: calc(var(--u) * 10);
}

.hv2-shareField {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--u) * 8);
  height: calc(var(--u) * 32);
  margin-top: calc(var(--u) * 12);
  padding: 0 calc(var(--u) * 3) 0 calc(var(--u) * 10);
  border-radius: calc(var(--u) * 7);
  background: #fff;
  border: calc(var(--u) * 1) solid #dfe5ee;
  font-size: max(calc(var(--u) * 10.5), 8.5px);
  color: var(--ink);
  white-space: nowrap;
}

.hv2-shareCopy {
  display: inline-flex;
  align-items: center;
  height: calc(var(--u) * 24);
  padding: 0 calc(var(--u) * 10);
  border-radius: calc(var(--u) * 5);
  background: #eef3ff;
  border: calc(var(--u) * 1) solid #c9d7fb;
  color: var(--blue);
  font-weight: 600;
}

.hv2-avatars {
  display: flex;
  align-items: center;
  margin: calc(var(--u) * 10) 0 0 calc(var(--u) * 46);
}

.hv2-avatar {
  position: relative;
  width: calc(var(--u) * 28);
  height: calc(var(--u) * 28);
  margin-right: calc(var(--u) * 3);
  border-radius: 999px;
  overflow: hidden;
  background: #dbe4ff;
  box-shadow: 0 0 0 calc(var(--u) * 2) #fff, 0 calc(var(--u) * 2) calc(var(--u) * 6) rgba(15, 23, 42, 0.18);
}

.hv2-avatar img {
  object-fit: cover;
  transform: scale(1.34);
  transform-origin: 50% 46%;
}

.hv2-avatarMore {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--u) * 28);
  height: calc(var(--u) * 28);
  margin-left: calc(var(--u) * 4);
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  font-size: max(calc(var(--u) * 10), 8px);
  font-weight: 700;
}

/* -------------------------------------------- stacked layout (< 1024px) */

.hv2-stack {
  display: flex;
  flex-direction: column;
  gap: 28px;
}

@media (min-width: 1024px) {
  .hv2-stack {
    display: none;
  }
}

.hv2-stackRecord {
  container-type: inline-size;
  width: min(100%, 360px);
  margin: 0 auto;
}

.hv2-stackRecord > div {
  --u: calc(100cqw / 308);
}

.hv2-stackFlow {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 8px 12px;
  margin: -6px auto 0;
  padding: 10px 18px;
  border-radius: 10px;
  background: linear-gradient(180deg, #13245e 0%, #081640 100%);
  color: #e8eeff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
}

.hv2-stackFlow .hv2-pedestalDot {
  --u: 1px;
}

.hv2-stackScroller {
  display: flex;
  gap: 12px;
  margin: 0 -20px;
  padding: 4px 20px 12px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
}

.hv2-stackScroller::-webkit-scrollbar {
  display: none;
}

.hv2-stackScroller > * {
  scroll-snap-align: start;
  flex: none;
}

@media (min-width: 768px) {
  .hv2-stackScroller {
    margin: 0 -32px;
    padding-left: 32px;
    padding-right: 32px;
  }
}

.hv2-stackSource {
  --u: 1px;
}

.hv2-stackOutputs {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}

@media (min-width: 640px) {
  .hv2-stackOutputs {
    grid-template-columns: 1fr 1fr;
  }
}

.hv2-stackOutput {
  container-type: inline-size;
}

.hv2-stackOutput > div {
  --u: calc(100cqw / 300);
}

.hv2-stackHeading {
  margin: 0 0 -14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
}

/* ------------------------------------------------------- industry cards */

.hv2-industries {
  display: flex;
  gap: 12px;
  margin: 36px -20px 0;
  padding: 4px 20px 8px;
  list-style: none;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
}

.hv2-industries::-webkit-scrollbar {
  display: none;
}

.hv2-industries > li {
  flex: none;
  width: 248px;
  scroll-snap-align: start;
}

@media (min-width: 768px) {
  .hv2-industries {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    margin: 40px 0 0;
    padding: 0;
    overflow: visible;
  }
  .hv2-industries > li {
    width: auto;
  }
}

@media (min-width: 1024px) {
  .hv2-industries {
    margin-top: 28px;
  }
}

@media (min-width: 1200px) {
  .hv2-industries {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 1.25%;
    margin: 14px 3.3% 0;
  }
}

.hv2-industry {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  border-radius: 12px;
  background: #fff;
  border: 1px solid #e6eaf3;
  box-shadow: 0 10px 26px rgba(30, 41, 99, 0.08);
  transition: box-shadow 180ms ease, transform 180ms ease, border-color 180ms ease;
}

.hv2-industry:hover {
  border-color: #cdd7f3;
  box-shadow: 0 16px 34px rgba(30, 41, 99, 0.14);
  transform: translateY(-2px);
}

.hv2-industry:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.hv2-industryMedia {
  position: relative;
  /* 2:1 against the 16:9 assets: full width, only ~11% of the height trimmed. */
  aspect-ratio: 2 / 1;
  overflow: hidden;
  background: #0b1433;
}

.hv2-industryMedia img {
  object-fit: cover;
}

.hv2-industryBody {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 20px;
  column-gap: 12px;
  padding: 14px 14px 16px 14px;
}

@media (min-width: 1200px) {
  .hv2-industryBody {
    grid-template-columns: clamp(22px, 1.6vw, 28px) minmax(0, 1fr) 20px;
    column-gap: clamp(6px, 0.6vw, 11px);
    padding: clamp(10px, 0.75vw, 13px) clamp(9px, 0.7vw, 12px) clamp(12px, 0.95vw, 16px);
  }
}

.hv2-industryIcon {
  display: flex;
  justify-content: center;
  padding-top: 1px;
  color: var(--navy);
}

.hv2-industryTitle {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--ink);
  line-height: 1.3;
}

.hv2-industryText {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.42;
  color: var(--slate);
}

@media (min-width: 1200px) {
  .hv2-industryTitle {
    font-size: clamp(11.5px, 0.8vw, 14px);
  }
  .hv2-industryText {
    font-size: clamp(10px, 0.7vw, 12px);
  }
}

.hv2-industryArrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 999px;
  border: 1px solid #dbe2ee;
  color: #334155;
  transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
}

.hv2-industry:hover .hv2-industryArrow {
  background: var(--navy);
  border-color: var(--navy);
  color: #fff;
}

/* ------------------------------------------------------- audience strip */

.hv2-audience {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px 0;
  margin: 28px 0 0;
  padding: 22px 0 6px;
  border-top: 1px solid var(--line);
}

@media (min-width: 1200px) {
  .hv2-audience {
    flex-wrap: nowrap;
    margin: 1.4% 3.3% 0;
    padding: 1.45% 0 0.4% 1%;
  }
}

.hv2-audienceLabel {
  width: 100%;
  margin: 0 0 4px;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink);
  white-space: nowrap;
}

@media (min-width: 1200px) {
  .hv2-audienceLabel {
    width: auto;
    margin: 0 2.2% 0 0;
    font-size: clamp(10.5px, 0.78vw, 13px);
  }
}

.hv2-audienceList {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

@media (min-width: 1200px) {
  .hv2-audienceList {
    flex: 1;
    flex-wrap: nowrap;
    justify-content: space-between;
  }
}

.hv2-audienceItem {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-left: 1px solid var(--line);
  font-size: 13.5px;
  font-weight: 500;
  color: #1e293b;
  white-space: nowrap;
}

@media (min-width: 1200px) {
  .hv2-audienceItem {
    flex: 1 1 auto;
    justify-content: center;
    padding: 0 0.6vw;
    font-size: clamp(11.5px, 0.86vw, 14.5px);
  }
}

.hv2-audienceItem svg {
  color: var(--navy);
}

.hv2-audienceMore {
  color: var(--muted);
}

/* ------------------------------------------------------- QA refinements */

@media (max-width: 1199px) {
  .hv2-city {
    -webkit-mask-image: linear-gradient(180deg, #000 55%, transparent 100%);
    mask-image: linear-gradient(180deg, #000 55%, transparent 100%);
  }
}

@media (max-width: 639px) {
  .hv2-headlineLines {
    font-size: clamp(30px, 8.8vw, 40px);
  }
  .hv2-headlineAccent {
    font-size: clamp(20px, 5.6vw, 26px);
  }
  .hv2-eyebrow {
    font-size: 11px;
    letter-spacing: 0.2em;
  }
  .hv2-stackFlow {
    gap: 6px 8px;
    padding: 10px 12px;
    font-size: 10px;
    letter-spacing: 0.08em;
  }
}

/* The report preview overhangs its card; keep the card tall enough. */
.hv2-stackOutput .hv2-output {
  min-height: calc(var(--u) * 112);
}

@media (min-width: 1200px) and (max-width: 1439px) {
  .hv2-ctas {
    flex-wrap: nowrap;
    gap: 12px;
  }
  .hv2-ctaPrimary,
  .hv2-ctaSecondary {
    padding: 0 20px;
    gap: 10px;
  }
}

@media (min-width: 1200px) and (max-width: 1439px) {
  .hv2-assurances {
    flex-wrap: wrap;
  }
}

/* Snap to the page gutter, not the scroller's edge. */
.hv2-stackScroller,
.hv2-industries {
  scroll-padding-inline: 20px;
}

@media (min-width: 768px) {
  .hv2-stackScroller {
    scroll-padding-inline: 32px;
  }
}

/* Reports copy keeps clear of the overhanging preview at every scale. */
.hv2-reportsBody {
  max-width: calc(var(--u) * 148);
}

@media (max-width: 479px) {
  .hv2-ctaPrimary,
  .hv2-ctaSecondary {
    flex: 1 1 100%;
  }
}

@media (max-width: 399px) {
  .hv2-stackFlow {
    gap: 6px 5px;
    padding: 10px 8px;
    font-size: 9.5px;
    letter-spacing: 0.05em;
  }
}

/* Stacked layout: keep the report preview inside the page gutter. */
.hv2-stackOutput .hv2-reportShot {
  right: calc(var(--u) * -4);
}

.hv2-stackOutput .hv2-reportsBody {
  max-width: calc(var(--u) * 136);
}

/* Wide screens: the copy column is capped with the 1672px container, so cap
   the description too — it must clear the inward-turned source cards. */
@media (min-width: 1672px) {
  .hv2-lede {
    max-width: 468px;
  }
}

@media (max-width: 359px) {
  .hv2-stackFlow {
    gap: 6px 4px;
    padding: 9px 6px;
    font-size: 8.5px;
    letter-spacing: 0.03em;
  }
}
`;

export const HERO_V2_CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n{3,}/g, "\n\n");
