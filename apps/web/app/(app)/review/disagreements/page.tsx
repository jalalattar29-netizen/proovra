"use client";

/**
 * PROOVRA Phase 2A — Disagreements surface.
 *
 * Workspace-anchored list of open disagreements with state-machine
 * transition controls. Senior reviewers + supervisors adjudicate;
 * the challenger may withdraw their own filing.
 */

import { useCallback, useEffect, useState } from "react";

import {
  DISAGREEMENT_STATES,
  REVIEWER_VERDICTS,
  type DisagreementState,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { transitionDisagreement } from "../../../../lib/reviewer-workspace/reviewer-api";

type DisagreementRow = {
  id: string;
  workflowId: string;
  state: DisagreementState;
  challengerUserId: string;
  challengerRationale: string;
  secondReviewerUserId: string | null;
  secondReviewerVerdict: string | null;
  supervisorUserId: string | null;
  supervisorVerdict: string | null;
  filedAtUtc: string;
  resolvedAtUtc: string | null;
};

export default function DisagreementsPage() {
  return (
    <PageRouteGate routeId="workspace.review_disagreements">
      <DisagreementsShell />
    </PageRouteGate>
  );
}

function DisagreementsShell() {
  const [rows, setRows] = useState<DisagreementRow[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiFetch("/v1/reviewer/disagreements?limit=100", {
      method: "GET",
    });
    setRows((res?.disagreements ?? []) as DisagreementRow[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onTransition = useCallback(
    async (id: string, to: DisagreementState, verdict?: string) => {
      const res = await transitionDisagreement({
        disagreementId: id,
        to,
        verdict: verdict as "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO" | "PENDING" | undefined,
      });
      if (res.ok) {
        setBanner(`Moved to ${to}.`);
        await refresh();
      } else {
        setBanner(`Refused: ${res.denial}`);
      }
    },
    [refresh],
  );

  return (
    <div
      data-disagreements-page
      style={{ padding: 24, maxWidth: 1200, margin: "0 auto", color: "#0f172a" }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Disagreements</h1>
      <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
        Reviewers may challenge a recorded decision. Disagreements
        progress through second review and supervisor adjudication.
      </p>
      {banner ? (
        <div
          data-disagreement-banner
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
      {rows === null ? (
        <div>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "#475569", fontSize: 14 }}>
          No disagreements on file.
        </div>
      ) : (
        <table
          data-disagreements-table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>State</th>
              <th style={th}>Workflow</th>
              <th style={th}>Challenger</th>
              <th style={th}>Filed</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-disagreement-row={r.id}>
                <td style={td}>
                  <code style={{ background: "#f1f5f9", padding: "1px 6px", borderRadius: 4 }}>
                    {r.state}
                  </code>
                </td>
                <td style={td}>
                  <code>{r.workflowId.slice(0, 8)}…</code>
                </td>
                <td style={td}>
                  <code>{r.challengerUserId.slice(0, 8)}…</code>
                </td>
                <td style={td}>{new Date(r.filedAtUtc).toLocaleString()}</td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {DISAGREEMENT_STATES.map((to) => {
                      const allowed = isPlausibleTransition(r.state, to);
                      if (!allowed) return null;
                      return (
                        <button
                          key={to}
                          type="button"
                          data-disagreement-transition-btn={to}
                          onClick={() =>
                            void onTransition(
                              r.id,
                              to,
                              to.startsWith("RESOLVED_") ? REVIEWER_VERDICTS[1] : undefined,
                            )
                          }
                          style={transBtnStyle}
                        >
                          {to}
                        </button>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function isPlausibleTransition(
  from: DisagreementState,
  to: DisagreementState,
): boolean {
  if (from === to) return false;
  if (
    from === "FILED" &&
    (to === "UNDER_SECOND_REVIEW" || to === "WITHDRAWN")
  ) {
    return true;
  }
  if (
    from === "UNDER_SECOND_REVIEW" &&
    (to === "UNDER_SUPERVISOR_REVIEW" ||
      to === "RESOLVED_UPHELD" ||
      to === "RESOLVED_OVERTURNED" ||
      to === "RESOLVED_PARTIAL" ||
      to === "WITHDRAWN")
  ) {
    return true;
  }
  if (
    from === "UNDER_SUPERVISOR_REVIEW" &&
    (to === "RESOLVED_UPHELD" ||
      to === "RESOLVED_OVERTURNED" ||
      to === "RESOLVED_PARTIAL")
  ) {
    return true;
  }
  return false;
}

const th = { padding: "8px 10px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "8px 10px", borderBottom: "1px solid #f1f5f9" } as const;
const transBtnStyle = {
  padding: "4px 8px",
  borderRadius: 8,
  border: "1px solid #0f172a",
  background: "#fff",
  color: "#0f172a",
  fontSize: 11,
  cursor: "pointer",
} as const;
