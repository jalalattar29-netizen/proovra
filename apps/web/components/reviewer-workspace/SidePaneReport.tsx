"use client";

/**
 * PROOVRA Phase 1 — Reviewer Workspace REPORT side-pane.
 *
 * Reads the canonical side-effect-free
 *   GET /v1/evidence/:id/artifacts/status
 * (NOT /report/latest — that endpoint records a download / view event
 * and is the wrong choice for a read-only side-pane). Surfaces the
 * report + verification package readiness flags so reviewers can see
 * whether the artifact pair is generated yet without leaving the
 * workspace.
 *
 * Hard rules:
 *   * No new endpoints. Status reads only — no download URL surfaced.
 *   * Honest empty state on FORBIDDEN / NOT_FOUND / ERROR.
 *   * Bounded copy.
 */

import Link from "next/link";

import type {
  EvidenceArtifactSidePaneState,
  EvidenceArtifactsResult,
} from "../../lib/reviewer-workspace/reviewer-api";

export function SidePaneReport({
  evidenceId,
  state,
  onRetry,
}: {
  evidenceId: string;
  state:
    | { phase: "LOADING" }
    | { phase: "READY"; result: EvidenceArtifactsResult };
  onRetry: () => void;
}) {
  if (state.phase === "LOADING") {
    return (
      <PaneFrame>
        <p
          data-side-pane-report-loading
          style={{ margin: 0, color: "#475569" }}
        >
          Loading…
        </p>
      </PaneFrame>
    );
  }
  const result = state.result;
  if (!result.ok) {
    const message =
      result.reason === "FORBIDDEN"
        ? "Report status is not available — you do not have access."
        : result.reason === "NOT_FOUND"
          ? "Report status is not available for this evidence."
          : "Could not load report status — please retry.";
    return (
      <PaneFrame>
        <p
          data-side-pane-report-empty={result.reason}
          style={{ margin: 0, color: "#475569" }}
        >
          {message}
        </p>
        {result.reason === "ERROR" ? (
          <button
            type="button"
            data-side-pane-report-retry
            onClick={onRetry}
            style={retryBtnStyle}
          >
            Retry
          </button>
        ) : null}
      </PaneFrame>
    );
  }
  const s = result.state;
  const nothingYet =
    !s.reportAvailable &&
    !s.reportPending &&
    !s.packageAvailable &&
    !s.packagePending &&
    !s.packageBlocked;
  if (nothingYet) {
    return (
      <PaneFrame>
        <p
          data-side-pane-report-empty="NO_ARTIFACT"
          style={{ margin: 0, color: "#475569" }}
        >
          No report generated for this evidence yet.
        </p>
      </PaneFrame>
    );
  }
  return (
    <PaneFrame>
      <Tile
        label="Report"
        primaryStatus={reportStatusLabel(s)}
        version={s.reportVersion}
        generatedAt={s.reportGeneratedAtUtc}
        dataTag="report"
      />
      <Tile
        label="Verification package"
        primaryStatus={packageStatusLabel(s)}
        version={s.packageVersion}
        generatedAt={s.packageGeneratedAtUtc}
        dataTag="package"
      />
      <Link
        href={`/evidence/${evidenceId}`}
        data-side-pane-report-detail-link
        style={{ fontSize: 11, color: "#0f172a", textDecoration: "underline" }}
      >
        Open evidence record ↗
      </Link>
    </PaneFrame>
  );
}

function reportStatusLabel(s: EvidenceArtifactSidePaneState): string {
  if (s.reportAvailable) return "Available";
  if (s.reportPending) return "Pending";
  return "Not generated";
}

function packageStatusLabel(s: EvidenceArtifactSidePaneState): string {
  if (s.packageBlocked) return "Blocked by governance";
  if (s.packageAvailable) return "Available";
  if (s.packagePending) return "Pending";
  return "Not generated";
}

function Tile({
  label,
  primaryStatus,
  version,
  generatedAt,
  dataTag,
}: {
  label: string;
  primaryStatus: string;
  version: number | null;
  generatedAt: string | null;
  dataTag: string;
}) {
  const when = (() => {
    if (!generatedAt) return null;
    try {
      return new Date(generatedAt).toLocaleString();
    } catch {
      return generatedAt;
    }
  })();
  return (
    <div
      data-side-pane-report-tile={dataTag}
      style={{
        background: "rgba(15, 23, 42, 0.03)",
        borderRadius: 8,
        padding: "6px 8px",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong style={{ color: "#0f172a" }}>{label}</strong>
        <span style={{ color: "#475569", fontSize: 11 }}>{primaryStatus}</span>
      </div>
      <div style={{ color: "#475569", fontSize: 11 }}>
        {typeof version === "number" ? `v${version}` : "—"}
        {when ? ` · ${when}` : null}
      </div>
    </div>
  );
}

function PaneFrame({ children }: { children: React.ReactNode }) {
  return (
    <section
      data-side-pane="REPORT"
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 12,
        color: "#0f172a",
        fontSize: 12,
        lineHeight: 1.55,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <strong style={{ fontSize: 12, color: "#0f172a" }}>REPORT</strong>
      {children}
    </section>
  );
}

const retryBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  background: "#0f172a",
  color: "#fafafa",
  border: "none",
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
  alignSelf: "flex-start",
};
