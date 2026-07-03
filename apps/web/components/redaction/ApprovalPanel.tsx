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
 * Hard rules:
 *   * The same panel renders the approval history below the
 *     action buttons. Every approval row is preserved — they're
 *     append-only.
 *   * Buttons disable themselves based on the current state so the
 *     UI never solicits an action the server will refuse.
 */

import { useCallback, useState } from "react";

import { formatUserDateTime } from "../../lib/date";

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
  derivative: { state: string } | null;
};

export function ApprovalPanel({
  version,
  onTransition,
}: {
  version: VersionLike;
  onTransition: (
    versionId: string,
    action: "submit" | "approve" | "publish",
    verdict?: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
    rationale?: string,
  ) => Promise<void>;
}) {
  const [rationale, setRationale] = useState<string>("");
  const canSubmit = version.state === "DRAFT";
  const canApprove = version.state === "IN_REVIEW";
  const canPublish =
    version.state === "APPROVED" && version.derivative?.state === "READY";

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
