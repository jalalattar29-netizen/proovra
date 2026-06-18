"use client";

/**
 * Phase 4A Final Closure — Verify-page trust references consumer.
 *
 * Renders the workspace's published Trust Center / Methodology /
 * AI Disclosure / Security article references + active subprocessor
 * registry, in five collapsed sections, sourced from
 * GET /v1/trust/verify-references (workspace-anchored, requireAuth).
 *
 * Rules:
 *   - This component is a workspace surface. If the call returns
 *     401/403 (no auth / not entitled) or the references are empty,
 *     the component renders nothing (returns null).
 *   - Article bodies are NEVER fetched here. Each row links into the
 *     in-platform Trust Center surface for the full article content.
 *   - Bounded data shape — only title/slug/version (articles) or
 *     name/slug/vendor (subprocessors).
 *
 * data-* anchors (for source-contract tests):
 *   - data-verify-trust-references
 *   - data-verify-trust-section="<kind>"
 *   - data-verify-trust-link="<slug>"
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../lib/api";

type ArticleRef = {
  title: string;
  slug: string;
  version: number | string | null;
};

type SubprocessorRef = {
  name: string;
  slug: string;
  vendor: string | null;
};

type VerifyTrustReferencesResponse = {
  references?: {
    trustCenter?: ArticleRef[] | null;
    methodology?: ArticleRef[] | null;
    aiDisclosure?: ArticleRef[] | null;
    security?: ArticleRef[] | null;
    subprocessors?: SubprocessorRef[] | null;
  } | null;
};

type SectionKind =
  | "trust-center"
  | "methodology"
  | "ai-disclosure"
  | "security"
  | "subprocessors";

type Section = {
  kind: SectionKind;
  title: string;
  href: string;
  rows: ReadonlyArray<{ slug: string; primary: string; meta: string | null }>;
};

const EMPTY_REFS: VerifyTrustReferencesResponse["references"] = {
  trustCenter: [],
  methodology: [],
  aiDisclosure: [],
  security: [],
  subprocessors: [],
};

function articleRows(items?: ArticleRef[] | null) {
  return (items ?? []).map((a) => ({
    slug: a.slug,
    primary: a.title,
    meta: a.version != null ? `v${a.version} • ${a.slug}` : a.slug,
  }));
}

function subprocessorRows(items?: SubprocessorRef[] | null) {
  return (items ?? []).map((s) => ({
    slug: s.slug,
    primary: s.name,
    meta: s.vendor ? `${s.vendor} • ${s.slug}` : s.slug,
  }));
}

export default function VerifyTrustReferences() {
  const [refs, setRefs] = useState<VerifyTrustReferencesResponse["references"] | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState<Record<SectionKind, boolean>>({
    "trust-center": false,
    methodology: false,
    "ai-disclosure": false,
    security: false,
    subprocessors: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiFetch(
          "/v1/trust/verify-references",
          { method: "GET" },
        )) as VerifyTrustReferencesResponse | null;
        if (cancelled) return;
        setRefs(res?.references ?? EMPTY_REFS);
      } catch (err: unknown) {
        if (cancelled) return;
        const status = (err as { statusCode?: number } | null)?.statusCode ?? 0;
        if (status === 401 || status === 403) {
          setDenied(true);
        } else {
          setRefs(EMPTY_REFS);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo<ReadonlyArray<Section>>(() => {
    if (!refs) return [];
    return [
      {
        kind: "trust-center",
        title: "Trust Center",
        href: "/trust",
        rows: articleRows(refs.trustCenter),
      },
      {
        kind: "methodology",
        title: "Methodology",
        href: "/security/trust-center/methodology",
        rows: articleRows(refs.methodology),
      },
      {
        kind: "ai-disclosure",
        title: "AI Disclosure",
        href: "/security/trust-center/ai-disclosure",
        rows: articleRows(refs.aiDisclosure),
      },
      {
        kind: "security",
        title: "Security",
        href: "/security/trust-center/security",
        rows: articleRows(refs.security),
      },
      {
        kind: "subprocessors",
        title: "Subprocessors",
        href: "/security/trust-center/subprocessors",
        rows: subprocessorRows(refs.subprocessors),
      },
    ];
  }, [refs]);

  const toggle = useCallback((kind: SectionKind) => {
    setOpen((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  if (denied || !refs) return null;

  const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
  if (totalRows === 0) return null;

  return (
    <section
      data-verify-trust-references
      style={{
        border: "1px solid rgba(12,28,25,0.18)",
        borderRadius: 18,
        background: "rgba(255,255,255,0.74)",
        padding: 18,
        display: "grid",
        gap: 12,
      }}
    >
      <header style={{ display: "grid", gap: 4 }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 750,
            letterSpacing: "0.085em",
            textTransform: "uppercase",
            color: "rgba(16,32,29,0.68)",
          }}
        >
          Trust references
        </div>
        <div style={{ fontSize: 14, fontWeight: 650, color: "#10201d" }}>
          Workspace-published Trust Center references for this verify view.
        </div>
      </header>

      <div style={{ display: "grid", gap: 8 }}>
        {sections.map((section) => {
          const isOpen = open[section.kind];
          const count = section.rows.length;

          return (
            <div
              key={section.kind}
              data-verify-trust-section={section.kind}
              style={{
                border: "1px solid rgba(12,28,25,0.12)",
                borderRadius: 14,
                background: "rgba(248,250,248,0.82)",
              }}
            >
              <button
                type="button"
                onClick={() => toggle(section.kind)}
                aria-expanded={isOpen}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "12px 14px",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  color: "#10201d",
                  fontSize: 13,
                  fontWeight: 800,
                }}
              >
                <span>
                  {section.title}
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      fontWeight: 700,
                      color: "rgba(16,32,29,0.68)",
                    }}
                  >
                    {count} item{count === 1 ? "" : "s"}
                  </span>
                </span>
                <span
                  aria-hidden
                  style={{
                    fontSize: 11,
                    color: "rgba(16,32,29,0.68)",
                    fontWeight: 700,
                  }}
                >
                  {isOpen ? "Collapse" : "Expand"}
                </span>
              </button>

              {isOpen ? (
                <div
                  style={{
                    padding: "0 14px 12px 14px",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  {count === 0 ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(16,32,29,0.68)",
                        padding: "4px 0",
                      }}
                    >
                      No published items in this section.
                    </div>
                  ) : (
                    section.rows.map((row) => (
                      <Link
                        key={row.slug}
                        href={section.href}
                        data-verify-trust-link={row.slug}
                        style={{
                          display: "grid",
                          gap: 2,
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid rgba(12,28,25,0.10)",
                          background: "rgba(255,255,255,0.78)",
                          color: "#10201d",
                          textDecoration: "none",
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 700 }}>
                          {row.primary}
                        </span>
                        {row.meta ? (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: "rgba(16,32,29,0.68)",
                            }}
                          >
                            {row.meta}
                          </span>
                        ) : null}
                      </Link>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
