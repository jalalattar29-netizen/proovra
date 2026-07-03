"use client";

/**
 * PROOVRA Phase 2A — QC workspace.
 *
 * Lists QC samples + renders verdicts. QC reviewers + supervisors
 * record PASS / FAIL / PARTIAL with a bounded failure reason.
 *
 * PHASE 2 — Operator-selectable FAIL reason picker.
 *
 *   Previously the FAIL action submitted the first enum value
 *   ("INCORRECT_CODING") unconditionally — every failed sample
 *   ended up coded as the same canned reason regardless
 *   of operator intent. The canonical /v1/reviewer/qc/samples/:id/verdict
 *   route + qc-sample service accept BOTH `failureReason` (bounded
 *   enum) and a free-text `rationale` (max 600 chars; truncated server
 *   side). Service code path: services/api/src/services/reviewer-
 *   workspace/qc-sample.service.ts -> renderQcVerdict.
 *
 *   FAIL submission rules (enforced by qc-sample.service.ts):
 *     - failureReason must be a QC_FAILURE_REASONS enum value
 *     - rationale must be a non-empty string (RATIONALE_REQUIRED)
 *
 *   PASS / PARTIAL paths are unchanged — they post the verdict only.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { QC_FAILURE_REASONS, QC_VERDICTS } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational";
import { formatUserDateTime } from "../../../../lib/date";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import {
  fetchQcSamples,
  renderQcVerdict,
} from "../../../../lib/reviewer-workspace/reviewer-api";

type QcRow = {
  id: string;
  workflowId: string;
  state: string;
  verdict: string | null;
  failureReason: string | null;
  sampledAtUtc: string;
  qcReviewerUserId: string | null;
};

/**
 * Bounded display labels for QC_FAILURE_REASONS. We surface a human
 * label but the value posted to the server is always the canonical
 * enum string — labels are presentation only.
 */
const QC_FAILURE_REASON_LABELS: Record<string, string> = {
  INCORRECT_CODING: "Incorrect coding",
  MISSING_REQUIRED_FIELDS: "Missing required fields",
  WRONG_DECISION: "Wrong decision",
  MISSED_ESCALATION: "Missed escalation",
  INSUFFICIENT_ANNOTATION: "Insufficient annotation",
  POLICY_VIOLATION: "Policy violation",
  OTHER: "Other",
};

const RATIONALE_MAX = 600;

export default function QcPage() {
  return (
    <PageRouteGate routeId="workspace.review_qc">
      <QcShell />
    </PageRouteGate>
  );
}

function QcShell() {
  const teamId = useActiveSpaceId();
  const [rows, setRows] = useState<QcRow[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  /**
   * Which sample currently has the FAIL picker open. Null when no
   * picker is open. Only one row can have the picker open at a time —
   * keeps the UI simple and prevents accidentally submitting against
   * the wrong row.
   */
  const [failOpenSampleId, setFailOpenSampleId] = useState<string | null>(null);
  /** In-flight guard so the operator cannot double-fire a verdict. */
  const [busySampleId, setBusySampleId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!teamId) {
      setRows([]);
      return;
    }
    try {
      const list = (await fetchQcSamples(teamId)) as QcRow[];
      setRows(list);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[reviewer-workspace] qc samples refresh failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
      });
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = useMemo(
    () => (rows ?? []).filter((r) => r.state !== "VERDICT_RENDERED"),
    [rows],
  );
  const rendered = useMemo(
    () => (rows ?? []).filter((r) => r.state === "VERDICT_RENDERED"),
    [rows],
  );

  /**
   * Submit a PASS / FAIL / PARTIAL verdict. For PASS / PARTIAL the
   * picker arguments are unused. For FAIL both failureReason and
   * rationale are required by the server — the QcFailPicker enforces
   * this client-side and the service double-checks.
   */
  const onVerdict = useCallback(
    async (
      sampleId: string,
      verdict: "PASS" | "FAIL" | "PARTIAL",
      failureReason?: string,
      rationale?: string,
    ) => {
      if (busySampleId || !teamId) return;
      setBusySampleId(sampleId);
      try {
        const res = await renderQcVerdict({
          sampleId,
          verdict,
          failureReason,
          rationale,
          teamId,
        });
        if (res.ok) {
          setBanner(`Verdict ${verdict} recorded.`);
          setFailOpenSampleId(null);
          await refresh();
        } else {
          setBanner(`Verdict refused: ${res.denial}`);
        }
      } finally {
        setBusySampleId(null);
      }
    },
    [refresh, busySampleId, teamId],
  );

  if (!teamId) {
    return (
      <div
        data-qc-page
        style={{
          padding: 24,
          maxWidth: 1100,
          margin: "0 auto",
          color: "#0f172a",
        }}
      >
        <OperationalEmptyState
          title="Select a workspace"
          reason="Choose an active workspace before loading QC samples."
        />
      </div>
    );
  }

  return (
    <div
      data-qc-page
      style={{
        padding: 24,
        maxWidth: 1100,
        margin: "0 auto",
        color: "#0f172a",
      }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Quality Control</h1>
      <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
        Sample-based review of closed workflows. Verdicts feed reviewer
        accuracy metrics.
      </p>
      <div
        style={{
          marginBottom: 14,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 10,
        }}
      >
        <QcMetric label="Pending samples" value={pending.length} />
        <QcMetric label="Rendered verdicts" value={rendered.length} />
        <QcMetric label="Loaded sample set" value={(rows ?? []).length} />
      </div>
      <div
        style={{
          marginBottom: 16,
          padding: "10px 12px",
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          background: "#f8fafc",
          color: "#475569",
          fontSize: 12,
          lineHeight: 1.55,
        }}
      >
        QC samples are generated from closed workflows through the canonical
        approve and reject lifecycle. This page shows the sampled set that has
        reached QC, not every closed workflow in the workspace.
      </div>
      {banner ? (
        <div
          data-qc-banner
          style={{
            padding: "8px 12px",
            background: "rgba(15, 23, 42, 0.06)",
            borderRadius: 10,
            margin: "8px 0 14px",
            fontSize: 13,
          }}
        >
          {banner}
        </div>
      ) : null}

      {rows !== null && rows.length === 0 ? (
        <div style={{ marginBottom: 18 }}>
          <OperationalEmptyState
            kicker="Quality control"
            title="No QC samples are available in this workspace yet."
            reason="Samples are created from workflows that close through the real approve or reject paths. If the tables are empty, either no sampled closures exist yet or the sampled set has not reached this workspace scope."
            actions={[
              { label: "Open reviewer queues", href: "/review/queues?queue=COMPLETED_RECENTLY" },
              { label: "Review SLA pressure", href: "/reviewer-ops/sla" },
            ]}
            emptyStateCode="review_qc_empty"
          />
        </div>
      ) : null}

      <h2 style={h2}>Pending ({pending.length})</h2>
      <QcTable
        rows={pending}
        onVerdict={onVerdict}
        failOpenSampleId={failOpenSampleId}
        onOpenFailPicker={setFailOpenSampleId}
        busySampleId={busySampleId}
      />

      <h2 style={h2}>Rendered ({rendered.length})</h2>
      <QcTable
        rows={rendered}
        onVerdict={() => Promise.resolve()}
        readOnly
        failOpenSampleId={null}
        onOpenFailPicker={() => {}}
        busySampleId={null}
      />
    </div>
  );
}

function QcTable({
  rows,
  onVerdict,
  readOnly,
  failOpenSampleId,
  onOpenFailPicker,
  busySampleId,
}: {
  rows: QcRow[];
  onVerdict: (
    id: string,
    v: "PASS" | "FAIL" | "PARTIAL",
    failureReason?: string,
    rationale?: string,
  ) => Promise<void>;
  readOnly?: boolean;
  failOpenSampleId: string | null;
  onOpenFailPicker: (sampleId: string | null) => void;
  busySampleId: string | null;
}) {
  return (
    <table
      data-qc-table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
        marginBottom: 18,
      }}
    >
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={th}>Workflow</th>
          <th style={th}>State</th>
          <th style={th}>Verdict</th>
          <th style={th}>Sampled at</th>
          <th style={th}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const isFailOpen = failOpenSampleId === r.id;
          const isBusy = busySampleId === r.id;
          return (
            <RowFragment key={r.id} sampleId={r.id}>
              <tr data-qc-row={r.id}>
                <td style={td}>
                  <code>{r.workflowId.slice(0, 8)}…</code>
                </td>
                <td style={td}>{r.state}</td>
                <td style={td}>
                  {r.verdict ? (
                    <code
                      style={{
                        background: "#f1f5f9",
                        padding: "1px 6px",
                        borderRadius: 4,
                      }}
                    >
                      {r.verdict}
                    </code>
                  ) : (
                    "—"
                  )}
                  {r.failureReason ? (
                    <div style={{ color: "#64748b", fontSize: 11 }}>
                      {QC_FAILURE_REASON_LABELS[r.failureReason] ??
                        r.failureReason}
                    </div>
                  ) : null}
                </td>
                <td style={td}>{formatUserDateTime(r.sampledAtUtc)}</td>
                <td style={td}>
                  {readOnly ? (
                    "—"
                  ) : (
                    <div style={{ display: "flex", gap: 6 }}>
                      {QC_VERDICTS.map((v) => (
                        <button
                          key={v}
                          type="button"
                          data-qc-verdict-btn={v}
                          disabled={isBusy || (isFailOpen && v !== "FAIL")}
                          onClick={() => {
                            if (v === "FAIL") {
                              // Open the picker instead of submitting
                              // — operator must choose a reason and
                              // type a rationale.
                              onOpenFailPicker(isFailOpen ? null : r.id);
                              return;
                            }
                            void onVerdict(r.id, v as "PASS" | "PARTIAL");
                          }}
                          style={qcBtnStyle(v, isBusy)}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
              {isFailOpen ? (
                <tr data-qc-fail-picker-row={r.id}>
                  <td colSpan={5} style={{ padding: 0 }}>
                    <QcFailPicker
                      sampleId={r.id}
                      busy={isBusy}
                      onCancel={() => onOpenFailPicker(null)}
                      onSubmit={(failureReason, rationale) =>
                        void onVerdict(r.id, "FAIL", failureReason, rationale)
                      }
                    />
                  </td>
                </tr>
              ) : null}
            </RowFragment>
          );
        })}
      </tbody>
    </table>
  );
}

function QcMetric({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        background: "#fff",
        padding: "10px 12px",
      }}
    >
      <div style={{ color: "#64748b", fontSize: 11 }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

/**
 * Wrapper that exists purely to give the key + nested <tr>s a stable
 * parent. <tbody> only accepts <tr> as children, and React forbids
 * fragments with a key prop in some setups; this keeps the table
 * markup valid.
 */
function RowFragment({
  children,
}: {
  sampleId: string;
  children: ReactNode;
}) {
  return <>{children}</>;
}

/**
 * Operator-driven FAIL reason picker. Renders:
 *   * A `<select>` with every QC_FAILURE_REASONS enum value (no
 *     hardcoded default — operator must choose).
 *   * A bounded `<textarea>` for rationale (REQUIRED by the canonical
 *     service when verdict === "FAIL"; max 600 chars; the server also
 *     truncates).
 *
 * Submit is disabled until BOTH a reason is selected AND the rationale
 * has at least one non-whitespace character.
 */
function QcFailPicker({
  sampleId,
  busy,
  onSubmit,
  onCancel,
}: {
  sampleId: string;
  busy: boolean;
  onSubmit: (failureReason: string, rationale: string) => void;
  onCancel: () => void;
}) {
  const [failureReason, setFailureReason] = useState<string>("");
  const [rationale, setRationale] = useState<string>("");

  const trimmed = rationale.trim();
  const canSubmit =
    !busy &&
    failureReason.length > 0 &&
    (QC_FAILURE_REASONS as ReadonlyArray<string>).includes(failureReason) &&
    trimmed.length > 0 &&
    trimmed.length <= RATIONALE_MAX;

  return (
    <div
      data-qc-fail-picker={sampleId}
      style={{
        padding: 12,
        background: "rgba(220, 38, 38, 0.04)",
        borderTop: "1px solid #fecaca",
        borderBottom: "1px solid #fecaca",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ color: "#7f1d1d", fontSize: 12, fontWeight: 600 }}>
        Record QC failure — choose a reason and explain.
      </div>
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 11,
          color: "#0f172a",
        }}
      >
        <span>Reason</span>
        <select
          data-qc-fail-reason-select
          value={failureReason}
          onChange={(e) => setFailureReason(e.target.value)}
          disabled={busy}
          style={{
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid #cbd5e1",
            background: "#fff",
            fontSize: 13,
            color: "#0f172a",
          }}
        >
          <option value="">Choose a reason…</option>
          {QC_FAILURE_REASONS.map((r) => (
            <option key={r} value={r}>
              {QC_FAILURE_REASON_LABELS[r] ?? r}
            </option>
          ))}
        </select>
      </label>
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 11,
          color: "#0f172a",
        }}
      >
        <span>
          Rationale ({trimmed.length}/{RATIONALE_MAX})
        </span>
        <textarea
          data-qc-fail-rationale
          value={rationale}
          maxLength={RATIONALE_MAX}
          onChange={(e) => setRationale(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder="Why did this sample fail QC?"
          style={{
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid #cbd5e1",
            background: "#fff",
            fontSize: 13,
            color: "#0f172a",
            resize: "vertical",
          }}
        />
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          data-qc-fail-cancel
          onClick={onCancel}
          disabled={busy}
          style={cancelBtnStyle}
        >
          Cancel
        </button>
        <button
          type="button"
          data-qc-fail-submit
          disabled={!canSubmit}
          onClick={() => onSubmit(failureReason, trimmed)}
          style={failSubmitStyle(canSubmit)}
        >
          {busy ? "Submitting…" : "Record FAIL"}
        </button>
      </div>
    </div>
  );
}

const th = { padding: "8px 10px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "8px 10px", borderBottom: "1px solid #f1f5f9" } as const;
const h2 = { fontSize: 14, color: "#0f172a", marginTop: 18 } as const;
const cancelBtnStyle = {
  padding: "5px 10px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 11,
  cursor: "pointer",
} as const;
function failSubmitStyle(enabled: boolean) {
  return {
    padding: "5px 10px",
    borderRadius: 8,
    border: "none",
    background: enabled ? "#dc2626" : "#fecaca",
    color: enabled ? "#fafafa" : "#7f1d1d",
    fontWeight: 600,
    fontSize: 11,
    cursor: enabled ? "pointer" : "not-allowed",
  } as const;
}
function qcBtnStyle(v: string, disabled: boolean) {
  const tone =
    v === "PASS" ? "#16a34a" : v === "FAIL" ? "#dc2626" : "#f59e0b";
  return {
    padding: "5px 10px",
    borderRadius: 8,
    border: "none",
    background: disabled ? "#cbd5e1" : tone,
    color: "#fafafa",
    fontWeight: 600,
    fontSize: 11,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.7 : 1,
  } as const;
}
