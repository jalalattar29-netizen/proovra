"use client";

/**
 * PROOVRA Phase 2A — Disagreements surface.
 *
 * Workspace-anchored list of open disagreements with state-machine
 * transition controls. Senior reviewers + supervisors adjudicate;
 * the challenger may withdraw their own filing.
 *
 * PHASE 2 — Operator-selectable resolution verdict picker.
 *
 *   Previously every RESOLVED_* transition was forced through the
 *   first non-PENDING enum value ("APPROVE") regardless of operator
 *   intent. The canonical /v1/reviewer/disagreements/:id/transition
 *   route + service accept BOTH a bounded `verdict` enum and an
 *   optional `rationale` (max 600; truncated server side). Service
 *   code path:
 *   services/api/src/services/reviewer-workspace/reviewer-disagreement.service.ts
 *   -> transitionDisagreement.
 *
 *   Resolution rules (enforced by the service):
 *     - For any RESOLVED_* target the service records the verdict on
 *       the supervisor (or second-reviewer, when not yet UNDER
 *       supervisor review) columns and stores the rationale truncated
 *       to 600 chars.
 *     - Verdict must be a REVIEWER_VERDICTS enum value. We filter
 *       PENDING from the picker — recording a resolution as PENDING is
 *       semantically meaningless for an end-state transition.
 *
 *   Phase RW3 keeps the lifecycle on the canonical declared
 *   ReviewerDisagreement fields: secondReviewerUserId /
 *   supervisorUserId track stage owners, and final adjudication is
 *   persisted through resolution + resolvedAtUtc + resolvedByUserId.
 *   This page still keeps the table focused on progression controls +
 *   challenger context instead of rendering every lifecycle detail
 *   inline.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DISAGREEMENT_STATES,
  REVIEWER_VERDICTS,
  type DisagreementState,
  type ReviewerVerdict,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational";
import { apiFetch } from "../../../../lib/api";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { transitionDisagreement } from "../../../../lib/reviewer-workspace/reviewer-api";

/**
 * Row shape intentionally keeps the list compact. The backend tracks
 * the full lifecycle, but this table only needs the progression fields
 * and challenger context.
 */
type DisagreementRow = {
  id: string;
  workflowId: string;
  state: DisagreementState;
  challengerUserId: string | null;
  challengerRationale: string | null;
  secondReviewerUserId: string | null;
  supervisorUserId: string | null;
  originalDecisionId: string | null;
  filedAtUtc: string;
  resolvedAtUtc: string | null;
  resolution?: ReviewerVerdict | null;
  resolvedByUserId?: string | null;
};

/** Verdicts the picker actually offers — PENDING filtered out as
 *  semantically meaningless on a RESOLVED_* end-state transition. */
const RESOLUTION_VERDICTS = REVIEWER_VERDICTS.filter(
  (v): v is Exclude<ReviewerVerdict, "PENDING"> => v !== "PENDING",
);

const VERDICT_LABELS: Record<ReviewerVerdict, string> = {
  PENDING: "Pending",
  APPROVE: "Approve",
  REJECT: "Reject",
  ESCALATE: "Escalate",
  NEEDS_INFO: "Needs info",
};

const STATE_LABELS: Record<DisagreementState, string> = {
  FILED: "Filed",
  UNDER_SECOND_REVIEW: "Under second review",
  UNDER_SUPERVISOR_REVIEW: "Under supervisor review",
  RESOLVED_UPHELD: "Resolved (upheld)",
  RESOLVED_OVERTURNED: "Resolved (overturned)",
  RESOLVED_PARTIAL: "Resolved (partial)",
  WITHDRAWN: "Withdrawn",
};

const RATIONALE_MAX = 600;
const CHALLENGER_RATIONALE_PREVIEW_MAX = 300;

export default function DisagreementsPage() {
  return (
    <PageRouteGate routeId="workspace.review_disagreements">
      <DisagreementsShell />
    </PageRouteGate>
  );
}

function DisagreementsShell() {
  const teamId = useActiveSpaceId();
  const [rows, setRows] = useState<DisagreementRow[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  /**
   * Which (disagreementId, target state) currently has the resolution
   * picker open. Null when no picker is open. Only one picker can be
   * open at a time so the operator cannot accidentally submit against
   * the wrong row.
   */
  const [pickerArmed, setPickerArmed] = useState<
    | { disagreementId: string; to: DisagreementState }
    | null
  >(null);
  /** In-flight guard so the operator cannot double-fire a transition. */
  const [busyDisagreementId, setBusyDisagreementId] = useState<string | null>(
    null,
  );

  const refresh = useCallback(async () => {
    if (!teamId) {
      setRows([]);
      return;
    }
    try {
      const res = await apiFetch(
        `/v1/reviewer/disagreements?teamId=${encodeURIComponent(teamId)}&limit=100`,
        {
          method: "GET",
        },
      );
      setRows((res?.disagreements ?? []) as DisagreementRow[]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[reviewer-workspace] disagreements list refresh failed", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: (err as any)?.statusCode ?? 0,
      });
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    const source = rows ?? [];
    return {
      filed: source.filter((row) => row.state === "FILED").length,
      secondReview: source.filter((row) => row.state === "UNDER_SECOND_REVIEW")
        .length,
      supervisor: source.filter((row) => row.state === "UNDER_SUPERVISOR_REVIEW")
        .length,
      resolved: source.filter((row) => row.state.startsWith("RESOLVED_")).length,
      withdrawn: source.filter((row) => row.state === "WITHDRAWN").length,
    };
  }, [rows]);

  const onTransition = useCallback(
    async (
      id: string,
      to: DisagreementState,
      verdict?: ReviewerVerdict,
      rationale?: string,
    ) => {
      if (busyDisagreementId || !teamId) return;
      setBusyDisagreementId(id);
      try {
        const res = await transitionDisagreement({
          disagreementId: id,
          to,
          verdict,
          rationale,
          teamId,
        });
        if (res.ok) {
          setBanner(`Moved to ${STATE_LABELS[to] ?? to}.`);
          setPickerArmed(null);
          await refresh();
        } else {
          setBanner(`Refused: ${res.denial}`);
        }
      } finally {
        setBusyDisagreementId(null);
      }
    },
    [refresh, busyDisagreementId, teamId],
  );

  if (!teamId) {
    return (
      <div
        data-disagreements-page
        style={{ padding: 24, maxWidth: 1200, margin: "0 auto", color: "#0f172a" }}
      >
        <OperationalEmptyState
          title="Select a workspace"
          reason="Choose an active workspace before loading disagreements."
        />
      </div>
    );
  }

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
      <div
        style={{
          marginBottom: 14,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        <LifecycleTile label="Filed" value={counts.filed} />
        <LifecycleTile label="Second review" value={counts.secondReview} />
        <LifecycleTile label="Supervisor review" value={counts.supervisor} />
        <LifecycleTile label="Resolved" value={counts.resolved} />
        <LifecycleTile label="Withdrawn" value={counts.withdrawn} />
      </div>
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
        <OperationalEmptyState
          kicker="Disagreement lifecycle"
          title="No disagreements are on file in this workspace."
          reason="Disagreements appear when a reviewer challenges a recorded decision. The lifecycle still matters here: filed disagreements move into second review, then supervisor adjudication, before they are resolved or withdrawn."
          actions={[
            { label: "Open reviewer queues", href: "/review/queues?queue=MY_REVIEWS" },
            { label: "Open escalation operations", href: "/reviewer-ops/escalations" },
          ]}
          emptyStateCode="review_disagreements_empty"
        />
      ) : (
        <DisagreementsTable
          rows={rows}
          onTransition={onTransition}
          pickerArmed={pickerArmed}
          onArmPicker={setPickerArmed}
          busyDisagreementId={busyDisagreementId}
        />
      )}
    </div>
  );
}

function DisagreementsTable({
  rows,
  onTransition,
  pickerArmed,
  onArmPicker,
  busyDisagreementId,
}: {
  rows: DisagreementRow[];
  onTransition: (
    id: string,
    to: DisagreementState,
    verdict?: ReviewerVerdict,
    rationale?: string,
  ) => Promise<void>;
  pickerArmed: { disagreementId: string; to: DisagreementState } | null;
  onArmPicker: (
    armed: { disagreementId: string; to: DisagreementState } | null,
  ) => void;
  busyDisagreementId: string | null;
}) {
  return (
    <table
      data-disagreements-table
      style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
    >
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={th}>State</th>
          <th style={th}>Workflow</th>
          <th style={th}>Owner</th>
          <th style={th}>Challenger</th>
          <th style={th}>Age</th>
          <th style={th}>Resolution</th>
          <th style={th}>Challenger rationale</th>
          <th style={th}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const isBusy = busyDisagreementId === r.id;
          const isPickerOpen = pickerArmed?.disagreementId === r.id;
          return (
            <DisagreementRowGroup
              key={r.id}
              row={r}
              isBusy={isBusy}
              isPickerOpen={isPickerOpen}
              pickerTo={pickerArmed?.to ?? null}
              onArmPicker={onArmPicker}
              onTransition={onTransition}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function DisagreementRowGroup({
  row,
  isBusy,
  isPickerOpen,
  pickerTo,
  onArmPicker,
  onTransition,
}: {
  row: DisagreementRow;
  isBusy: boolean;
  isPickerOpen: boolean;
  pickerTo: DisagreementState | null;
  onArmPicker: (
    armed: { disagreementId: string; to: DisagreementState } | null,
  ) => void;
  onTransition: (
    id: string,
    to: DisagreementState,
    verdict?: ReviewerVerdict,
    rationale?: string,
  ) => Promise<void>;
}) {
  return (
    <>
      <tr data-disagreement-row={row.id}>
        <td style={td}>
          <code
            style={{
              background: "#f1f5f9",
              padding: "1px 6px",
              borderRadius: 4,
            }}
            title={row.state}
          >
            {STATE_LABELS[row.state] ?? row.state}
          </code>
        </td>
        <td style={td}>
          <code>{row.workflowId.slice(0, 8)}…</code>
        </td>
        <td style={td}>
          <OwnerCell row={row} />
        </td>
        <td style={td}>
          {row.challengerUserId ? (
            <code>{row.challengerUserId.slice(0, 8)}…</code>
          ) : (
            <span style={{ color: "#94a3b8" }}>not recorded</span>
          )}
        </td>
        <td style={td}>
          {formatAge(row.filedAtUtc, row.resolvedAtUtc)}
        </td>
        <td style={td}>
          <ResolutionCell row={row} />
        </td>
        <td style={td}>
          <ChallengerRationalePreview value={row.challengerRationale} />
        </td>
        <td style={td}>
          <TransitionButtons
            row={row}
            isBusy={isBusy}
            isPickerOpen={isPickerOpen}
            pickerTo={pickerTo}
            onArmPicker={onArmPicker}
            onTransition={onTransition}
          />
        </td>
      </tr>
      {isPickerOpen && pickerTo && pickerTo.startsWith("RESOLVED_") ? (
        <tr data-disagreement-resolve-picker-row={row.id}>
          <td colSpan={8} style={{ padding: 0 }}>
            <ResolveVerdictPicker
              disagreementId={row.id}
              to={pickerTo}
              busy={isBusy}
              onCancel={() => onArmPicker(null)}
              onSubmit={(verdict, rationale) =>
                void onTransition(row.id, pickerTo, verdict, rationale)
              }
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TransitionButtons({
  row,
  isBusy,
  isPickerOpen,
  pickerTo,
  onArmPicker,
  onTransition,
}: {
  row: DisagreementRow;
  isBusy: boolean;
  isPickerOpen: boolean;
  pickerTo: DisagreementState | null;
  onArmPicker: (
    armed: { disagreementId: string; to: DisagreementState } | null,
  ) => void;
  onTransition: (
    id: string,
    to: DisagreementState,
    verdict?: ReviewerVerdict,
    rationale?: string,
  ) => Promise<void>;
}) {
  const targets = useMemo(
    () =>
      DISAGREEMENT_STATES.filter((to) =>
        isPlausibleTransition(row.state, to),
      ),
    [row.state],
  );
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {targets.map((to) => {
        const isResolveTarget = to.startsWith("RESOLVED_");
        const thisPickerOpen = isPickerOpen && pickerTo === to;
        // Disable other buttons in the row while the picker is open
        // for one of them — keeps the UI clear about which transition
        // is being recorded.
        const disabledByOpenPicker = isPickerOpen && !thisPickerOpen;
        const disabled = isBusy || disabledByOpenPicker;
        return (
          <button
            key={to}
            type="button"
            data-disagreement-transition-btn={to}
            disabled={disabled}
            onClick={() => {
              if (isResolveTarget) {
                // Arm the picker — operator must choose a verdict.
                onArmPicker(
                  thisPickerOpen
                    ? null
                    : { disagreementId: row.id, to },
                );
                return;
              }
              void onTransition(row.id, to);
            }}
            style={transBtnStyle(disabled, thisPickerOpen)}
          >
            {STATE_LABELS[to] ?? to}
          </button>
        );
      })}
      {targets.length === 0 ? (
        <span style={{ color: "#94a3b8", fontSize: 11 }}>
          No further transitions.
        </span>
      ) : null}
    </div>
  );
}

/**
 * Resolution verdict picker — surfaces every operator-selectable
 * REVIEWER_VERDICTS value (PENDING filtered as meaningless on an
 * end-state transition) plus a bounded rationale textarea. The
 * canonical backend stores the verdict on the supervisor (or
 * second-reviewer, when not yet under supervisor review) columns and
 * persists rationale truncated to 600 chars.
 */
function ResolveVerdictPicker({
  disagreementId,
  to,
  busy,
  onSubmit,
  onCancel,
}: {
  disagreementId: string;
  to: DisagreementState;
  busy: boolean;
  onSubmit: (verdict: ReviewerVerdict, rationale: string) => void;
  onCancel: () => void;
}) {
  const [verdict, setVerdict] = useState<ReviewerVerdict | "">("");
  const [rationale, setRationale] = useState("");

  const trimmed = rationale.trim();
  const canSubmit =
    !busy &&
    verdict.length > 0 &&
    (REVIEWER_VERDICTS as ReadonlyArray<string>).includes(verdict) &&
    trimmed.length > 0 &&
    trimmed.length <= RATIONALE_MAX;

  return (
    <div
      data-disagreement-resolve-picker={disagreementId}
      style={{
        padding: 12,
        background: "rgba(15, 23, 42, 0.04)",
        borderTop: "1px solid #cbd5e1",
        borderBottom: "1px solid #cbd5e1",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ color: "#0f172a", fontSize: 12, fontWeight: 600 }}>
        Resolve disagreement → {STATE_LABELS[to] ?? to}. Choose a
        verdict and explain.
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
        <span>Verdict</span>
        <select
          data-disagreement-resolve-verdict-select
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as ReviewerVerdict | "")}
          disabled={busy}
          style={selectStyle}
        >
          <option value="">Choose a verdict…</option>
          {RESOLUTION_VERDICTS.map((v) => (
            <option key={v} value={v}>
              {VERDICT_LABELS[v] ?? v}
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
          data-disagreement-resolve-rationale
          value={rationale}
          maxLength={RATIONALE_MAX}
          onChange={(e) => setRationale(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder="Why is this disagreement being resolved this way?"
          style={textareaStyle}
        />
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          data-disagreement-resolve-cancel
          onClick={onCancel}
          disabled={busy}
          style={cancelBtnStyle}
        >
          Cancel
        </button>
        <button
          type="button"
          data-disagreement-resolve-submit
          disabled={!canSubmit}
          onClick={() => onSubmit(verdict as ReviewerVerdict, trimmed)}
          style={resolveSubmitStyle(canSubmit)}
        >
          {busy ? "Submitting…" : "Record resolution"}
        </button>
      </div>
    </div>
  );
}

/**
 * Render the challenger rationale truncated to 300 chars. The full
 * value lives on the row; we never write it back, never include it in
 * audit metadata downstream, and never embed it raw in banner copy.
 */
function ChallengerRationalePreview({ value }: { value: string | null }) {
  if (!value || value.trim().length === 0) {
    return <span style={{ color: "#94a3b8" }}>—</span>;
  }
  const trimmed = value.trim();
  const truncated =
    trimmed.length > CHALLENGER_RATIONALE_PREVIEW_MAX
      ? `${trimmed.slice(0, CHALLENGER_RATIONALE_PREVIEW_MAX)}…`
      : trimmed;
  return (
    <span
      data-disagreement-challenger-rationale
      style={{
        color: "#475569",
        fontSize: 11,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {truncated}
    </span>
  );
}

function LifecycleTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        background: "#f8fafc",
        padding: "10px 12px",
      }}
    >
      <div style={{ color: "#64748b", fontSize: 11 }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function OwnerCell({ row }: { row: DisagreementRow }) {
  const owner =
    row.state === "UNDER_SECOND_REVIEW"
      ? row.secondReviewerUserId
      : row.state === "UNDER_SUPERVISOR_REVIEW"
        ? row.supervisorUserId
        : row.state.startsWith("RESOLVED_")
          ? row.resolvedByUserId ?? row.supervisorUserId ?? row.secondReviewerUserId
          : null;
  if (!owner) {
    return <span style={{ color: "#94a3b8" }}>awaiting assignment</span>;
  }
  return <code>{owner.slice(0, 8)}…</code>;
}

function ResolutionCell({ row }: { row: DisagreementRow }) {
  if (!row.state.startsWith("RESOLVED_")) {
    return (
      <span style={{ color: "#475569", fontSize: 11 }}>
        Filed {new Date(row.filedAtUtc).toLocaleString()}
      </span>
    );
  }
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <strong style={{ fontSize: 12, color: "#0f172a" }}>
        {row.resolution ? VERDICT_LABELS[row.resolution] : "Resolved"}
      </strong>
      <span style={{ color: "#475569", fontSize: 11 }}>
        {row.resolvedAtUtc
          ? new Date(row.resolvedAtUtc).toLocaleString()
          : "Resolution time not recorded"}
      </span>
    </div>
  );
}

function formatAge(filedAtUtc: string, resolvedAtUtc: string | null): string {
  const end = resolvedAtUtc ? Date.parse(resolvedAtUtc) : Date.now();
  const deltaMs = Math.max(0, end - Date.parse(filedAtUtc));
  const hours = Math.round(deltaMs / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
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
const td = {
  padding: "8px 10px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
} as const;
function transBtnStyle(disabled: boolean, isArmed: boolean) {
  return {
    padding: "4px 8px",
    borderRadius: 8,
    border: isArmed ? "1px solid #0f172a" : "1px solid #cbd5e1",
    background: isArmed ? "#0f172a" : "#fff",
    color: isArmed ? "#fafafa" : "#0f172a",
    fontSize: 11,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  } as const;
}
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
function resolveSubmitStyle(enabled: boolean) {
  return {
    padding: "5px 10px",
    borderRadius: 8,
    border: "none",
    background: enabled ? "#0f172a" : "#cbd5e1",
    color: enabled ? "#fafafa" : "#475569",
    fontWeight: 600,
    fontSize: 11,
    cursor: enabled ? "pointer" : "not-allowed",
  } as const;
}
const selectStyle = {
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "#fff",
  fontSize: 13,
  color: "#0f172a",
} as const;
const textareaStyle = {
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "#fff",
  fontSize: 13,
  color: "#0f172a",
  resize: "vertical" as const,
};
