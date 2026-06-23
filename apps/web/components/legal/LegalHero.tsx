import { MarketingHeader } from "../marketing/MarketingHeader";

/**
 * Shared hero for every /legal/[slug] page and for /trust. Visual
 * rhythm is intentionally aligned with the /platform hero
 * (apps/web/app/platform/page.tsx PlatformHero) so Legal/Trust feels
 * like part of PROOVRA rather than a separate template:
 *
 *   - container `max-w-[1320px]`
 *   - `lg:grid-cols-[46fr_54fr]` two-column desktop layout
 *   - content-driven height (no min-height clamp)
 *   - pale-blue pill eyebrow with violet dot (Eyebrow style)
 *   - H1 typography: text-[2rem] md:text-[2.6rem] lg:text-[3rem],
 *     font-semibold, leading-[1.06], tracking-[-0.025em], #0F172A
 *   - shared `proovra-page-hero-bg.png` section background
 *
 * Title color rule: the BASE title renders in deep navy; only the
 * `highlight` substring renders with the legal-tuned blue → violet →
 * magenta gradient. The highlight may sit anywhere in the title, and
 * the text BEFORE and AFTER it both stay navy. Cyan is intentionally
 * excluded per the Legal Center brief.
 */

/**
 * Single source of truth for the Legal/Trust hero artwork. This is the
 * ONLY image path the shared hero is allowed to reference. Do not add
 * a section-level background pattern, do not import an alternate
 * artwork, do not branch by slug.
 */
const HERO_IMAGE = "/assets/hero/legal-hero.png";

/** Legal/Trust palette — blue → violet → magenta. No cyan. */
const LEGAL_TITLE_GRADIENT =
  "linear-gradient(90deg, #2563EB 0%, #7C3AED 50%, #C026D3 100%)";

export type LegalHeroProps = {
  label: string;
  title: string;
  summary: string;
  meta: string;
  /**
   * Substring inside `title` to render with the gradient. Text before
   * and after the substring stays navy. When omitted, the entire title
   * renders navy.
   */
  highlight?: string;
  /** Optional slot rendered below the meta line (boundary callout, etc.). */
  children?: React.ReactNode;
};

function GradientPhrase({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="bg-clip-text text-transparent"
      style={{ backgroundImage: LEGAL_TITLE_GRADIENT }}
    >
      {children}
    </span>
  );
}

/**
 * Renders the title with at most one gradient span in the middle. The
 * before / highlight / after slices are emitted as adjacent text so the
 * navy → gradient → navy reading flow is preserved.
 */
function HeroTitle({ title, highlight }: { title: string; highlight?: string }) {
  if (!highlight) return <>{title}</>;

  const idx = title.indexOf(highlight);
  if (idx === -1) return <>{title}</>;

  const before = title.slice(0, idx);
  const after = title.slice(idx + highlight.length);
  return (
    <>
      {before}
      <GradientPhrase>{highlight}</GradientPhrase>
      {after}
    </>
  );
}

export function LegalHero({
  label: _label,
  title,
  summary,
  meta,
  highlight,
  children,
}: LegalHeroProps) {
return (
<section className="relative min-h-[720px] overflow-hidden bg-white">  
<div
  aria-hidden="true"
  className="absolute inset-0"
  style={{
    backgroundImage: `url("${HERO_IMAGE}")`,
    backgroundSize: "100% 100%",
    backgroundPosition: "center center",
    backgroundRepeat: "no-repeat",
  }}
/>
    <div className="relative z-10">
      <MarketingHeader />

      <div className="mx-auto max-w-[1320px] px-6 pb-24 pt-20 md:px-8 lg:pb-28 lg:pt-28">
        <div className="max-w-[640px]">
            <h1
              className="mt-4 max-w-[600px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.025em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]"
              data-legal-hero-title
            >
              <HeroTitle title={title} highlight={highlight} />
            </h1>

            <p
              className="mt-4 max-w-[560px] text-[15px] leading-[1.65] text-[#475569]"
              data-legal-hero-summary
            >
              {summary}
            </p>

            <div
              className="mt-5 text-[12.5px] font-medium tracking-[0.01em] text-[#64748B]"
              data-legal-hero-meta
            >
              {meta}
            </div>

            {children ? <div className="mt-6 max-w-[560px]">{children}</div> : null}
          </div>

          {/* RIGHT — primary hero visual. Fills the right side
              edge-to-edge, no contained-card chrome. The image is the
              hero artwork, not a card inside a hero. Heights are
              concrete at each breakpoint so the panel never collapses
              to a card-shaped fragment. Subtle rounded corners on
              desktop only (the panel sits at the section edge on
              mobile so no rounding is needed). */}
        </div>
      </div>
    </section>
  );
}
