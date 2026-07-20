"use client";

/**
 * Canonical AUTHENTICATED legal/trust document shell.
 *
 * 2026-07-20 enterprise-documentation refinement (on top of the
 * 2026-07-19 flat layout): the page reads like a polished internal
 * documentation system —
 *
 *   compact LEFT-aligned document header (back → badges → gradient
 *   title → summary → metadata row with scope + public-version action)
 *   → thin divider
 *   → two-column documentation area: compact sticky "On this page"
 *     navigation + a CENTERED ~760px reading column (overall region
 *     capped at 1140px and centered in the app content area)
 *   → document footer: related documents + public-version action.
 *
 * Still NO marketing hero, NO image background, NO white article card:
 * the document renders directly on the application background through
 * the same zero-drift typography chain as the public /legal/[slug]
 * pages (`LEGAL_ARTICLE_TYPOGRAPHY`).
 *
 * The TOC is built client-side by scanning the rendered article's H2
 * headings (ids are assigned post-mount when missing — trust-center
 * sections already carry ids), so neither the shared markdown renderer
 * nor the public pages change. Documents with fewer than two sections,
 * and the operational variant (status page), render without a TOC.
 *
 * PRESENTATION ONLY. This shell never decides authorization — parents
 * keep their PageRouteGate / org-permission gates, and the scope badge
 * is a label, not a gate.
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
  /**
   * Public counterpart of this document (e.g. `/legal/privacy`). Rendered
   * as the explicitly-labelled public-version action in the header
   * metadata row and the document footer. Leaving the app is always
   * labelled; never pass an internal route here.
   */
  publicVersionHref?: string;
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

type TocItem = { id: string; text: string };

function slugifyHeading(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `section-${index}`;
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
  publicVersionHref,
  variant = "document",
  heroChildren,
  children,
}: LegalDocumentShellProps) {
  const scopeBadge = SCOPE_BADGE_LABEL[scope];
  const scopeMeta = SCOPE_META_LABEL[scope];

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [toc, setToc] = useState<ReadonlyArray<TocItem>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Build the "On this page" navigation from the rendered H2 headings.
  // Client-side only: assigns missing ids without touching the shared
  // renderer (public pages stay byte-identical).
  useEffect(() => {
    if (variant !== "document") return;
    const root = bodyRef.current;
    if (!root) return;
    const headings = Array.from(
      root.querySelectorAll<HTMLHeadingElement>("article[data-legal-content] h2"),
    );
    const seen = new Set<string>();
    const items: TocItem[] = headings.map((h, i) => {
      let id = h.id || slugifyHeading(h.textContent ?? "", i);
      while (seen.has(id)) id = `${id}-${i}`;
      seen.add(id);
      h.id = id;
      return { id, text: (h.textContent ?? "").trim() };
    });
    setToc(items);

    // Active section = the last heading at or above the reading line
    // (just under the sticky app header). Scroll is captured at the
    // document level so any scrollable app container is covered; a
    // low-frequency position watcher backstops environments where
    // scroll events are throttled or suppressed. setActiveId with an
    // unchanged id is a React no-op, so the watcher never causes
    // needless re-renders.
    let frame = 0;
    const updateActive = () => {
      frame = 0;
      let current: string | null = items[0]?.id ?? null;
      for (const item of items) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= 120) current = item.id;
      }
      setActiveId(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(updateActive);
    };
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    const watcher = window.setInterval(updateActive, 400);
    updateActive();
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.clearInterval(watcher);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [variant, children]);

  const showToc = variant === "document" && toc.length >= 2;

  const publicVersionAction = publicVersionHref ? (
    <Link
      href={publicVersionHref}
      data-internal-legal-public-counterpart
      className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-[#2563EB] no-underline hover:text-[#1E40AF] hover:underline hover:underline-offset-4"
    >
      View public version <span aria-hidden="true">↗</span>
    </Link>
  ) : null;

  return (
    <div
      className="legal-document-shell"
      data-legal-document-shell={scope.toLowerCase()}
    >
      <div className="w-full px-6 py-8 md:px-8 md:py-10">
        {/* HEADER — compact console document header, LEFT-aligned. No
            hero image, no gradient panel, no card. */}
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

          {/* Metadata row — updated/type · scope · public-version action. */}
          <div
            className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 ${LEGAL_META_CLASSES}`}
            data-legal-document-meta
          >
            {meta ? <span>{meta}</span> : null}
            {scopeMeta ? (
              <>
                {meta ? <span aria-hidden="true">·</span> : null}
                <span data-legal-document-scope-meta>{scopeMeta}</span>
              </>
            ) : null}
            {publicVersionAction ? (
              <>
                <span aria-hidden="true">·</span>
                {publicVersionAction}
              </>
            ) : null}
          </div>
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

        {/* DOCUMENTATION AREA — centered region; sticky TOC + centered
            narrow reading column. Directly on the app background. */}
        <div
          ref={bodyRef}
          className="mx-auto w-full max-w-[1140px] pt-8"
          data-legal-document-reading-column
        >
          <div
            className={
              showToc
                ? "lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-14"
                : undefined
            }
          >
            {showToc ? (
              <aside className="hidden lg:block">
                <nav
                  aria-label="On this page"
                  data-legal-document-toc
                  className="sticky top-24"
                >
                  <div className="text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                    On this page
                  </div>
                  <ul className="mt-3 grid gap-0.5 border-l border-[#E2E8F0]">
                    {toc.map((item) => (
                      <li key={item.id}>
                        <a
                          href={`#${item.id}`}
                          data-legal-toc-active={activeId === item.id || undefined}
                          className={
                            activeId === item.id
                              ? "-ml-px block border-l-2 border-[#7C3AED] py-1 pl-3 text-[0.82rem] font-semibold leading-[1.4] text-[#0F172A] no-underline"
                              : "block border-l-2 border-transparent py-1 pl-3 text-[0.82rem] leading-[1.4] text-[#64748B] no-underline hover:text-[#0F172A]"
                          }
                        >
                          {item.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
              </aside>
            ) : null}

            <div className="mx-auto w-full max-w-[760px]">
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

              {/* DOCUMENT FOOTER — related documents + public action. */}
              {(relatedLinks && relatedLinks.length > 0) || publicVersionHref ? (
                <footer
                  className="mt-12 border-t border-[#DDE6F2] pt-6"
                  data-legal-document-footer
                >
                  {relatedLinks && relatedLinks.length > 0 ? (
                    <nav aria-label="Related documents" data-legal-related-links>
                      <div className="text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[#64748B]">
                        Related documents
                      </div>
                      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                        {relatedLinks.map((l) => (
                          <li key={l.href}>
                            <Link
                              href={l.href}
                              className="group flex items-center justify-between gap-3 rounded-lg border border-[#E2E8F0] px-3.5 py-2.5 text-[0.9rem] font-medium text-[#0F172A] no-underline transition-colors hover:border-[#7C3AED66] hover:text-[#1E40AF]"
                            >
                              <span>{l.label}</span>
                              <span
                                aria-hidden="true"
                                className="text-[#94A3B8] transition-colors group-hover:text-[#7C3AED]"
                              >
                                →
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </nav>
                  ) : null}

                  {publicVersionAction ? (
                    <div
                      className={`${relatedLinks && relatedLinks.length > 0 ? "mt-6" : ""} flex flex-wrap items-center gap-2`}
                      data-legal-document-public-action
                    >
                      {publicVersionAction}
                      <span className={LEGAL_META_CLASSES}>
                        Same document on the public site (leaves the app).
                      </span>
                    </div>
                  ) : null}
                </footer>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
