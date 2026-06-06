"use client";

/**
 * PROOVRA Phase 1 — Reviewer Workspace EVIDENCE side-pane.
 *
 * Read-only summary card backed by the canonical
 *   GET /v1/evidence/:id
 * route. Renders ONLY the bounded fields the helper projection
 * surfaces — no storageBucket / storageKey / file bytes / signed URLs.
 * The "Open full evidence ↗" link defers full inspection to the
 * existing /evidence/:id page.
 *
 * Hard rules:
 *   * No new endpoints. Reads /v1/evidence/:id only.
 *   * Bounded copy. Cells truncated to ≤ 400 chars; sha256 shown as a
 *     12-hex prefix, never the full bytes.
 *   * Honest empty state on FORBIDDEN / NOT_FOUND / ERROR — no fake
 *     success surface.
 *
 * Phase 5 — Request Redaction affordance.
 *   When the active operator role carries the bounded redaction
 *   subset (REVIEWER / ADMIN / OWNER per packages/shared/permissions.ts
 *   the affordance renders below the metadata. It calls the existing
 *   POST /v1/redaction/projects (idempotent open) and routes the
 *   operator to the existing /redaction/[projectId] console. Server
 *   gating (`redaction.region.author` + FEATURE_REDACTION) remains
 *   the source of truth — denial is surfaced honestly via bounded
 *   copy, never as fake success.
 */

import { useCallback, useState } from "react";
import Link from "next/link";

import {
  inferRedactionArtifactKind,
  lookupRedactionProjectForEvidence,
  openRedactionProjectForEvidence,
  type EvidenceSidePaneDetail,
  type EvidenceSidePaneResult,
} from "../../lib/reviewer-workspace/reviewer-api";

const MAX_CELL_CHARS = 400;

function trunc(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > MAX_CELL_CHARS
    ? value.slice(0, MAX_CELL_CHARS) + "…"
    : value;
}

export function SidePaneEvidence({
  evidenceId,
  state,
  onRetry,
  canRequestRedaction,
}: {
  evidenceId: string;
  state:
    | { phase: "LOADING" }
    | { phase: "READY"; result: EvidenceSidePaneResult }
    | { phase: "RETRY" };
  onRetry: () => void;
  /**
   * Phase 5 — capability hint derived upstream from the operator's
   * workspace role label. Honest gating happens server-side; this
   * flag only governs whether the affordance renders disabled with
   * an explanation, or active. `false` keeps the button visible but
   * disabled with a bounded tooltip.
   */
  canRequestRedaction?: boolean;
}) {
  if (state.phase === "LOADING") {
    return (
      <PaneFrame mode="EVIDENCE">
        <p
          data-side-pane-evidence-loading
          style={{ margin: 0, color: "#475569" }}
        >
          Loading…
        </p>
      </PaneFrame>
    );
  }
  if (state.phase === "RETRY") {
    return (
      <PaneFrame mode="EVIDENCE">
        <p
          data-side-pane-evidence-retry
          style={{ margin: 0, color: "#475569" }}
        >
          Refreshing…
        </p>
      </PaneFrame>
    );
  }
  const result = state.result;
  if (!result.ok) {
    const message =
      result.reason === "FORBIDDEN"
        ? "Evidence preview not available — you do not have access to this record."
        : result.reason === "NOT_FOUND"
          ? "Evidence preview not available — record could not be found."
          : "Could not load evidence preview — please retry.";
    return (
      <PaneFrame mode="EVIDENCE">
        <p
          data-side-pane-evidence-empty={result.reason}
          style={{ margin: 0, color: "#475569" }}
        >
          {message}
        </p>
        {result.reason === "ERROR" ? (
          <button
            type="button"
            data-side-pane-evidence-retry-btn
            onClick={onRetry}
            style={retryBtnStyle}
          >
            Retry
          </button>
        ) : null}
      </PaneFrame>
    );
  }
  const d = result.detail;
  return (
    <PaneFrame mode="EVIDENCE">
      <EvidenceCard detail={d} />
      <div style={{ display: "flex", gap: 8 }}>
        <Link
          href={`/evidence/${evidenceId}`}
          data-side-pane-evidence-detail-link
          style={inlineLinkStyle}
        >
          Open full evidence ↗
        </Link>
        {d.caseId ? (
          <Link
            href={`/cases/${d.caseId}`}
            data-side-pane-evidence-case-link
            style={inlineLinkStyle}
          >
            Open matter ↗
          </Link>
        ) : null}
      </div>
      <RequestRedactionAction
        evidenceId={evidenceId}
        mimeType={d.mimeType}
        displayTitle={d.displayTitle}
        canRequest={canRequestRedaction === true}
      />
    </PaneFrame>
  );
}

// ---------------------------------------------------------------------------
// Phase 5 — Request Redaction affordance.
// ---------------------------------------------------------------------------

type RequestRedactionPhase =
  | { kind: "IDLE" }
  | { kind: "PROBING" }
  | { kind: "OPENING" }
  | { kind: "OPENED"; projectId: string; opened: boolean }
  | {
      kind: "DENIED";
      reason:
        | "FORBIDDEN"
        | "ENTITLEMENT_REQUIRED"
        | "UNSUPPORTED_MIME"
        | "ERROR";
    };

function RequestRedactionAction({
  evidenceId,
  mimeType,
  displayTitle,
  canRequest,
}: {
  evidenceId: string;
  mimeType: string | null;
  displayTitle: string | null;
  canRequest: boolean;
}) {
  const [phase, setPhase] = useState<RequestRedactionPhase>({ kind: "IDLE" });
  const artifactKind = inferRedactionArtifactKind(mimeType);

  const onClick = useCallback(async () => {
    if (!canRequest) return;
    if (!artifactKind) {
      setPhase({ kind: "DENIED", reason: "UNSUPPORTED_MIME" });
      return;
    }
    // Probe first — surfacing an existing project avoids creating a
    // duplicate row even though the backend service is idempotent on
    // the (teamId, evidenceId) unique constraint.
    setPhase({ kind: "PROBING" });
    const lookup = await lookupRedactionProjectForEvidence(evidenceId);
    if (!lookup.ok) {
      setPhase({
        kind: "DENIED",
        reason: lookup.reason === "FORBIDDEN" ? "FORBIDDEN" : "ERROR",
      });
      return;
    }
    if (lookup.projectId) {
      setPhase({
        kind: "OPENED",
        projectId: lookup.projectId,
        opened: false,
      });
      return;
    }
    setPhase({ kind: "OPENING" });
    const title = bounded(displayTitle);
    const result = await openRedactionProjectForEvidence({
      evidenceId,
      mimeType,
      title,
    });
    if (!result.ok) {
      setPhase({ kind: "DENIED", reason: result.reason });
      return;
    }
    setPhase({
      kind: "OPENED",
      projectId: result.projectId,
      opened: result.opened,
    });
  }, [artifactKind, canRequest, displayTitle, evidenceId, mimeType]);

  const disabled =
    !canRequest ||
    artifactKind === null ||
    phase.kind === "PROBING" ||
    phase.kind === "OPENING";

  const tooltip = !canRequest
    ? "Redaction author capability is required. Ask a workspace administrator if you need access."
    : artifactKind === null
      ? "Redaction is not supported for this evidence type."
      : phase.kind === "PROBING"
        ? "Checking for an existing redaction project…"
        : phase.kind === "OPENING"
          ? "Opening redaction project…"
          : "Open or create a redaction project for this evidence.";

  return (
    <div
      data-request-redaction-region
      style={{
        marginTop: 4,
        borderTop: "1px solid rgba(15, 23, 42, 0.08)",
        paddingTop: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <button
        type="button"
        data-request-redaction-btn
        data-capability-allowed={canRequest ? "true" : "false"}
        data-artifact-kind={artifactKind ?? "UNKNOWN"}
        disabled={disabled}
        onClick={() => {
          void onClick();
        }}
        title={tooltip}
        style={requestBtnStyle(disabled)}
      >
        {phase.kind === "PROBING"
          ? "Checking…"
          : phase.kind === "OPENING"
            ? "Opening…"
            : "Request redaction"}
      </button>
      {phase.kind === "OPENED" ? (
        <div
          data-request-redaction-opened
          data-redaction-opened-new={phase.opened ? "true" : "false"}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ color: "#475569", fontSize: 11 }}>
            {phase.opened
              ? "Redaction project opened."
              : "A redaction project already exists for this evidence."}
          </span>
          <Link
            href={`/redaction/${phase.projectId}`}
            data-request-redaction-link
            style={inlineLinkStyle}
          >
            Open redaction project ↗
          </Link>
        </div>
      ) : null}
      {phase.kind === "DENIED" ? (
        <span
          data-request-redaction-denied={phase.reason}
          style={{ color: "#b45309", fontSize: 11 }}
        >
          {denialCopy(phase.reason)}
        </span>
      ) : null}
    </div>
  );
}

function denialCopy(
  reason: "FORBIDDEN" | "ENTITLEMENT_REQUIRED" | "UNSUPPORTED_MIME" | "ERROR",
): string {
  switch (reason) {
    case "FORBIDDEN":
      return "Redaction request refused — your role does not include the redaction author capability.";
    case "ENTITLEMENT_REQUIRED":
      return "Redaction is not enabled for this workspace. Ask a workspace administrator.";
    case "UNSUPPORTED_MIME":
      return "Redaction is not supported for this evidence type.";
    case "ERROR":
    default:
      return "Could not open a redaction project — please retry.";
  }
}

function bounded(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

function requestBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 10px",
    borderRadius: 6,
    background: disabled ? "#e2e8f0" : "#0f172a",
    color: disabled ? "#64748b" : "#fafafa",
    border: "none",
    fontSize: 11,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    alignSelf: "flex-start",
  };
}

function EvidenceCard({ detail }: { detail: EvidenceSidePaneDetail }) {
  return (
    <dl
      data-side-pane-evidence-card
      style={{
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        rowGap: 4,
        columnGap: 12,
        margin: 0,
        fontSize: 12,
      }}
    >
      <Row label="Title" value={trunc(detail.displayTitle)} />
      <Row label="Subtitle" value={trunc(detail.displaySubtitle)} />
      <Row
        label="Type"
        value={trunc(detail.primaryContentLabel ?? detail.mimeType)}
      />
      <Row
        label="SHA-256"
        value={detail.fileSha256Prefix ? `${detail.fileSha256Prefix}…` : "—"}
      />
      <Row label="Status" value={detail.status ?? "—"} />
      <Row label="Verification" value={detail.verificationStatus ?? "—"} />
      {detail.templateSlug ? (
        <Row
          label="Template"
          value={`${detail.templateSlug}${
            detail.templateVersion ? ` · v${detail.templateVersion}` : ""
          }`}
        />
      ) : null}
      <Row label="Evidence id" value={detail.id} />
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: "#475569" }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          color: "#0f172a",
          wordBreak: "break-word",
        }}
      >
        {value}
      </dd>
    </>
  );
}

function PaneFrame({
  mode,
  children,
}: {
  mode: "EVIDENCE" | "OCR" | "TRANSCRIPT" | "REPORT";
  children: React.ReactNode;
}) {
  return (
    <section
      data-side-pane={mode}
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
      <strong style={{ fontSize: 12, color: "#0f172a" }}>{mode}</strong>
      {children}
    </section>
  );
}

const inlineLinkStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#0f172a",
  textDecoration: "underline",
};

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
