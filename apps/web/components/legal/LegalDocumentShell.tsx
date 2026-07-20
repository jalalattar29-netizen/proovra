"use client";

/**
 * Canonical AUTHENTICATED legal/trust document shell.
 *
 * 2026-07-20 ENTERPRISE DOCUMENTATION EXPERIENCE (target: the approved
 * reference composition — Stripe/Atlassian/Microsoft-class docs):
 *
 *   ← Back
 *   ● CATEGORY   TRUST DOCUMENTATION
 *   Title (navy + gradient emphasis)
 *   Two-line summary
 *   [icons] Last updated · Scope · Version
 *   ── thin divider ──
 *   [☰ On this page ⌄]  (collapsible section navigator)
 *   Document body — typography + auto-detected Information Panels,
 *   contact rows, chip rows, enterprise tables, violet notices
 *   Related documents panel (icon tiles + descriptions)
 *   Open public Trust Center ↗ (opens in a new tab; this app stays open)
 *
 * ONE centered document column (~860px). No hero, no marketing blocks,
 * no dashboard cards — structured information only (provider panels,
 * tables, callouts) via the renderer's `enhance` mode.
 *
 * PRESENTATION ONLY. Parents keep PageRouteGate / org gates; the scope
 * badge is a label, not a gate. Public pages never use this shell.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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

const SCOPE_META_LABEL: Record<LegalDocumentScope, string | null> = {
  PUBLIC: null,
  ACCOUNT: "Scope: Account",
  ORGANIZATION: "Scope: Organization",
};

export type LegalRelatedLink = {
  label: string;
  href: string;
  /** One-line description shown under the label in the related panel. */
  description?: string;
};

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

function IconCalendar() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 2.5v3M13 2.5v3" strokeLinecap="round" />
    </svg>
  );
}

function IconScope() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconList() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M7 5.5h9M7 10h9M7 14.5h9" strokeLinecap="round" />
      <path d="M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01" strokeLinecap="round" strokeWidth="2.4" />
    </svg>
  );
}

function IconDoc() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M5 2.5h7L16 6.5v11H5z" strokeLinejoin="round" />
      <path d="M12 2.5v4h4" strokeLinejoin="round" />
      <path d="M7.5 10h5M7.5 13h5" strokeLinecap="round" />
    </svg>
  );
}

type TocItem = { id: string; text: string };

function slugifyHeading(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `section-${index}`;
}

/** Internal-only reading rhythm + subtle motion (public pages untouched). */
const INTERNAL_DOCUMENT_CSS = `
  @keyframes legalDocFadeIn { from { opacity: 0 } to { opacity: 1 } }
  .legal-document-shell [data-legal-content],
  .legal-document-shell [data-legal-operational-body] {
    animation: legalDocFadeIn 0.24s ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .legal-document-shell [data-legal-content],
    .legal-document-shell [data-legal-operational-body] { animation: none; }
  }
  /* Section rhythm — every heading opens a breathing section. */
  .legal-document-shell article[data-legal-content] h2 { margin-top: 3.25rem; }
  .legal-document-shell article[data-legal-content] hr { margin: 3rem 0; }
  /* Wide-table breakout is canonical (globals.css, keyed on
     [data-legal-doc], which this shell carries) — shared with the
     public legal pages, no per-shell duplication. */
  /* Structured notices — quiet violet accent, near-transparent field. */
  .legal-document-shell article[data-legal-content] blockquote {
    margin: 1.75rem 0;
    border-left: 3px solid #C4B5FD;
    background: rgba(124, 58, 237, 0.035);
    border-radius: 0 8px 8px 0;
    padding: 0.9rem 1.15rem;
  }
  /* INTERNAL-ONLY: ~10% more compact tables (density matching Microsoft
     Learn / Stripe Docs). Public /legal/* tables keep the base sizing.
     !important overrides the renderer's inline font-size/padding; the
     column min-width is a plain higher-specificity override. */
  .legal-document-shell .legal-table { font-size: 12.5px !important; }
  .legal-document-shell .legal-table th,
  .legal-document-shell .legal-table td {
    padding: 11px 15px !important;
    min-width: 7.75rem;
  }
  .legal-document-shell .legal-table th { font-size: 11px !important; }
  .legal-document-shell .legal-table th:first-child,
  .legal-document-shell .legal-table td:first-child { padding-left: 17px !important; }
  .legal-document-shell .legal-table th:last-child,
  .legal-document-shell .legal-table td:last-child { padding-right: 17px !important; }
`;

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
  const scopeMeta = SCOPE_META_LABEL[scope];

  const columnRef = useRef<HTMLDivElement | null>(null);
  const [toc, setToc] = useState<ReadonlyArray<TocItem>>([]);
  const [tocOpen, setTocOpen] = useState(false);

  // Collect the document's H2 sections for the "On this page" navigator.
  // Client-side only: assigns missing anchor ids without touching the
  // shared renderer (public pages stay byte-identical).
  useEffect(() => {
    if (variant !== "document") return;
    const root = columnRef.current;
    if (!root) return;
    const headings = Array.from(
      root.querySelectorAll<HTMLHeadingElement>("article[data-legal-content] h2"),
    );
    const seen = new Set<string>();
    setToc(
      headings.map((h, i) => {
        let id = h.id || slugifyHeading(h.textContent ?? "", i);
        while (seen.has(id)) id = `${id}-${i}`;
        seen.add(id);
        h.id = id;
        return { id, text: (h.textContent ?? "").trim() };
      }),
    );
  }, [variant, children]);

  const showToc = variant === "document" && toc.length >= 3;

  return (
    <div
      className="legal-document-shell"
      data-legal-document-shell={scope.toLowerCase()}
      data-legal-doc
    >
      <style>{INTERNAL_DOCUMENT_CSS}</style>

      {/* ONE centered document column — the enterprise reading axis. */}
      <div
        ref={columnRef}
        className="mx-auto w-full max-w-[860px] px-6 py-10 md:px-8 md:py-12"
        data-legal-document-grid
      >
        <header data-legal-document-header>
          {backHref ? (
            <div className="mb-6">
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
                className="inline-flex items-center rounded-full border border-[#DDE6F2] bg-[#F1F5F9] px-3 py-1 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[#0B1F4D]"
                data-legal-document-scope-badge={scope.toLowerCase()}
              >
                {scopeBadge}
              </span>
            ) : null}
          </div>

          <h1
            className="mt-4 text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.025em] text-[#0F172A] md:text-[2.2rem]"
            data-legal-document-title
          >
            <DocumentTitle title={title} highlight={highlight} />
          </h1>

          <p
            className="mt-3 max-w-[720px] text-[14.5px] leading-[1.75] text-[#475569]"
            data-legal-document-summary
          >
            {summary}
          </p>

          {/* Metadata row — small icons, quiet separators. */}
          <div
            className={`mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 ${LEGAL_META_CLASSES}`}
            data-legal-document-meta
          >
            {meta ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="text-[#64748B]">
                  <IconCalendar />
                </span>
                {meta}
              </span>
            ) : null}
            {scopeMeta ? (
              <>
                {meta ? <span aria-hidden="true" className="text-[#CBD5E1]">·</span> : null}
                <span className="inline-flex items-center gap-1.5" data-legal-document-scope-meta>
                  <span aria-hidden="true" className="text-[#64748B]">
                    <IconScope />
                  </span>
                  {scopeMeta}
                </span>
              </>
            ) : null}
          </div>
          {organizationName ? (
            <div
              className={`mt-1.5 ${LEGAL_META_CLASSES}`}
              data-legal-document-organization
            >
              Applies to {organizationName}
            </div>
          ) : null}

          {heroChildren ? <div className="mt-6">{heroChildren}</div> : null}

          <hr
            aria-hidden="true"
            className="mt-7 h-px border-0 bg-[#DDE6F2]"
            data-legal-document-divider
          />
        </header>

        {/* "On this page" — collapsible section navigator. */}
        {showToc ? (
          <nav aria-label="On this page" data-legal-document-toc className="mt-6">
            <button
              type="button"
              onClick={() => setTocOpen((o) => !o)}
              aria-expanded={tocOpen}
              data-legal-document-toc-toggle
              className="inline-flex items-center gap-2 rounded-[10px] border border-[#DDE6F2] bg-white/80 px-3.5 py-2 text-[0.85rem] font-semibold text-[#334155] hover:border-[#94A3B8]"
            >
              <span aria-hidden="true" className="text-[#64748B]">
                <IconList />
              </span>
              On this page
              <span
                aria-hidden="true"
                className={`text-[0.7rem] text-[#64748B] transition-transform ${tocOpen ? "rotate-180" : ""}`}
              >
                ▾
              </span>
            </button>
            {tocOpen ? (
              <div className="mt-2 rounded-[12px] border border-[#E9EEF6] bg-white/80 px-4 py-3">
                <ul className="grid gap-1 sm:grid-cols-2">
                  {toc.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`#${item.id}`}
                        onClick={() => setTocOpen(false)}
                        className="block py-0.5 text-[0.84rem] leading-[1.5] text-[#475569] no-underline hover:text-[#1E40AF] hover:underline hover:underline-offset-4"
                      >
                        {item.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </nav>
        ) : null}

        <div className="pt-8">
          {variant === "document" ? (
            <article
              className={`${LEGAL_ARTICLE_TYPOGRAPHY} [&_h2]:scroll-mt-24`}
              data-legal-content
            >
              {children}
            </article>
          ) : (
            <div data-legal-operational-body>{children}</div>
          )}

          {/* RELATED DOCUMENTS — documentation footer panel. */}
          {relatedLinks && relatedLinks.length > 0 ? (
            <footer
              className="mt-14 rounded-[16px] border border-[#E2E8F0] bg-white/70 px-6 py-6"
              data-legal-document-footer
            >
              <nav aria-label="Related documents" data-legal-related-links>
                <div className="text-[0.95rem] font-semibold text-[#0F172A]">
                  Related documents
                </div>
                <div className="mt-4 grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
                  {relatedLinks.slice(0, 4).map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      className="group flex items-start gap-3 no-underline"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#F1F5F9] text-[#64748B]"
                      >
                        <IconDoc />
                      </span>
                      <span className="grid gap-0.5">
                        <span className="text-[0.86rem] font-semibold leading-[1.3] text-[#1D4ED8] group-hover:underline group-hover:underline-offset-4">
                          {l.label}
                        </span>
                        {l.description ? (
                          <span className="text-[0.76rem] leading-[1.5] text-[#64748B]">
                            {l.description}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  ))}
                </div>
              </nav>
              <div className="mt-6 border-t border-[#EEF2F7] pt-5 text-center" data-legal-document-public-action>
                <a
                  href="/trust"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-legal-open-public-trust-center
                  className="inline-flex items-center gap-1.5 text-[0.88rem] font-semibold text-[#2563EB] no-underline hover:text-[#1E40AF] hover:underline hover:underline-offset-4"
                >
                  Open public Trust Center <span aria-hidden="true">↗</span>
                </a>
                <div className={`mt-1 ${LEGAL_META_CLASSES}`}>
                  Opens the public Trust Center in a new tab — this app stays open.
                </div>
              </div>
            </footer>
          ) : null}
        </div>
      </div>
    </div>
  );
}
