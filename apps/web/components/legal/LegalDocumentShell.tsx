"use client";

/**
 * Canonical AUTHENTICATED legal/trust document shell.
 *
 * 2026-07-19 flat enterprise-document layout: the user is already
 * inside the App Shell, so internal legal/trust pages carry NO
 * marketing hero and NO white article card. The page is:
 *
 *   compact document header (back link → badges → title → summary →
 *   meta) directly on the application page background
 *   → thin divider
 *   → document body directly on the page background
 *
 * The document TYPOGRAPHY is the same zero-drift chain as the public
 * /legal/[slug] pages (`LEGAL_ARTICLE_TYPOGRAPHY`); only the outer
 * composition differs — the public pages keep their hero + white card,
 * internal pages are flat. The title keeps the canonical navy +
 * blue→violet→magenta gradient treatment, placed directly on the page
 * background.
 *
 * PRESENTATION ONLY. This shell never decides authorization — parents
 * keep their PageRouteGate / org-permission gates, and the scope badge
 * is a label, not a gate.
 *
 * Variants:
 *   variant="document"     → children render through the canonical
 *                            typography chain (long-form documents).
 *   variant="operational"  → children render as-is (status page — live
 *                            widgets, not legal prose).
 */

import Link from "next/link";

import {
  LEGAL_ARTICLE_TYPOGRAPHY,
  LEGAL_META_CLASSES,
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
  /** Optional slot rendered below the header meta (callouts etc.). */
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

function DocumentTitle({ title, highlight }: { title: string; highlight?: string }) {
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
  backLabel = "Open public Trust Center",
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
    >
      {/* Enterprise-docs composition: the compact header stays
          LEFT-aligned; the reading column below it is horizontally
          centered at the same max-width as the public legal pages. */}
      <div className="w-full px-6 py-8 md:px-8 md:py-10">
        {/* HEADER — compact console document header, left-aligned. No
            hero image, no gradient panel, no card: content sits on the
            page background. */}
        <header className="max-w-[960px]" data-legal-document-header>
          {backHref ? (
            <div className="mb-4">
              <Link
                href={backHref}
                className="text-[12.5px] font-semibold text-[#475569] no-underline hover:text-[#1E40AF] hover:underline hover:underline-offset-4"
                data-legal-document-back
              >
                ← {backLabel}
              </Link>
            </div>
          ) : null}

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
            className="mt-3 text-[1.55rem] font-semibold leading-[1.12] tracking-[-0.025em] text-[#0F172A] md:text-[1.9rem]"
            data-legal-document-title
          >
            <DocumentTitle title={title} highlight={highlight} />
          </h1>

          <p
            className="mt-2 max-w-[720px] text-[14.5px] leading-[1.65] text-[#475569]"
            data-legal-document-summary
          >
            {summary}
          </p>

          {meta ? (
            <div className={`mt-3 ${LEGAL_META_CLASSES}`} data-legal-document-meta>
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

          {heroChildren ? <div className="mt-5">{heroChildren}</div> : null}

          {/* Thin divider between the document header and the body. */}
          <hr
            aria-hidden="true"
            className="mt-6 h-px border-0 bg-[#DDE6F2]"
            data-legal-document-divider
          />
        </header>

        {/* BODY — CENTERED reading column at the same max-width as the
            public /legal/[slug] pages (mx-auto max-w-5xl). The canonical
            typography chain renders directly on the page background —
            still no white card, no shadow, no panel. */}
        <div className="mx-auto w-full max-w-5xl pt-8" data-legal-document-reading-column>
          {variant === "document" ? (
            <article className={LEGAL_ARTICLE_TYPOGRAPHY} data-legal-content>
              {children}
            </article>
          ) : (
            <div data-legal-operational-body>{children}</div>
          )}

          {relatedLinks && relatedLinks.length > 0 ? (
            <nav
              aria-label="Related documents"
              className="mt-10 border-t border-[#DDE6F2] pt-5"
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
        </div>
      </div>
    </div>
  );
}
