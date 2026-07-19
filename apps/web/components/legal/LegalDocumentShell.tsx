"use client";

/**
 * Canonical AUTHENTICATED legal/trust document shell (2026-07-18).
 *
 * ONE visual system for every in-app legal, trust-documentation,
 * policy, methodology, disclosure, and compliance page — the SAME
 * family as the public /legal/[slug] pages:
 *
 *   - same hero artwork, gradient rule, and typography (LegalHero's
 *     contract, compacted for in-app use — the app shell already owns
 *     global navigation, so no MarketingHeader and no 720px hero),
 *   - same page background (#F6F9FC),
 *   - same white rounded document card + typography chain
 *     (`LEGAL_ARTICLE_CLASSES` — extracted verbatim from the public
 *     implementation; one source, zero drift),
 *   - same meta/back-link/related-documents language.
 *
 * PRESENTATION ONLY. This shell never decides authorization — parents
 * keep their PageRouteGate / org-permission gates, and the scope badge
 * is a label, not a gate.
 *
 * Variants:
 *   variant="document"     → children render INSIDE the canonical
 *                            white article card (long-form documents).
 *   variant="operational"  → children render on the page background
 *                            without the prose card (status page
 *                            exception §16 — same hero family, an
 *                            operational body).
 */

import Link from "next/link";

import {
  LEGAL_ARTICLE_CLASSES,
  LEGAL_HERO_IMAGE,
  LEGAL_META_CLASSES,
  LEGAL_PAGE_BG,
  LEGAL_TITLE_GRADIENT,
} from "./legalArticleStyles";

export type LegalDocumentScope = "PUBLIC" | "ACCOUNT" | "ORGANIZATION";

const SCOPE_BADGE_LABEL: Record<LegalDocumentScope, string | null> = {
  PUBLIC: null,
  ACCOUNT: "Trust documentation",
  ORGANIZATION: "Organization document",
};

export type LegalRelatedLink = { label: string; href: string };

export type LegalDocumentShellProps = {
  /** Eyebrow/category, e.g. "Trust documentation", "Organization policy". */
  label: string;
  title: string;
  /** Optional substring of `title` rendered with the canonical gradient. */
  highlight?: string;
  summary: string;
  /** Version / updated / effective line, e.g. "Version 3 · Effective 18 July 2026". */
  meta?: string;
  scope: LegalDocumentScope;
  /** Shown under the meta for ORGANIZATION scope, e.g. "Applies to Acme Legal Operations". */
  organizationName?: string;
  backHref?: string;
  backLabel?: string;
  /** Short contextual related-documents list — never the old 24-link dump. */
  relatedLinks?: ReadonlyArray<LegalRelatedLink>;
  variant?: "document" | "operational";
  /** Optional slot rendered below the hero meta (callouts etc.). */
  heroChildren?: React.ReactNode;
  children: React.ReactNode;
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

function HeroTitle({ title, highlight }: { title: string; highlight?: string }) {
  if (!highlight) return <>{title}</>;
  const idx = title.indexOf(highlight);
  if (idx === -1) return <>{title}</>;
  return (
    <>
      {title.slice(0, idx)}
      <GradientPhrase>{highlight}</GradientPhrase>
      {title.slice(idx + highlight.length)}
    </>
  );
}

export function LegalDocumentShell({
  label,
  title,
  highlight,
  summary,
  meta,
  scope,
  organizationName,
  backHref = "/trust",
  backLabel = "Back to Trust Center",
  relatedLinks,
  variant = "document",
  heroChildren,
  children,
}: LegalDocumentShellProps) {
  const scopeBadge = SCOPE_BADGE_LABEL[scope];

  return (
    <div
      className="legal-document-shell"
      data-legal-document-shell={scope.toLowerCase()}
      style={{ background: LEGAL_PAGE_BG, minHeight: "100%" }}
    >
      {/* HERO — the public LegalHero family, compacted for in-app use.
          Same artwork, same navy/gradient title rule, same summary and
          meta typography. The app shell owns global navigation, so the
          hero carries no second header. */}
      <section
        className="relative overflow-hidden bg-white"
        data-legal-document-hero
      >
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage: `url("${LEGAL_HERO_IMAGE}")`,
            backgroundSize: "100% 100%",
            backgroundPosition: "center center",
            backgroundRepeat: "no-repeat",
          }}
        />
        <div className="relative z-10 mx-auto max-w-[1320px] px-6 pb-10 pt-8 md:px-8 md:pb-14 md:pt-12">
          <div className="max-w-[640px]">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center gap-2 rounded-full border border-[#DDE6F2] bg-white/80 px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.12em] text-[#475569]"
                data-legal-document-eyebrow
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "#7C3AED" }}
                />
                {label}
              </span>
              {scopeBadge ? (
                <span
                  className="inline-flex items-center rounded-full border border-[#DDE6F2] bg-[#F1F5F9] px-3 py-1 text-[11.5px] font-semibold tracking-[0.02em] text-[#0B1F4D]"
                  data-legal-document-scope-badge={scope.toLowerCase()}
                >
                  {scopeBadge}
                </span>
              ) : null}
            </div>

            <h1
              className="mt-4 max-w-[600px] text-[1.7rem] font-semibold leading-[1.08] tracking-[-0.025em] text-[#0F172A] md:text-[2.2rem] lg:text-[2.5rem]"
              data-legal-hero-title
            >
              <HeroTitle title={title} highlight={highlight} />
            </h1>

            <p
              className="mt-3 max-w-[560px] text-[15px] leading-[1.65] text-[#475569]"
              data-legal-hero-summary
            >
              {summary}
            </p>

            {meta ? (
              <div className={`mt-4 ${LEGAL_META_CLASSES}`} data-legal-hero-meta>
                {meta}
              </div>
            ) : null}
            {organizationName ? (
              <div
                className={`mt-1 ${LEGAL_META_CLASSES}`}
                data-legal-document-organization
              >
                Applies to {organizationName}
              </div>
            ) : null}

            {backHref ? (
              <div className="mt-4">
                <Link
                  href={backHref}
                  className="text-[12.5px] font-semibold text-[#0F172A] underline underline-offset-4 hover:text-[#1E40AF]"
                  data-legal-document-back
                >
                  ← {backLabel}
                </Link>
              </div>
            ) : null}

            {heroChildren ? (
              <div className="mt-5 max-w-[560px]">{heroChildren}</div>
            ) : null}
          </div>
        </div>
      </section>

      {/* BODY — canonical reading width + document rhythm. */}
      <section className="mx-auto max-w-5xl px-6 py-10 md:px-8 md:py-12">
        {variant === "document" ? (
          <article className={LEGAL_ARTICLE_CLASSES} data-legal-content>
            {children}
          </article>
        ) : (
          <div data-legal-operational-body>{children}</div>
        )}

        {relatedLinks && relatedLinks.length > 0 ? (
          <nav
            aria-label="Related documents"
            className="mt-8 rounded-[16px] border border-[#DDE6F2] bg-white px-6 py-5"
            data-legal-related-links
          >
            <div className="text-[0.78rem] font-bold uppercase tracking-[0.12em] text-[#475569]">
              Related documents
            </div>
            <ul className="mt-3 grid gap-2">
              {relatedLinks.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-[0.95rem] font-medium text-[#2563EB] underline underline-offset-4 hover:text-[#1E40AF]"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
