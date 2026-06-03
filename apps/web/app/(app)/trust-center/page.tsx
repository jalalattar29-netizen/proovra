"use client";

/**
 * PROOVRA Phase 4A — Trust Center landing.
 *
 * Article-driven, versioned, auditable. Renders the 15 required
 * sections sourced from the trust_center_articles table. Each
 * section anchored for source-contract tests.
 */

import { useCallback, useEffect, useState } from "react";

import type {
  StatusPageProjection,
  SubprocessorProjection,
  TrustArticleProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../lib/api";
import { DriftBadge } from "./_drift-badge";

export default function TrustCenterPage() {
  return (
    <PageRouteGate routeId="workspace.trust_center">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [articles, setArticles] = useState<ReadonlyArray<TrustArticleProjection>>([]);
  const [busy, setBusy] = useState(false);
  // Bounded operator status surface so the user can tell whether a
  // seed action actually succeeded (the previous implementation
  // silently swallowed every error — clicking the button looked
  // identical to a failed call). Vocabulary kept platform-bounded;
  // we never expose env names or stack traces here.
  const [seedStatus, setSeedStatus] = useState<string | null>(null);
  // Optional chip data for the 7-tile summary band. We reuse the
  // already-available Trust Center APIs (no new routes). Each chip
  // is independently optional — if the corresponding fetch fails the
  // tile still renders without its chip, never blocking the band.
  const [subprocessorCount, setSubprocessorCount] = useState<number | null>(
    null,
  );
  const [overallHealth, setOverallHealth] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/v1/trust/articles?kind=TRUST_CENTER", {
        method: "GET",
      });
      setArticles(
        (res?.articles ?? []) as ReadonlyArray<TrustArticleProjection>,
      );
    } catch {
      setArticles([]);
    } finally {
      setBusy(false);
    }
  }, []);

  // Lightweight chip refresh — independent of the article refresh so
  // a single failed call never blanks the rest of the band. Uses the
  // existing /v1/trust/subprocessors and /v1/trust/status endpoints
  // (already auto-seed on GET).
  const refreshChips = useCallback(async () => {
    const [subRes, statusRes] = await Promise.allSettled([
      apiFetch("/v1/trust/subprocessors", { method: "GET" }),
      apiFetch("/v1/trust/status", { method: "GET" }),
    ]);
    if (subRes.status === "fulfilled") {
      const rows = (subRes.value?.subprocessors ?? []) as ReadonlyArray<
        SubprocessorProjection
      >;
      // "Active" mirrors the subprocessor registry's own state
      // vocabulary — count only ACTIVE rows so the chip never
      // overcounts withdrawn or pending entries.
      setSubprocessorCount(
        rows.filter((r) => r.state === "ACTIVE").length,
      );
    }
    if (statusRes.status === "fulfilled") {
      const proj = (statusRes.value?.status ?? null) as
        | StatusPageProjection
        | null;
      setOverallHealth(proj?.overallHealth ?? null);
    }
  }, []);

  const seedDefaults = useCallback(async () => {
    setBusy(true);
    setSeedStatus(null);
    // Production fix — the "Re-seed defaults" promise covers BOTH
    // articles (15+9+12+18 canonical sections) AND subprocessors.
    // The prior implementation only POSTed to /v1/trust/articles/seed,
    // so subprocessors stayed empty across the Trust Center even
    // after the user clicked the canonical action.
    //
    // Run both in parallel — neither blocks the other. Each result
    // is honestly surfaced; a failure is reported, not swallowed.
    const [articleResult, subprocessorResult] = await Promise.allSettled([
      apiFetch("/v1/trust/articles/seed", { method: "POST" }),
      apiFetch("/v1/trust/subprocessors/seed", { method: "POST" }),
    ]);
    const partsA = summarisePart(articleResult, "articles");
    const partsB = summarisePart(subprocessorResult, "subprocessors");
    setSeedStatus(`${partsA} · ${partsB}`);
    await refresh();
    setBusy(false);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    void refreshChips();
  }, [refresh, refreshChips]);

  return (
    <div
      data-trust-center
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Trust Center</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Versioned platform-trust documentation sourced from PROOVRA's
          actual implementation. Every section auditable.
        </p>
        <nav
          data-trust-center-nav
          style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}
        >
          <a data-trust-link="methodology" href="/trust-center/methodology" style={navLink}>
            Methodology
          </a>
          <a data-trust-link="ai-disclosure" href="/trust-center/ai-disclosure" style={navLink}>
            AI Disclosure
          </a>
          <a data-trust-link="security" href="/trust-center/security" style={navLink}>
            Security
          </a>
          <a data-trust-link="subprocessors" href="/trust-center/subprocessors" style={navLink}>
            Subprocessors
          </a>
          <a data-trust-link="status" href="/trust-center/status" style={navLink}>
            Status
          </a>
        </nav>
      </header>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <button
          type="button"
          data-trust-center-refresh
          onClick={() => void refresh()}
          disabled={busy}
          style={primaryButton}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
        <button
          type="button"
          data-trust-center-seed
          onClick={() => void seedDefaults()}
          disabled={busy}
          style={secondaryButton}
        >
          Re-seed defaults
        </button>
        {seedStatus ? (
          <small
            data-trust-center-seed-status
            style={{ fontSize: 11, color: "#475569" }}
          >
            {seedStatus}
          </small>
        ) : null}
      </div>

      {/*
        Phase 4A enterprise polish — 7-tile summary band. Sits ABOVE
        the canonical 15-article grid. Tiles surface the entry points
        an enterprise reviewer expects on a Trust Center landing page
        (methodology, AI transparency, security, subprocessors, status,
        legal, verification). No new routes — every target already
        exists in the app. Each tile carries a data-trust-center-
        summary-tile attribute so source-contract tests can pin them.
      */}
      <section
        data-trust-center-summary-band
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 10,
          marginBottom: 18,
        }}
      >
        <SummaryTile
          slug="methodology"
          title="Verification Methodology"
          subtitle="Hashing, OpenTimestamps, provenance chain, verification packages."
          href="/trust-center/methodology"
          secondary={{
            href: "/legal/verification-methodology",
            label: "Legal methodology",
          }}
        />
        <SummaryTile
          slug="ai-disclosure"
          title="AI Transparency"
          subtitle="Models, providers, advisory scope, opt-outs, audit transparency."
          href="/trust-center/ai-disclosure"
        />
        <SummaryTile
          slug="security"
          title="Security Controls"
          subtitle="Authentication, encryption posture, secrets, incident response."
          href="/trust-center/security"
        />
        <SummaryTile
          slug="subprocessors"
          title="Subprocessors"
          subtitle="Vendors that may process customer data, with state + region."
          href="/trust-center/subprocessors"
          chip={
            subprocessorCount !== null
              ? `${subprocessorCount} active`
              : undefined
          }
        />
        <SummaryTile
          slug="status"
          title="Platform Status"
          subtitle="Operational health across PROOVRA components + incidents."
          href="/trust-center/status"
          chip={overallHealth ?? undefined}
        />
        <SummaryTile
          slug="legal"
          title="Legal & Privacy"
          subtitle="Privacy, terms, DPA, evidence-handling, retention, incident response."
          href="/legal/privacy"
          secondary={{ href: "/legal/dpa", label: "DPA" }}
          tertiary={{
            href: "/legal/evidence-handling",
            label: "Evidence handling",
          }}
        />
        <SummaryTile
          slug="verify"
          title="Verification References"
          subtitle="Verify a verification package or evidence reference directly."
          href="/verify"
        />
      </section>

      <h2
        data-trust-center-articles-heading
        style={{ fontSize: 16, margin: "0 0 8px" }}
      >
        Trust Center articles
      </h2>

      {articles.length === 0 ? (
        <p style={{ color: "#475569", fontSize: 12 }}>
          No published articles. Click "Re-seed defaults" to publish the 15
          canonical sections.
        </p>
      ) : (
        <div
          data-trust-center-section-list
          style={{ display: "grid", gap: 10 }}
        >
          {articles.map((a) => (
            <article
              key={a.id}
              data-trust-center-section={a.section}
              data-trust-article-state={a.state}
              data-trust-article-version={a.version}
              style={cardStyle}
            >
              <header
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                }}
              >
                <strong style={{ fontSize: 15 }}>{a.title}</strong>
                <small style={{ fontSize: 11, color: "#475569" }}>
                  <code>{a.section}</code> · v{a.version} · {a.state}
                  {a.driftState ? <DriftBadge state={a.driftState} /> : null}
                </small>
              </header>
              <p style={{ color: "#334155", fontSize: 13, marginTop: 6 }}>
                {a.summary}
              </p>
              {a.implementationReferences.length > 0 ? (
                <small style={{ fontSize: 11, color: "#475569" }}>
                  References:{" "}
                  {a.implementationReferences.map((r) => (
                    <code key={r} style={{ marginRight: 6 }}>
                      {r}
                    </code>
                  ))}
                </small>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// Bounded vocabulary helper. Turns a Promise.allSettled outcome into
// "<label>: created N updated M" or "<label>: failed". Never leaks
// stack traces / env names / internal error codes.
function summarisePart(
  outcome: PromiseSettledResult<unknown>,
  label: string,
): string {
  if (outcome.status === "rejected") return `${label}: failed`;
  const v = outcome.value as
    | { created?: number; updated?: number }
    | null
    | undefined;
  const created = typeof v?.created === "number" ? v.created : 0;
  const updated = typeof v?.updated === "number" ? v.updated : 0;
  return `${label}: ${created} created · ${updated} updated`;
}

// Phase 4A enterprise polish — a single tile in the summary band.
// Honest UI: chip only renders when data is available. Secondary /
// tertiary links are optional and only render when supplied.
function SummaryTile({
  slug,
  title,
  subtitle,
  href,
  chip,
  secondary,
  tertiary,
}: {
  slug: string;
  title: string;
  subtitle: string;
  href: string;
  chip?: string;
  secondary?: { href: string; label: string };
  tertiary?: { href: string; label: string };
}) {
  return (
    <article
      data-trust-center-summary-tile={slug}
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>{title}</strong>
        {chip ? (
          <span
            data-trust-center-summary-chip={slug}
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 6px",
              borderRadius: 999,
              background: "rgba(15, 23, 42, 0.06)",
              color: "#0f172a",
              border: "1px solid rgba(15, 23, 42, 0.08)",
              whiteSpace: "nowrap",
            }}
          >
            {chip}
          </span>
        ) : null}
      </header>
      <p style={{ fontSize: 12, color: "#475569", margin: 0 }}>{subtitle}</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
        <a
          data-trust-center-summary-link={slug}
          href={href}
          style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}
        >
          Open →
        </a>
        {secondary ? (
          <a
            data-trust-center-summary-secondary={slug}
            href={secondary.href}
            style={{ fontSize: 12, color: "#475569" }}
          >
            {secondary.label}
          </a>
        ) : null}
        {tertiary ? (
          <a
            data-trust-center-summary-tertiary={slug}
            href={tertiary.href}
            style={{ fontSize: 12, color: "#475569" }}
          >
            {tertiary.label}
          </a>
        ) : null}
      </div>
    </article>
  );
}

const cardStyle = {
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  padding: 12,
} as const;
const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const secondaryButton = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const navLink = {
  fontSize: 12,
  color: "#0f172a",
  textDecoration: "underline",
  fontWeight: 600,
} as const;
