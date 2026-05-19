"use client";

/**
 * Phase 28-G — Runtime Status Banner.
 *
 * Consumes `GET /admin/runtime/readiness` (Phase 28-F) and renders a
 * concise top-of-page banner when the runtime is in DEGRADED /
 * CRITICAL / UNKNOWN state. When everything is HEALTHY the component
 * renders nothing — operational pages stay uncluttered.
 *
 * FAIL-CLOSED:
 *   - When the readiness endpoint itself fails, we render an UNKNOWN
 *     banner. Never imply HEALTHY when we couldn't ask.
 *   - The banner exposes only operator-safe reason codes + bounded
 *     subsystem ids. No secret values, no env values, no privileged
 *     text.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { RuntimeDegradedNotice } from "./OperationalEmptyState";
import { OPS_TONES } from "./tokens";

type ReadinessStatus = "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";

type SubsystemReadiness = {
  id: string;
  status: ReadinessStatus;
  reasonCode: string;
  detail: string;
  remediationHint: string | null;
};

type RuntimeReadinessReport = {
  status: ReadinessStatus;
  ranAtUtc: string;
  durationMs: number;
  requestId: string | null;
  subsystems: ReadonlyArray<SubsystemReadiness>;
};

export type RuntimeStatusBannerProps = {
  teamId: string;
  /** Poll interval in ms. Defaults to 60s. Set to 0 to disable polling. */
  pollMs?: number;
};

export function RuntimeStatusBanner({
  teamId,
  pollMs = 60_000,
}: RuntimeStatusBannerProps) {
  const [report, setReport] = useState<RuntimeReadinessReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = (await apiFetch(
          `/admin/runtime/readiness?teamId=${encodeURIComponent(teamId)}`,
        )) as RuntimeReadinessReport;
        if (!cancelled) {
          setReport(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setReport(null);
          const e = err as { message?: string };
          setError(e?.message ?? "readiness_unavailable");
        }
      }
    }
    void load();
    if (pollMs > 0) {
      const interval = setInterval(() => void load(), pollMs);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [teamId, pollMs]);

  // FAIL-CLOSED: readiness endpoint failed → show UNKNOWN banner.
  // Never render nothing here, because nothing-rendered would be
  // visually indistinguishable from HEALTHY.
  if (error) {
    return (
      <div
        role="status"
        data-runtime-status="UNKNOWN"
        style={{
          border: `1px solid ${OPS_TONES.unknown.border}`,
          background: OPS_TONES.unknown.bg,
          borderRadius: 6,
          padding: "10px 14px",
          fontSize: 13,
          color: OPS_TONES.unknown.ink,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <span>
          Runtime readiness could not be loaded — treat dashboard as unknown
          state.
        </span>
        <span
          style={{
            fontSize: 10,
            letterSpacing: 0.5,
            fontWeight: 700,
            color: OPS_TONES.unknown.kicker,
          }}
        >
          UNKNOWN
        </span>
      </div>
    );
  }

  // HEALTHY → render nothing (operational pages stay clean).
  if (!report || report.status === "HEALTHY") {
    return null;
  }

  const failing = report.subsystems
    .filter((s) => s.status !== "HEALTHY")
    .map((s) => s.id);

  // DEGRADED → use the canonical degraded notice from the empty-state
  // component library. CRITICAL → render the same notice but with the
  // CRITICAL severity color override below.
  if (report.status === "DEGRADED") {
    return <RuntimeDegradedNotice failingSubsystems={failing} />;
  }
  if (report.status === "UNKNOWN") {
    return (
      <div
        role="status"
        data-runtime-status="UNKNOWN"
        style={{
          border: `1px solid ${OPS_TONES.warning.border}`,
          background: OPS_TONES.warning.bg,
          borderRadius: 6,
          padding: "10px 14px",
          fontSize: 13,
          color: OPS_TONES.warning.ink,
          fontWeight: 500,
          marginBottom: 12,
        }}
      >
        Runtime status is unknown for {failing.length || "some"} subsystem(s).
        Open the{" "}
        <a
          href="/ops/observability"
          style={{
            color: OPS_TONES.warning.link,
            fontWeight: 700,
            textDecoration: "underline",
          }}
        >
          Observability dashboard
        </a>{" "}
        for detail.
      </div>
    );
  }
  // CRITICAL: stronger styling than DEGRADED.
  return (
    <div
      role="alert"
      data-runtime-status="CRITICAL"
      style={{
        border: `1px solid ${OPS_TONES.critical.border}`,
        background: OPS_TONES.critical.bg,
        borderRadius: 6,
        padding: "12px 14px",
        fontSize: 13,
        color: OPS_TONES.critical.ink,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginBottom: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700 }}>
          Runtime CRITICAL — operational paths may fail
        </span>
        <span
          style={{
            fontSize: 10,
            letterSpacing: 0.5,
            fontWeight: 700,
            color: OPS_TONES.critical.kicker,
          }}
        >
          CRITICAL
        </span>
      </div>
      <div style={{ fontSize: 12, color: OPS_TONES.critical.inkMuted }}>
        Failing subsystems: {failing.join(", ") || "unknown"}. Review the{" "}
        <a
          href="/ops/runbooks"
          style={{
            color: OPS_TONES.critical.link,
            fontWeight: 700,
            textDecoration: "underline",
          }}
        >
          runbooks
        </a>{" "}
        before continuing destructive operations.
      </div>
    </div>
  );
}
