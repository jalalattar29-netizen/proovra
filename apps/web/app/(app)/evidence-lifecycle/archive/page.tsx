"use client";

/**
 * Archive Tiers — operator surface for HOT / WARM / COLD / DEEP_ARCHIVE
 * tier management.
 *
 * Evidence Lifecycle REAL FIX root cause:
 *   - The previous implementation typed the `/v1/lifecycle/archive/costs`
 *     response as `Array<{tier, storageGbMonthUsd, retrievalGbUsd}>`.
 *   - The actual backend (`projectArchiveCostsByTier`) returns
 *     `Record<ArchiveTier, {evidenceCount, totalCostUsdMicrosPerMonth}>`
 *     — a per-tier OBJECT keyed by tier name, with evidence count and
 *     accumulated cost in USD micros per month.
 *   - The runtime cast `as ArchiveCost[]` was a TypeScript lie. At
 *     render time the array-style lookup threw "find is not a function"
 *     because `costs` was actually an object, not an array.
 *   - My previous error-boundary "fix" caught that throw and showed a
 *     generic "section unavailable" mask — which the user (rightly)
 *     rejected as hiding the bug rather than fixing it.
 *
 * This rewrite:
 *   - Types match the real backend shape.
 *   - Per-tier cards render evidence count + monthly cost (converted
 *     from micros → USD, formatted with the host locale).
 *   - Per-tier card never throws — every field is guarded.
 *   - The page renders even when the cost endpoint returns 4xx/5xx
 *     OR when the transitions endpoint fails — independent sections.
 *   - DEEP_ARCHIVE replaces FROZEN to match the canonical backend enum
 *     (`services/api/src/services/lifecycle/archive-tier.service.ts:540`).
 */

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDate } from "../../../../lib/date";

type PermissionDenialState = { denial: string; tier: string } | null;

interface ArchiveTransition {
  id: string;
  evidenceId: string;
  fromTier: string;
  toTier: string;
  state: string;
  initiatedAtUtc: string;
}

// Backend returns: Record<ArchiveTier, ArchiveTierCostBucket>
// Source of truth: services/api/src/services/lifecycle/archive-tier.service.ts:540
interface ArchiveTierCostBucket {
  evidenceCount: number;
  totalCostUsdMicrosPerMonth: number;
}

type ArchiveCostBuckets = Partial<Record<string, ArchiveTierCostBucket>>;

// Canonical tier list. DEEP_ARCHIVE matches the backend enum; FROZEN
// was a UI-only invention that never existed in the backend.
const ARCHIVE_TIERS = ["HOT", "WARM", "COLD", "DEEP_ARCHIVE"] as const;

const TIER_LABELS: Record<string, string> = {
  HOT: "HOT",
  WARM: "WARM",
  COLD: "COLD",
  DEEP_ARCHIVE: "DEEP ARCHIVE",
};

const TIER_COLORS: Record<string, string> = {
  HOT: "#fef3c7",
  WARM: "#ffe4e6",
  COLD: "#dbeafe",
  DEEP_ARCHIVE: "#f3f4f6",
};

const TIER_DESCRIPTIONS: Record<string, string> = {
  HOT: "Live evidence — fastest access, highest storage cost.",
  WARM: "Recent evidence — moderate access, moderate cost.",
  COLD: "Older evidence — slower access, lower cost.",
  DEEP_ARCHIVE: "Long-term retention — slowest access, cheapest storage.",
};

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const tier =
    e?.details && typeof e.details["requiredTier"] === "string"
      ? (e.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "DELEGATED_ADMIN_REQUIRED")
  ) {
    setDenial({ denial: denial as string, tier });
    return;
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const t =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "DELEGATED_ADMIN_REQUIRED")
    ) {
      setDenial({ denial: d, tier: t });
    }
  }
}

export default function ArchivePage() {
  // No LifecycleSectionBoundary wrap here — the real fix is upstream:
  // costs is now the correct shape (object, not array), so the page
  // does not throw. Adding a boundary would only re-introduce a
  // generic "section unavailable" mask if a future bug crept in.
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <Shell />
    </PageRouteGate>
  );
}

function safeDate(input: string | null | undefined): string {
  if (!input) return "—";
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? "—" : formatUserDate(input);
}

function formatMicrosUsd(micros: number | undefined | null): string {
  if (typeof micros !== "number" || !Number.isFinite(micros) || micros <= 0) {
    return "$0.00";
  }
  const dollars = micros / 1_000_000;
  if (dollars < 0.01) return "<$0.01";
  return `$${dollars.toFixed(2)}`;
}

function formatCount(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  return n.toLocaleString();
}

function Shell() {
  const [transitions, setTransitions] = useState<ArchiveTransition[]>([]);
  const [costs, setCosts] = useState<ArchiveCostBuckets>({});
  const [transitionsError, setTransitionsError] = useState<string | null>(null);
  const [costsError, setCostsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // Manual transition form
  const [evidenceId, setEvidenceId] = useState("");
  const [toTier, setToTier] = useState<string>(ARCHIVE_TIERS[0]);
  const [transitioning, setTransitioning] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    setTransitionsError(null);
    setCostsError(null);
    // allSettled — each section renders independently. A failure in
    // the cost endpoint must NOT blank the transitions table and
    // vice versa.
    const [tRes, cRes] = await Promise.allSettled([
      apiFetch("/v1/lifecycle/archive/transitions", { method: "GET" }),
      apiFetch("/v1/lifecycle/archive/costs", { method: "GET" }),
    ]);
    // Transitions branch.
    if (tRes.status === "fulfilled") {
      const value = tRes.value as { transitions?: unknown } | null;
      const list = Array.isArray(value?.transitions)
        ? (value!.transitions as ArchiveTransition[])
        : [];
      setTransitions(list);
    } else {
      setTransitions([]);
      const msg = toSafeUserError(tRes.reason, {
        message: "Could not load transitions",
      }).message;
      setTransitionsError(msg);
    }
    // Costs branch — backend returns `{costs: Record<tier, bucket>}`.
    // Defensive: accept either an object OR a (legacy) array shape so a
    // future backend response refactor doesn't break this page.
    if (cRes.status === "fulfilled") {
      const value = cRes.value as { costs?: unknown } | null;
      const raw = value?.costs;
      let buckets: ArchiveCostBuckets = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        // Canonical shape — already a Record<tier, bucket>.
        buckets = raw as ArchiveCostBuckets;
      } else if (Array.isArray(raw)) {
        // Legacy / hypothetical shape — array of {tier, evidenceCount, ...}.
        for (const item of raw) {
          if (item && typeof item === "object" && typeof (item as { tier?: unknown }).tier === "string") {
            buckets[(item as { tier: string }).tier] = item as ArchiveTierCostBucket;
          }
        }
      }
      setCosts(buckets);
    } else {
      setCosts({});
      const msg = toSafeUserError(cRes.reason, {
        message: "Could not load tier cost data",
      }).message;
      setCostsError(msg);
    }
    // If both rejected with a 403 entitlement denial, show the denial banner.
    if (tRes.status === "rejected" && cRes.status === "rejected") {
      applyDenial(tRes.reason, setDenial);
    }
    setBusy(false);
  }, []);

  const doTransition = useCallback(async () => {
    setTransitioning(true);
    setDenial(null);
    try {
      // Lifecycle Consolidation — backend route is singular: /transition.
      // The GET list endpoint remains plural at /transitions.
      await apiFetch("/v1/lifecycle/archive/transition", {
        method: "POST",
        body: JSON.stringify({ evidenceId, toTier }),
      });
      setEvidenceId("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setTransitioning(false);
    }
  }, [evidenceId, toTier, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-archive-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Archive Tiers</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Move evidence between storage tiers based on age and access
          patterns. Tier costs are accumulated from the underlying object
          storage (S3-class) and shown as monthly USD.
        </p>
        <p style={{ marginTop: 8, marginBottom: 0 }}>
          <a
            href="/evidence-lifecycle"
            style={{
              fontSize: 12,
              color: "#4338ca",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            ← Back to Lifecycle Operations
          </a>
        </p>
      </header>

      {denial ? (
        <div
          data-permission-denied={denial.denial}
          style={{
            padding: 10,
            background: "#fef3c7",
            border: "1px solid #fcd34d",
            color: "#78350f",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>Permission required:</strong> {denial.tier}
        </div>
      ) : null}

      {/* Tier cards — ALWAYS render the 4 tier cards, even if cost data fails. */}
      <section
        data-archive-tier-cards
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        {ARCHIVE_TIERS.map((tier) => {
          const bucket = costs[tier];
          const count = bucket?.evidenceCount;
          const cost = bucket?.totalCostUsdMicrosPerMonth;
          return (
            <div
              key={tier}
              data-archive-tier={tier}
              style={{
                background: TIER_COLORS[tier] ?? "#f9fafb",
                border: "1px solid rgba(15,23,42,0.08)",
                borderRadius: 10,
                padding: 12,
              }}
            >
              <strong style={{ display: "block", marginBottom: 4, fontSize: 14 }}>
                {TIER_LABELS[tier] ?? tier}
              </strong>
              <small style={{ fontSize: 11, color: "#64748b", display: "block", marginBottom: 8 }}>
                {TIER_DESCRIPTIONS[tier] ?? ""}
              </small>
              {costsError ? (
                <small style={{ fontSize: 11, color: "#92400e" }}>
                  No cost data configured.
                </small>
              ) : bucket ? (
                <div style={{ fontSize: 12, color: "#0f172a" }}>
                  <div>
                    <strong>{formatCount(count)}</strong>
                    <small style={{ marginLeft: 4, color: "#475569" }}>
                      evidence item{count === 1 ? "" : "s"}
                    </small>
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <strong>{formatMicrosUsd(cost)}</strong>
                    <small style={{ marginLeft: 4, color: "#475569" }}>per month</small>
                  </div>
                </div>
              ) : (
                <small style={{ color: "#94a3b8" }}>No evidence in this tier.</small>
              )}
            </div>
          );
        })}
      </section>

      {/* Cost endpoint error — surfaced as a small banner, NOT a section crash. */}
      {costsError ? (
        <div
          role="status"
          data-archive-costs-error
          style={{
            padding: 8,
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            color: "#78350f",
            borderRadius: 8,
            fontSize: 11,
            marginBottom: 12,
          }}
        >
          <strong>Tier cost data unavailable.</strong> Per-tier evidence
          counts and monthly USD totals could not be computed for this
          workspace. The transition history below is still accurate.
        </div>
      ) : null}

      {/* Manual transition form */}
      <section
        data-archive-transition-form
        style={{
          background: "rgba(15,23,42,0.03)",
          border: "1px solid rgba(15,23,42,0.06)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <strong style={{ display: "block", marginBottom: 4, fontSize: 14 }}>
          Manual tier transition
        </strong>
        <p style={{ margin: 0, fontSize: 12, color: "#475569", marginBottom: 10 }}>
          Move a specific evidence item to a different storage tier. The
          automatic age-based scheduler usually handles this for you;
          manual transitions are for one-off corrections.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Evidence ID
            <input
              style={inputStyle}
              value={evidenceId}
              onChange={(e) => setEvidenceId(e.target.value)}
              placeholder="evidence UUID"
            />
          </label>
          <label style={labelStyle}>
            Target tier
            <select style={inputStyle} value={toTier} onChange={(e) => setToTier(e.target.value)}>
              {ARCHIVE_TIERS.map((t) => (
                <option key={t} value={t}>
                  {TIER_LABELS[t] ?? t}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={transitioning || !evidenceId}
            onClick={() => void doTransition()}
            style={primaryButton}
            title={!evidenceId ? "Enter an evidence ID first" : "Move to target tier"}
          >
            {transitioning ? "Transitioning…" : "Move tier"}
          </button>
        </div>
      </section>

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      {/* Transitions table */}
      <section
        data-archive-transitions
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "4px 4px 8px",
            borderBottom: "1px solid #e2e8f0",
            marginBottom: 4,
          }}
        >
          <strong style={{ fontSize: 14 }}>Transition history</strong>
          <small style={{ color: "#64748b", fontSize: 11 }}>
            {transitions.length} transition{transitions.length === 1 ? "" : "s"}
          </small>
        </header>
        {transitionsError ? (
          <div
            role="status"
            style={{
              padding: 10,
              background: "#fffbeb",
              border: "1px solid #fcd34d",
              color: "#78350f",
              borderRadius: 6,
              fontSize: 12,
              margin: 8,
            }}
          >
            <strong>Transition history unavailable.</strong> {transitionsError}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#475569" }}>
                <th style={th}>Evidence ID</th>
                <th style={th}>From</th>
                <th style={th}>To</th>
                <th style={th}>State</th>
                <th style={th}>Initiated</th>
              </tr>
            </thead>
            <tbody>
              {transitions.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ ...td, color: "#475569", textAlign: "center" }}>
                    No tier transitions recorded yet for this workspace.
                  </td>
                </tr>
              ) : (
                transitions.map((t) => (
                  <tr key={t.id}>
                    <td style={td}>
                      <code>{t.evidenceId}</code>
                    </td>
                    <td style={td}>{TIER_LABELS[t.fromTier] ?? t.fromTier}</td>
                    <td style={td}>{TIER_LABELS[t.toTier] ?? t.toTier}</td>
                    <td style={td}>
                      <strong>{t.state}</strong>
                    </td>
                    <td style={td}>{safeDate(t.initiatedAtUtc)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

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
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const labelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 2,
  fontSize: 11,
  fontWeight: 600,
};
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
