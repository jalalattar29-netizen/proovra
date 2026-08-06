"use client";

/**
 * PROOVRA Phase 3A — Approval Panel.
 *
 * Bounded approver surface on a single version. Drives the
 * version state machine:
 *
 *   DRAFT → IN_REVIEW         (operator submits)
 *   IN_REVIEW → APPROVED      (approver verdict APPROVE)
 *   IN_REVIEW → REJECTED      (approver verdict REJECT)
 *   IN_REVIEW → DRAFT         (approver verdict REQUEST_CHANGES)
 *   APPROVED → PUBLISHED      (operator publishes; requires READY derivative)
 *
 * Macro-Wave A1 — the panel also carries the redacted-copy (derivative)
 * journey: request/retry, honest QUEUED/RENDERING/FAILED/READY states,
 * and READY-only preview + download via the short-lived signed-URL
 * endpoint (never a raw storage key).
 *
 * Hard rules:
 *   * The same panel renders the approval history below the
 *     action buttons. Every approval row is preserved — they're
 *     append-only.
 *   * Buttons disable themselves based on the current state so the
 *     UI never solicits an action the server will refuse — including
 *     never offering a redacted copy for VIDEO/AUDIO (server denies
 *     with UNSUPPORTED_REDACTION_MEDIA; the UI must not solicit it).
 */

import { useCallback, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

type ApprovalRow = {
  id: string;
  verdict: string;
  approverUserId: string;
  decidedAtUtc: string;
  rationale: string | null;
};

type VersionLike = {
  id: string;
  versionOrdinal: number;
  state: string;
  approvals: ReadonlyArray<ApprovalRow>;
  derivative: {
    id: string;
    state: string;
    failureReason?: string | null;
  } | null;
};

/** Artifact kinds whose derivative render actually ships end-to-end. */
const DERIVATIVE_SUPPORTED_KINDS: ReadonlyArray<string> = ["IMAGE", "PDF"];

export function ApprovalPanel({
  version,
  artifactKind,
  onTransition,
}: {
  version: VersionLike;
  artifactKind: "IMAGE" | "PDF" | "VIDEO" | "AUDIO";
  onTransition: (
    versionId: string,
    action: "submit" | "approve" | "publish" | "derivative",
    verdict?: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
    rationale?: string,
  ) => Promise<void>;
}) {
  const [rationale, setRationale] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [derivativeError, setDerivativeError] = useState<string | null>(null);
  const canSubmit = version.state === "DRAFT";
  const canApprove = version.state === "IN_REVIEW";
  const canPublish =
    version.state === "APPROVED" && version.derivative?.state === "READY";

  const derivative = version.derivative;
  const derivativeSupported = DERIVATIVE_SUPPORTED_KINDS.includes(artifactKind);
  const derivativeInFlight =
    derivative?.state === "QUEUED" || derivative?.state === "RENDERING";
  // The server accepts a derivative request only for APPROVED/PUBLISHED
  // versions, and only for shipping media kinds.
  const canRequestDerivative =
    derivativeSupported &&
    (version.state === "APPROVED" || version.state === "PUBLISHED") &&
    (!derivative || derivative.state === "FAILED");

  const fetchDownloadUrl = useCallback(async (): Promise<string | null> => {
    if (!derivative || derivative.state !== "READY") return null;
    setDerivativeError(null);
    try {
      const res = await apiFetch(
        `/v1/redaction/derivatives/${derivative.id}/download-url`,
        { method: "GET" },
      );
      const url = res?.downloadUrl as string | undefined;
      if (!url) throw new Error("missing downloadUrl");
      return url;
    } catch (err) {
      setDerivativeError(
        toSafeUserError(err, {
          message: "We couldn't prepare the redacted copy download.",
        }).message,
      );
      return null;
    }
  }, [derivative]);

  const onClickRequestDerivative = useCallback(async () => {
    setDerivativeError(null);
    setPreviewUrl(null);
    await onTransition(version.id, "derivative");
  }, [onTransition, version.id]);

  const onClickDownload = useCallback(async () => {
    const url = await fetchDownloadUrl();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [fetchDownloadUrl]);

  const onClickPreview = useCallback(async () => {
    const url = await fetchDownloadUrl();
    if (!url) return;
    if (artifactKind === "IMAGE") {
      // Inline bounded image preview from the same short-lived URL.
      setPreviewUrl(url);
    } else {
      // PDF preview = open the signed URL in a new tab (no in-app viewer).
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, [artifactKind, fetchDownloadUrl]);

  const onClickSubmit = useCallback(async () => {
    await onTransition(version.id, "submit", undefined, rationale || undefined);
    setRationale("");
  }, [onTransition, rationale, version.id]);

  const onClickApprove = useCallback(
    async (verdict: "APPROVE" | "REJECT" | "REQUEST_CHANGES") => {
      await onTransition(version.id, "approve", verdict, rationale || undefined);
      setRationale("");
    },
    [onTransition, rationale, version.id],
  );

  const onClickPublish = useCallback(async () => {
    await onTransition(
      version.id,
      "publish",
      undefined,
      rationale || undefined,
    );
    setRationale("");
  }, [onTransition, rationale, version.id]);

  return (
    <section
      data-redaction-approval-panel
      data-redaction-approval-version={version.id}
      data-redaction-version-state={version.state}
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <header
        style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}
      >
        <strong style={{ fontSize: 13 }}>Approval</strong>
        <small style={{ color: "#475569", fontSize: 11 }}>
          Current state · <code>{version.state}</code>
        </small>
      </header>

      <label style={{ fontSize: 11, color: "#475569" }}>
        Rationale (bounded ≤ 600 chars — required to reject or request changes)
        <textarea
          data-redaction-approval-rationale
          rows={2}
          value={rationale}
          onChange={(e) => setRationale(e.target.value.slice(0, 600))}
          style={{
            display: "block",
            width: "100%",
            marginTop: 4,
            marginBottom: 8,
            padding: 6,
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            fontSize: 12,
            boxSizing: "border-box",
          }}
        />
      </label>

      <div
        data-redaction-approval-actions
        style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
      >
        <button
          type="button"
          data-redaction-approval-submit
          onClick={onClickSubmit}
          disabled={!canSubmit}
          style={{
            ...primaryButton,
            background: canSubmit ? "#0f172a" : "#94a3b8",
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          Submit for approval
        </button>
        <button
          type="button"
          data-redaction-approval-approve
          onClick={() => onClickApprove("APPROVE")}
          disabled={!canApprove}
          style={{
            ...successButton,
            background: canApprove ? "#16a34a" : "#86efac",
            cursor: canApprove ? "pointer" : "not-allowed",
          }}
        >
          Approve
        </button>
        <button
          type="button"
          data-redaction-approval-changes
          onClick={() => onClickApprove("REQUEST_CHANGES")}
          disabled={!canApprove}
          style={{
            ...subtleButton,
            cursor: canApprove ? "pointer" : "not-allowed",
          }}
        >
          Request changes
        </button>
        <button
          type="button"
          data-redaction-approval-reject
          onClick={() => onClickApprove("REJECT")}
          disabled={!canApprove}
          style={{
            ...dangerButton,
            cursor: canApprove ? "pointer" : "not-allowed",
          }}
        >
          Reject
        </button>
        <button
          type="button"
          data-redaction-approval-publish
          onClick={onClickPublish}
          disabled={!canPublish}
          style={{
            ...primaryButton,
            background: canPublish ? "#1e3a8a" : "#94a3b8",
            border: "1px solid #1e3a8a",
            cursor: canPublish ? "pointer" : "not-allowed",
          }}
          title={
            !canPublish && version.state === "APPROVED"
              ? "Publishing requires a READY derivative"
              : undefined
          }
        >
          Publish
        </button>
      </div>

      <section
        data-redaction-derivative-panel
        data-redaction-derivative-state={derivative?.state ?? "NONE"}
        style={{
          marginTop: 10,
          padding: 8,
          border: "1px solid #e2e8f0",
          borderRadius: 8,
        }}
      >
        <strong style={{ fontSize: 12 }}>Redacted copy</strong>

        {!derivativeSupported ? (
          // VIDEO/AUDIO — the server refuses with UNSUPPORTED_REDACTION_MEDIA,
          // so the UI never offers the affordance.
          <p
            data-redaction-derivative-unsupported
            style={{ color: "#475569", fontSize: 11, margin: "4px 0 0" }}
          >
            Redacted-copy rendering isn&apos;t available for{" "}
            <code>{artifactKind}</code> yet.
          </p>
        ) : (
          <>
            <p style={{ color: "#475569", fontSize: 11, margin: "4px 0 6px" }}>
              {derivative == null
                ? "No redacted copy has been requested for this version."
                : derivativeInFlight
                ? "Rendering… this usually takes under a minute."
                : derivative.state === "READY"
                ? "The redacted copy is ready."
                : derivative.state === "FAILED"
                ? "Rendering failed."
                : derivative.state === "QUARANTINED"
                ? "This redacted copy was quarantined by an administrator."
                : `Redacted copy state: ${derivative.state}.`}
            </p>

            {derivative?.state === "FAILED" && derivative.failureReason ? (
              <p
                data-redaction-derivative-failure-reason
                style={{ color: "#7f1d1d", fontSize: 11, margin: "0 0 6px" }}
              >
                Reason: <code>{derivative.failureReason.slice(0, 120)}</code>
              </p>
            ) : null}

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                data-redaction-derivative-request
                onClick={onClickRequestDerivative}
                disabled={!canRequestDerivative}
                style={{
                  ...subtleButton,
                  cursor: canRequestDerivative ? "pointer" : "not-allowed",
                  color: canRequestDerivative ? "#0f172a" : "#94a3b8",
                }}
                title={
                  !canRequestDerivative &&
                  version.state !== "APPROVED" &&
                  version.state !== "PUBLISHED"
                    ? "The version must be approved before a redacted copy can be rendered"
                    : undefined
                }
              >
                {derivative?.state === "FAILED"
                  ? "Retry redacted copy"
                  : derivativeInFlight
                  ? "Rendering…"
                  : "Request redacted copy"}
              </button>

              {derivative?.state === "READY" ? (
                <>
                  <button
                    type="button"
                    data-redaction-derivative-preview
                    onClick={onClickPreview}
                    style={subtleButton}
                  >
                    {artifactKind === "IMAGE" ? "Preview" : "Open preview"}
                  </button>
                  <button
                    type="button"
                    data-redaction-derivative-download
                    onClick={onClickDownload}
                    style={{
                      ...primaryButton,
                      background: "#0f172a",
                    }}
                  >
                    Download redacted copy
                  </button>
                </>
              ) : null}
            </div>

            {derivativeError ? (
              <p
                data-redaction-derivative-error
                style={{ color: "#7f1d1d", fontSize: 11, margin: "6px 0 0" }}
              >
                {derivativeError}
              </p>
            ) : null}

            {previewUrl && artifactKind === "IMAGE" ? (
              // A plain <img> is deliberate here: `previewUrl` is a short-lived
              // signed URL for a redacted derivative, which next/image would
              // proxy and cache. Every other image in this app is a plain <img>
              // for the same reason, and apps/web/.eslintrc.cjs does not
              // register the @next/next plugin — so the disable directive that
              // used to sit on this line referenced a rule that does not exist
              // and failed the build with "Definition for rule ... was not
              // found". Removed rather than suppressed.
              <img
                data-redaction-derivative-preview-image
                src={previewUrl}
                alt="Redacted copy preview"
                style={{
                  display: "block",
                  marginTop: 8,
                  maxWidth: "100%",
                  maxHeight: 360,
                  borderRadius: 6,
                  border: "1px solid #e2e8f0",
                }}
              />
            ) : null}
          </>
        )}
      </section>

      <section
        data-redaction-approval-history
        style={{ marginTop: 10 }}
      >
        <strong style={{ fontSize: 12 }}>Approval history</strong>
        {version.approvals.length === 0 ? (
          <p style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
            No approvals recorded yet.
          </p>
        ) : (
          <ul
            data-redaction-approval-rows
            style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 11 }}
          >
            {version.approvals.map((a) => (
              <li
                key={a.id}
                data-redaction-approval-row={a.verdict}
              >
                <code>{a.verdict}</code>{" "}
                · {formatUserDateTime(a.decidedAtUtc)}{" "}
                · approver <code>{a.approverUserId.slice(0, 8)}…</code>
                {a.rationale ? (
                  <span style={{ color: "#475569" }}> — {a.rationale.slice(0, 80)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
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

const successButton = {
  padding: "6px 12px",
  border: "1px solid #16a34a",
  background: "#16a34a",
  color: "#fff",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;

const dangerButton = {
  padding: "6px 12px",
  border: "1px solid #dc2626",
  background: "#fff",
  color: "#dc2626",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;

const subtleButton = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
