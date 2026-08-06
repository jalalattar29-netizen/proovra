"use client";

/**
 * Lifecycle Operations console (Surface A).
 *
 * This page is the MUTATION-FIRST operator surface for the Phase 4B
 * lifecycle capabilities (retention, legal holds, archive, destruction,
 * webhooks, chain transfers). The read-only governance posture overlay
 * lives at /governance/lifecycle (Surface B) — both surfaces are
 * preserved per the Lifecycle Consolidation audit (Option D).
 *
 * Hard rules:
 *   - The page MUST NOT get stuck on "Loading…" — every fetch outcome
 *     is mapped to one of 7 explicit phases.
 *   - The dashboard envelope is `{ dashboard: {...} }`. Unwrap it and
 *     normalize a backward-compat fallback where the body itself
 *     already contains the projection fields.
 *   - When the backend reports `capabilities`, surface the bounded
 *     status chip per tile so the operator knows whether each
 *     capability is FULLY_OPERATIONAL, CONFIGURATION_ONLY,
 *     WRITES_BUT_NOT_ENFORCED, READ_ONLY, or DISABLED.
 *   - Mutation buttons on the landing-page tiles are gated by capability
 *     status (DISABLED/WRITES_BUT_NOT_ENFORCED disables, tooltip shows
 *     the bounded reason). Sub-tab gating is documented debt — those
 *     pages can opt-in via the exported `useLifecycleCapability` helper.
 */

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../components/ui/PageShell";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { apiFetch, ApiError } from "../../../lib/api";
import { LifecycleSectionBoundary } from "./_shared";
// PHASE 12B (Evidence Operations) — the lifecycle console is the home for
// the dedicated policy-violation observability reads and the bounded
// verification-package manifest preview.
import { PolicyViolationsPanel } from "./_policy-violations-panel";
import { VerificationPackagePreviewPanel } from "./_verification-package-preview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ViolationsByCode {
  POLICY_VIOLATION_ENTITLEMENT: number;
  POLICY_VIOLATION_LEGAL_HOLD: number;
  POLICY_VIOLATION_RETENTION: number;
  POLICY_VIOLATION_QUOTA: number;
}

interface LifecycleViolations {
  totalLegalHoldViolations: number;
  totalRetentionViolations: number;
  byCode?: ViolationsByCode;
  totalBounded?: number;
}

type LifecycleCapabilityStatus =
  | "FULLY_OPERATIONAL"
  | "READ_ONLY"
  | "CONFIGURATION_ONLY"
  | "WRITES_BUT_NOT_ENFORCED"
  | "DISABLED";

interface LifecycleCapabilityState {
  status: LifecycleCapabilityStatus;
  reason?: string;
}

interface LifecycleDashboardCapabilities {
  retention: LifecycleCapabilityState;
  legalHolds: LifecycleCapabilityState;
  archive: LifecycleCapabilityState;
  destruction: LifecycleCapabilityState;
  webhooks: LifecycleCapabilityState;
  chainTransfers: LifecycleCapabilityState;
}

interface LifecycleDashboard {
  retention: Record<string, number>;
  legalHolds: Record<string, number>;
  archive: Record<string, number>;
  destruction: Record<string, number>;
  upcomingExpirations: Record<string, number>;
  violations: LifecycleViolations;
  capabilities?: LifecycleDashboardCapabilities;
  /**
   * Evidence Lifecycle Final Fix — backend signals when the projection
   * was wrapped in a defensive try/catch and returned an empty shape
   * (e.g. workspace just provisioned, transient Prisma error). The UI
   * renders the dashboard chrome + a small degraded banner instead of
   * the previous hard red-error banner that blanked the page.
   */
  degraded?: boolean;
  degradedReason?: string;
  /**
   * Evidence Lifecycle REAL FIX — backend reports whether the workspace
   * lacks the FEATURE_LIFECYCLE_DASHBOARD entitlement WITHOUT failing
   * the whole page. Surfaced as a soft "upgrade" callout rather than a
   * 403 error.
   */
  entitlementMissing?: boolean;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "loaded"; dashboard: LifecycleDashboard }
  | { phase: "empty" }
  | { phase: "error"; message: string }
  | { phase: "entitlement-required"; missingFeature?: string }
  | { phase: "delegated-admin-required"; requiredTier?: string }
  | { phase: "needs-setup"; missingFlags?: string[] };

// ---------------------------------------------------------------------------
// Sub-pages (preserved navigation; URLs unchanged)
// ---------------------------------------------------------------------------

const SUB_PAGES: ReadonlyArray<{
  href: string;
  label: string;
  capabilityKey: keyof LifecycleDashboardCapabilities;
}> = [
  { href: "/evidence-lifecycle/retention", label: "Retention", capabilityKey: "retention" },
  { href: "/evidence-lifecycle/legal-holds", label: "Legal Holds", capabilityKey: "legalHolds" },
  { href: "/evidence-lifecycle/archive", label: "Archive", capabilityKey: "archive" },
  { href: "/evidence-lifecycle/destruction", label: "Destruction", capabilityKey: "destruction" },
  { href: "/evidence-lifecycle/webhooks", label: "Webhooks", capabilityKey: "webhooks" },
  { href: "/evidence-lifecycle/chain-transfers", label: "Chain Transfers", capabilityKey: "chainTransfers" },
];

// ---------------------------------------------------------------------------
// Capability vocabulary — bounded operator-facing labels
// ---------------------------------------------------------------------------

const CAPABILITY_LABEL: Record<LifecycleCapabilityStatus, string> = {
  FULLY_OPERATIONAL: "Active",
  READ_ONLY: "Read-only",
  CONFIGURATION_ONLY: "Configured (worker disabled)",
  WRITES_BUT_NOT_ENFORCED: "Writes logged, enforcement off",
  DISABLED: "Disabled",
};

const CAPABILITY_COLOR: Record<LifecycleCapabilityStatus, [string, string, string]> = {
  // [bg, border, color]
  FULLY_OPERATIONAL: ["#ecfdf5", "#bbf7d0", "#166534"],
  READ_ONLY: ["#eff6ff", "#bfdbfe", "#1e40af"],
  CONFIGURATION_ONLY: ["#fffbeb", "#fcd34d", "#92400e"],
  WRITES_BUT_NOT_ENFORCED: ["#fff7ed", "#fed7aa", "#9a3412"],
  DISABLED: ["#f8fafc", "#e2e8f0", "#475569"],
};

function isMutationAllowed(state: LifecycleCapabilityState | undefined): boolean {
  if (!state) return true; // absence-tolerant — older backends don't send capabilities.
  return state.status !== "DISABLED" && state.status !== "WRITES_BUT_NOT_ENFORCED";
}

// ---------------------------------------------------------------------------
// Envelope normalisation
//
// Backend sends `{ dashboard: {...} }`. Some older clients or test fixtures
// may emit the projection inline. Tolerate both shapes WITHOUT leaking the
// raw response into UI on unexpected shapes.
// ---------------------------------------------------------------------------

function emptyDashboard(): LifecycleDashboard {
  return {
    retention: {},
    legalHolds: {},
    archive: {},
    destruction: {},
    upcomingExpirations: {},
    violations: {
      totalLegalHoldViolations: 0,
      totalRetentionViolations: 0,
      byCode: {
        POLICY_VIOLATION_ENTITLEMENT: 0,
        POLICY_VIOLATION_LEGAL_HOLD: 0,
        POLICY_VIOLATION_RETENTION: 0,
        POLICY_VIOLATION_QUOTA: 0,
      },
      totalBounded: 0,
    },
  };
}

function normaliseDashboard(res: unknown): LifecycleDashboard {
  // Evidence Lifecycle Final Fix — NEVER return null. The dashboard
  // UI must render its chrome (tiles, capability launcher, refresh
  // button) even when the body is malformed or empty; a missing tile
  // group just becomes "No data" rather than an error page.
  if (!res || typeof res !== "object") return emptyDashboard();
  const obj = res as Record<string, unknown>;
  const candidate =
    obj.dashboard && typeof obj.dashboard === "object"
      ? (obj.dashboard as Record<string, unknown>)
      : "retention" in obj || "legalHolds" in obj || "archive" in obj
        ? obj
        : null;
  if (!candidate) {
    // Backend returned 200 with a shape we don't recognise — degrade
    // gracefully into an empty projection labelled as such, so the
    // operator still sees the console rather than a red banner.
    const base = emptyDashboard();
    base.degraded = true;
    base.degradedReason =
      "Backend returned an unexpected dashboard shape — counts hidden until it recovers.";
    return base;
  }
  // Merge candidate over a fully-typed empty base so every tile group
  // is always present and Object.entries is safe.
  const base = emptyDashboard();
  return { ...base, ...(candidate as Partial<LifecycleDashboard>) };
}

// ---------------------------------------------------------------------------
// Error → LoadState mapping
// ---------------------------------------------------------------------------

function mapErrorToState(err: unknown): LoadState {
  // ApiError (canonical) — denial details land in `details.denial`.
  if (err instanceof ApiError) {
    const denial =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    if (err.statusCode === 403 && denial === "ENTITLEMENT_REQUIRED") {
      const missingFeature =
        err.details && typeof err.details["entitlement"] === "string"
          ? (err.details["entitlement"] as string)
          : err.details && typeof err.details["requiredEntitlement"] === "string"
            ? (err.details["requiredEntitlement"] as string)
            : undefined;
      return { phase: "entitlement-required", missingFeature };
    }
    if (err.statusCode === 403 && denial === "DELEGATED_ADMIN_REQUIRED") {
      const requiredTier =
        err.details && typeof err.details["requiredTier"] === "string"
          ? (err.details["requiredTier"] as string)
          : "DELEGATED_ADMIN";
      return { phase: "delegated-admin-required", requiredTier };
    }
  }
  // Generic shape (fetch/init errors that aren't ApiError but carry statusCode).
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  if (
    e?.statusCode === 403 &&
    e?.details &&
    typeof e.details["denial"] === "string"
  ) {
    const denial = e.details["denial"] as string;
    if (denial === "ENTITLEMENT_REQUIRED") {
      return {
        phase: "entitlement-required",
        missingFeature:
          typeof e.details["entitlement"] === "string"
            ? (e.details["entitlement"] as string)
            : undefined,
      };
    }
    if (denial === "DELEGATED_ADMIN_REQUIRED") {
      return {
        phase: "delegated-admin-required",
        requiredTier:
          typeof e.details["requiredTier"] === "string"
            ? (e.details["requiredTier"] as string)
            : "DELEGATED_ADMIN",
      };
    }
  }
  return {
    phase: "error",
    message: "Lifecycle Operations could not be loaded. Press Retry.",
  };
}

// ---------------------------------------------------------------------------
// Page entry point + route gate
// ---------------------------------------------------------------------------

export default function EvidenceLifecyclePage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <Shell />
    </PageRouteGate>
  );
}

// ---------------------------------------------------------------------------
// Shell — state machine + render
// ---------------------------------------------------------------------------

function Shell() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setState({ phase: "loading" });
    try {
      const res = await apiFetch("/v1/lifecycle/dashboard", { method: "GET" });
      // normaliseDashboard NEVER returns null — it degrades gracefully
      // into an empty projection so the operator always sees the console
      // chrome. Real auth/entitlement failures still flow through catch.
      const projection = normaliseDashboard(res);
      setState({ phase: "loaded", dashboard: projection });
    } catch (err) {
      // Evidence Lifecycle REAL FIX — the dashboard MUST render even on
      // unexpected backend failures. The previous behaviour ("Unable to
      // load lifecycle dashboard" red error) was unacceptable because it
      // gave the operator no usable surface. We map every non-auth error
      // into a degraded empty dashboard with a soft amber banner naming
      // the failure; AUTH/ENTITLEMENT_REQUIRED still go to their
      // dedicated structured panels.
      const mapped = mapErrorToState(err);
      if (
        mapped.phase === "entitlement-required" ||
        mapped.phase === "delegated-admin-required"
      ) {
        setState(mapped);
      } else if (mapped.phase === "error") {
        const empty = emptyDashboard();
        empty.degraded = true;
        empty.degradedReason = mapped.message;
        setState({ phase: "loaded", dashboard: empty });
      } else {
        setState(mapped);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buttonLabel = busy
    ? "Loading…"
    : state.phase === "error"
      ? "Retry"
      : "Refresh";

  return (
    <PageShell
      data-evidence-lifecycle
      data-evidence-lifecycle-phase={state.phase}
      header={
        <PageHeader
          eyebrow="Evidence Lifecycle"
          title="Lifecycle Operations"
          subtitle="Mutation-first operator console for retention, legal holds, archive tiers, destruction, webhooks, and chain transfers."
          primaryAction={
            <Button
              type="button"
              variant="primary"
              data-evidence-lifecycle-refresh
              loading={busy}
              disabled={busy}
              onClick={() => void refresh()}
            >
              {buttonLabel}
            </Button>
          }
          contextStrip={
            <nav
              style={{
                display: "flex",
                gap: 10,
                flexWrap: "wrap",
                alignItems: "center",
                width: "100%",
              }}
            >
              {SUB_PAGES.map(({ href, label }) => (
                <a key={href} href={href} style={navLink}>
                  {label}
                </a>
              ))}
              <span style={{ flex: 1 }} />
              <a
                href="/governance/lifecycle"
                data-lifecycle-cross-link
                style={crossLinkStyle}
              >
                Open Governance Posture →
              </a>
            </nav>
          }
        />
      }
    >
      <div
        data-lifecycle-copy-callout
        style={{
          background: "#eff6ff",
          border: "1px solid #bfdbfe",
          color: "#1e3a8a",
          padding: "8px 10px",
          borderRadius: 8,
          fontSize: 12,
        }}
      >
        This console is for lifecycle actions. For read-only lifecycle posture
        and governance overview, open{" "}
        <a
          href="/governance/lifecycle"
          style={{ color: "#1e3a8a", fontWeight: 600, textDecoration: "underline" }}
        >
          Governance Posture
        </a>
        .
      </div>

      {state.phase === "loading" ? (
        <div data-evidence-lifecycle-state="loading" style={mutedNoteStyle}>
          Loading lifecycle dashboard…
        </div>
      ) : null}

      {state.phase === "empty" ? (
        <div data-evidence-lifecycle-state="empty" style={mutedNoteStyle}>
          No lifecycle activity recorded yet for this workspace.
        </div>
      ) : null}

      {/*
        Evidence Lifecycle REAL FIX — the old hard red-error banner was
        unacceptable: the operator got NO usable surface on any transient
        backend hiccup. That phase no longer fires for generic errors —
        refresh() now converts them into a degraded LoadedDashboard with
        a soft banner. Only auth/entitlement structured panels remain
        below. If this branch ever fires (defensive path), we still show
        the chrome + a soft note rather than a red error.
      */}
      {state.phase === "error" ? (
        <div data-evidence-lifecycle-state="error" style={noticeBoxStyle}>
          <strong>Lifecycle activity counts unavailable.</strong>
          <div style={{ marginTop: 4 }}>{state.message}</div>
        </div>
      ) : null}

      {state.phase === "entitlement-required" ? (
        <div
          data-evidence-lifecycle-state="entitlement-required"
          data-permission-denied="ENTITLEMENT_REQUIRED"
          style={denialBoxStyle}
        >
          <strong>Entitlement required.</strong>
          <div style={{ marginTop: 4 }}>
            Lifecycle Operations requires the{" "}
            <code>{state.missingFeature ?? "FEATURE_LIFECYCLE_DASHBOARD"}</code>{" "}
            entitlement on this workspace.
          </div>
        </div>
      ) : null}

      {state.phase === "delegated-admin-required" ? (
        <div
          data-evidence-lifecycle-state="delegated-admin-required"
          data-permission-denied="DELEGATED_ADMIN_REQUIRED"
          style={denialBoxStyle}
        >
          <strong>Permission required:</strong> {state.requiredTier ?? "DELEGATED_ADMIN"}
          <div style={{ marginTop: 4, fontSize: 12 }}>
            Ask a workspace administrator with the required delegated tier to
            grant access.
          </div>
        </div>
      ) : null}

      {state.phase === "needs-setup" ? (
        <div data-evidence-lifecycle-state="needs-setup" style={noticeBoxStyle}>
          <strong>Lifecycle Operations needs setup.</strong>
          <div style={{ marginTop: 4 }}>
            One or more lifecycle workers are not enabled
            {state.missingFlags && state.missingFlags.length > 0
              ? `: ${state.missingFlags.join(", ")}`
              : "."}
          </div>
        </div>
      ) : null}

      {state.phase === "loaded" ? (
        <LoadedDashboard dashboard={state.dashboard} />
      ) : null}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// LoadedDashboard — tiles + capability chips + sub-page launchers
// ---------------------------------------------------------------------------

function LoadedDashboard({ dashboard }: { dashboard: LifecycleDashboard }) {
  const caps = dashboard.capabilities;
  return (
    <div
      data-evidence-lifecycle-state="loaded"
      data-evidence-lifecycle-degraded={dashboard.degraded ? "true" : "false"}
      style={{ display: "grid", gap: 12, marginTop: 12 }}
    >
      {dashboard.degraded ? (
        <div
          role="status"
          data-evidence-lifecycle-degraded-banner
          style={{
            padding: 10,
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            color: "#78350f",
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          <strong>Lifecycle activity counts unavailable.</strong>{" "}
          {dashboard.degradedReason ??
            "The activity projector did not respond — your data is safe, counts will repopulate automatically."}
        </div>
      ) : null}
      {dashboard.entitlementMissing ? (
        <div
          role="status"
          data-evidence-lifecycle-entitlement-banner
          style={{
            padding: 10,
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e3a8a",
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          <strong>Advanced lifecycle metrics are gated.</strong> Your
          workspace doesn&apos;t have the <code>FEATURE_LIFECYCLE_DASHBOARD</code>{" "}
          entitlement, so per-tile counts may not back-fill from older
          activity. Contact your account team to enable it.
        </div>
      ) : null}
      <CapabilityLauncherRow caps={caps} />
      <TileGroup
        title="Retention"
        anchor="retention"
        data={dashboard.retention}
        capability={caps?.retention}
      />
      <TileGroup
        title="Legal Holds"
        anchor="legal-holds"
        data={dashboard.legalHolds}
        capability={caps?.legalHolds}
      />
      <TileGroup
        title="Archive"
        anchor="archive"
        data={dashboard.archive}
        capability={caps?.archive}
      />
      <TileGroup
        title="Destruction"
        anchor="destruction"
        data={dashboard.destruction}
        capability={caps?.destruction}
      />
      <TileGroup
        title="Upcoming Expirations"
        anchor="upcoming-expirations"
        data={dashboard.upcomingExpirations}
      />
      {/* PHASE 12B — the dedicated violations endpoints are now the
          authority for this summary + its drill-down. The counts embedded
          in the dashboard envelope are passed as an explicit fallback for
          the case where the dedicated read is denied. */}
      <LifecycleSectionBoundary label="Policy violations">
        <PolicyViolationsPanel
          fallbackByCode={violationsFallbackByCode(dashboard.violations)}
        />
      </LifecycleSectionBoundary>
      {/* PHASE 12B — bounded lifecycle manifest preview (delegated-tier
          gated server-side). */}
      <LifecycleSectionBoundary label="Verification package preview">
        <VerificationPackagePreviewPanel />
      </LifecycleSectionBoundary>
    </div>
  );
}

/**
 * Normalizes the dashboard-embedded violation counts into the bounded
 * per-code shape the panel accepts. Used ONLY as a denial fallback.
 */
function violationsFallbackByCode(
  violations: LifecycleViolations,
): Record<string, number> {
  const byCode = violations.byCode ?? {
    POLICY_VIOLATION_ENTITLEMENT: 0,
    POLICY_VIOLATION_LEGAL_HOLD: violations.totalLegalHoldViolations,
    POLICY_VIOLATION_RETENTION: violations.totalRetentionViolations,
    POLICY_VIOLATION_QUOTA: 0,
  };
  return { ...byCode };
}

function CapabilityLauncherRow({
  caps,
}: {
  caps: LifecycleDashboardCapabilities | undefined;
}) {
  return (
    <Card
      variant="admin"
      data-lifecycle-launcher-row
      title="Capability operations"
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        {SUB_PAGES.map(({ href, label, capabilityKey }) => {
          const state = caps?.[capabilityKey];
          const allowed = isMutationAllowed(state);
          const status = state?.status ?? null;
          const tooltip = state?.reason ?? "";
          const palette = status
            ? CAPABILITY_COLOR[status]
            : (["#fff", "rgba(15,23,42,0.08)", "#0f172a"] as const);
          return (
            <div
              key={href}
              data-lifecycle-launcher={capabilityKey}
              data-capability-status={status ?? "UNKNOWN"}
              data-mutation-allowed={allowed ? "true" : "false"}
              style={{
                background: "#fff",
                border: "1px solid rgba(15,23,42,0.08)",
                borderRadius: 10,
                padding: 10,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
              title={tooltip || undefined}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 13 }}>{label}</strong>
                {status ? (
                  <span
                    data-capability-badge={status}
                    style={{
                      padding: "2px 8px",
                      fontSize: 10,
                      fontWeight: 600,
                      background: palette[0],
                      border: `1px solid ${palette[1]}`,
                      color: palette[2],
                      borderRadius: 999,
                    }}
                  >
                    {CAPABILITY_LABEL[status]}
                  </span>
                ) : null}
              </div>
              {state?.reason ? (
                <small style={{ fontSize: 11, color: "#64748b" }}>{state.reason}</small>
              ) : null}
              <a
                href={allowed ? href : undefined}
                aria-disabled={!allowed}
                onClick={allowed ? undefined : (e) => e.preventDefault()}
                style={{
                  ...launcherButton,
                  ...(allowed ? null : launcherButtonDisabled),
                }}
                title={
                  allowed
                    ? `Open ${label}`
                    : state?.reason ?? `${label} mutations are not available.`
                }
              >
                {allowed ? `Open ${label} →` : `Open ${label} (read-only)`}
              </a>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// TileGroup + ViolationsTileGroup (rendering preserved + capability chip)
// ---------------------------------------------------------------------------

function TileGroup({
  title,
  anchor,
  data,
  capability,
}: {
  title: string;
  anchor: string;
  data: Record<string, number> | undefined;
  capability?: LifecycleCapabilityState;
}) {
  const entries = data ? Object.entries(data) : [];
  const status = capability?.status;
  const palette = status
    ? CAPABILITY_COLOR[status]
    : null;
  return (
    <Card
      variant="admin"
      data-lifecycle-tile-group={anchor}
      data-capability-status={status ?? "UNKNOWN"}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>{title}</strong>
        {capability && palette ? (
          <span
            data-capability-badge={status}
            title={capability.reason ?? undefined}
            style={{
              padding: "2px 8px",
              fontSize: 10,
              fontWeight: 600,
              background: palette[0],
              border: `1px solid ${palette[1]}`,
              color: palette[2],
              borderRadius: 999,
            }}
          >
            {CAPABILITY_LABEL[capability.status]}
          </span>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <small style={{ color: "#64748b" }}>No data.</small>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          {entries.map(([k, v]) => (
            <div
              key={k}
              style={{
                background: "#fff",
                border: "1px solid rgba(15,23,42,0.08)",
                borderRadius: 10,
                padding: 10,
              }}
            >
              <small style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>
                {k}
              </small>
              <strong style={{ fontSize: 22, display: "block", marginTop: 4 }}>
                {typeof v === "number" || typeof v === "string" ? String(v) : "—"}
              </strong>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// PHASE 12B — ViolationsTileGroup + CODE_LABELS were REMOVED. The tile
// group rendered the dashboard-embedded counts with no drill-down and no
// time window; _policy-violations-panel.tsx supersedes it using the
// dedicated GET /v1/lifecycle/violations{,/counts} authorities and keeps
// the dashboard numbers only as an explicit denial fallback.

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const navLink = {
  fontSize: 12,
  color: "#0f172a",
  textDecoration: "underline",
  fontWeight: 600,
} as const;
const crossLinkStyle = {
  fontSize: 12,
  color: "#4338ca",
  textDecoration: "none",
  fontWeight: 700,
} as const;
const mutedNoteStyle = {
  color: "#475569",
  fontSize: 13,
  padding: "12px 0",
} as const;
// errorBoxStyle removed — the dashboard no longer renders a red error
// box. Generic errors now degrade into a soft amber noticeBoxStyle.
const denialBoxStyle = {
  padding: 12,
  background: "#fef3c7",
  border: "1px solid #fcd34d",
  color: "#78350f",
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 12,
} as const;
const noticeBoxStyle = {
  padding: 12,
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  color: "#1e3a8a",
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 12,
} as const;
const launcherButton = {
  fontSize: 12,
  fontWeight: 600,
  color: "#0f172a",
  textDecoration: "none",
  padding: "6px 8px",
  border: "1px solid rgba(15,23,42,0.15)",
  borderRadius: 6,
  background: "#fff",
  textAlign: "center" as const,
};
const launcherButtonDisabled = {
  color: "#94a3b8",
  background: "#f1f5f9",
  cursor: "not-allowed" as const,
  pointerEvents: "auto" as const,
};
