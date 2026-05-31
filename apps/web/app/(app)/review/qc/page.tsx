"use client";

/**
 * PROOVRA Phase 2A — QC workspace.
 *
 * Lists QC samples + renders verdicts. QC reviewers + supervisors
 * record PASS / FAIL / PARTIAL with a bounded failure reason.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { QC_FAILURE_REASONS, QC_VERDICTS } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
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

export default function QcPage() {
  return (
    <PageRouteGate routeId="workspace.review_qc">
      <QcShell />
    </PageRouteGate>
  );
}

function QcShell() {
  const [rows, setRows] = useState<QcRow[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = (await fetchQcSamples()) as QcRow[];
    setRows(list);
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

  const onVerdict = useCallback(
    async (
      sampleId: string,
      verdict: "PASS" | "FAIL" | "PARTIAL",
      failureReason?: string,
    ) => {
      const res = await renderQcVerdict({
        sampleId,
        verdict,
        failureReason,
        rationale: verdict === "FAIL" ? "Failure recorded via UI" : undefined,
      });
      if (res.ok) {
        setBanner(`Verdict ${verdict} recorded.`);
        await refresh();
      } else {
        setBanner(`Verdict refused: ${res.denial}`);
      }
    },
    [refresh],
  );

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

      <h2 style={h2}>Pending ({pending.length})</h2>
      <QcTable rows={pending} onVerdict={onVerdict} />

      <h2 style={h2}>Rendered ({rendered.length})</h2>
      <QcTable rows={rendered} onVerdict={() => Promise.resolve()} readOnly />
    </div>
  );
}

function QcTable({
  rows,
  onVerdict,
  readOnly,
}: {
  rows: QcRow[];
  onVerdict: (id: string, v: "PASS" | "FAIL" | "PARTIAL", reason?: string) => Promise<void>;
  readOnly?: boolean;
}) {
  return (
    <table
      data-qc-table
      style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 18 }}
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
        {rows.map((r) => (
          <tr key={r.id} data-qc-row={r.id}>
            <td style={td}>
              <code>{r.workflowId.slice(0, 8)}…</code>
            </td>
            <td style={td}>{r.state}</td>
            <td style={td}>
              {r.verdict ? (
                <code style={{ background: "#f1f5f9", padding: "1px 6px", borderRadius: 4 }}>
                  {r.verdict}
                </code>
              ) : (
                "—"
              )}
              {r.failureReason ? (
                <div style={{ color: "#64748b", fontSize: 11 }}>{r.failureReason}</div>
              ) : null}
            </td>
            <td style={td}>{new Date(r.sampledAtUtc).toLocaleString()}</td>
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
                      onClick={() =>
                        void onVerdict(
                          r.id,
                          v as "PASS" | "FAIL" | "PARTIAL",
                          v === "FAIL" ? QC_FAILURE_REASONS[0] : undefined,
                        )
                      }
                      style={qcBtnStyle(v)}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th = { padding: "8px 10px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "8px 10px", borderBottom: "1px solid #f1f5f9" } as const;
const h2 = { fontSize: 14, color: "#0f172a", marginTop: 18 } as const;
function qcBtnStyle(v: string) {
  const tone =
    v === "PASS" ? "#16a34a" : v === "FAIL" ? "#dc2626" : "#f59e0b";
  return {
    padding: "5px 10px",
    borderRadius: 8,
    border: "none",
    background: tone,
    color: "#fafafa",
    fontWeight: 600,
    fontSize: 11,
    cursor: "pointer",
  } as const;
}
