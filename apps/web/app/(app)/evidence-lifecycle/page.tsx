"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../lib/api";

type PermissionDenialState = { denial: string; tier: string } | null;

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

interface LifecycleDashboard {
  retention: Record<string, number>;
  legalHolds: Record<string, number>;
  archive: Record<string, number>;
  destruction: Record<string, number>;
  upcomingExpirations: Record<string, number>;
  violations: LifecycleViolations;
}

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

const SUB_PAGES = [
  { href: "/evidence-lifecycle/retention", label: "Retention" },
  { href: "/evidence-lifecycle/legal-holds", label: "Legal Holds" },
  { href: "/evidence-lifecycle/archive", label: "Archive" },
  { href: "/evidence-lifecycle/destruction", label: "Destruction" },
  { href: "/evidence-lifecycle/webhooks", label: "Webhooks" },
  { href: "/evidence-lifecycle/chain-transfers", label: "Chain Transfers" },
];

export default function EvidenceLifecyclePage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <Shell />
    </PageRouteGate>
  );
}

function TileGroup({
  title,
  anchor,
  data,
}: {
  title: string;
  anchor: string;
  data: Record<string, number>;
}) {
  return (
    <section
      data-lifecycle-tile-group={anchor}
      style={{
        padding: 12,
        background: "rgba(15,23,42,0.03)",
        border: "1px solid rgba(15,23,42,0.06)",
        borderRadius: 10,
      }}
    >
      <strong style={{ fontSize: 14, display: "block", marginBottom: 6 }}>{title}</strong>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
        }}
      >
        {Object.entries(data).map(([k, v]) => (
          <div
            key={k}
            style={{
              background: "#fff",
              border: "1px solid rgba(15,23,42,0.08)",
              borderRadius: 10,
              padding: 10,
            }}
          >
            <small style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>{k}</small>
            <strong style={{ fontSize: 22, display: "block", marginTop: 4 }}>{v}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

const CODE_LABELS: Record<string, string> = {
  POLICY_VIOLATION_ENTITLEMENT: "Entitlement",
  POLICY_VIOLATION_LEGAL_HOLD: "Legal Hold",
  POLICY_VIOLATION_RETENTION: "Retention",
  POLICY_VIOLATION_QUOTA: "Quota",
};

function ViolationsTileGroup({ violations }: { violations: LifecycleViolations }) {
  const byCode = violations.byCode ?? {
    POLICY_VIOLATION_ENTITLEMENT: 0,
    POLICY_VIOLATION_LEGAL_HOLD: violations.totalLegalHoldViolations,
    POLICY_VIOLATION_RETENTION: violations.totalRetentionViolations,
    POLICY_VIOLATION_QUOTA: 0,
  };
  const total = violations.totalBounded ?? Object.values(byCode).reduce((s, v) => s + v, 0);

  return (
    <section
      data-lifecycle-tile-group="violations"
      style={{
        padding: 12,
        background: "rgba(15,23,42,0.03)",
        border: "1px solid rgba(15,23,42,0.06)",
        borderRadius: 10,
      }}
    >
      <strong style={{ fontSize: 14, display: "block", marginBottom: 2 }}>Violations</strong>
      <small style={{ color: "#64748b", fontSize: 11, display: "block", marginBottom: 8 }}>
        Bounded POLICY_VIOLATION_* events — last 30 days ({total} total)
      </small>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
        }}
      >
        {(Object.keys(byCode) as Array<keyof typeof byCode>).map((code) => (
          <div
            key={code}
            data-violation-code={code}
            style={{
              background: byCode[code] > 0 ? "#fef2f2" : "#fff",
              border: `1px solid ${byCode[code] > 0 ? "#fecaca" : "rgba(15,23,42,0.08)"}`,
              borderRadius: 10,
              padding: 10,
            }}
          >
            <small
              style={{
                fontSize: 11,
                color: byCode[code] > 0 ? "#991b1b" : "#475569",
                fontWeight: 600,
              }}
            >
              {CODE_LABELS[code] ?? code}
            </small>
            <strong style={{ fontSize: 22, display: "block", marginTop: 4 }}>
              {byCode[code]}
            </strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function Shell() {
  const [dashboard, setDashboard] = useState<LifecycleDashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/lifecycle/dashboard", {
        method: "GET",
      })) as LifecycleDashboard | null;
      setDashboard(res ?? null);
    } catch (err) {
      setDashboard(null);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-evidence-lifecycle
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Evidence Lifecycle</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Retention · Legal Holds · Archive · Destruction · Webhooks · Chain Transfers.
        </p>
        <nav style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          {SUB_PAGES.map(({ href, label }) => (
            <a key={href} href={href} style={navLink}>
              {label}
            </a>
          ))}
        </nav>
      </header>

      {denial ? (
        <div
          data-permission-denied={denial.denial}
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>Permission required:</strong> {denial.tier}
        </div>
      ) : null}

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      {!dashboard ? (
        <p style={{ color: "#475569", marginTop: 12 }}>Loading…</p>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          <TileGroup title="Retention" anchor="retention" data={dashboard.retention} />
          <TileGroup title="Legal Holds" anchor="legal-holds" data={dashboard.legalHolds} />
          <TileGroup title="Archive" anchor="archive" data={dashboard.archive} />
          <TileGroup title="Destruction" anchor="destruction" data={dashboard.destruction} />
          <TileGroup
            title="Upcoming Expirations"
            anchor="upcoming-expirations"
            data={dashboard.upcomingExpirations}
          />
          <ViolationsTileGroup violations={dashboard.violations} />
        </div>
      )}
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
const navLink = {
  fontSize: 12,
  color: "#0f172a",
  textDecoration: "underline",
  fontWeight: 600,
} as const;
