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
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  QC_FAILURE_REASONS,
  QC_VERDICTS,
  identifierLabel,
  type ReviewerCapability,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational";
import { Button } from "../../../../components/ui/Button";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import {
  useActiveSpaceId,
  usePlatformContext,
} from "../../../../lib/platform-context";
import {
  fetchReviewerWorkspace,
  renderQcVerdict,
} from "../../../../lib/reviewer-workspace/reviewer-api";

/**
 * Batch J — QC reviewer assignment.
 *
 *   POST /v1/reviewer/qc/samples/:id/assign?teamId=  { qcReviewerUserId }
 *     (review.assign; 409 QC_SAMPLE_NOT_FOUND | QC_VERDICT_INVALID |
 *      NOT_PERMITTED when the chosen user is not an active member)
 *
 * Samples are created with no reviewer, and the server refuses a verdict
 * from anyone but the assigned QC reviewer — so before this, every verdict
 * posted from this page was refused. Assigners pick from the workspace's
 * assignable reviewers (GET /v1/reviewer-ops/assignable-reviewers); verdict
 * buttons are enabled only for the assignee and otherwise say why.
 */
type AssignableReviewer = { userId: string; displayName: string | null };
type Load<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "denied" }
  | { kind: "failed"; message: string };

function statusOf(err: unknown): number {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : 0;
}
function codeOf(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "";
}

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
  // Keyed so a workspace switch drops every pending response and open form.
  return <QcWorkspace key={teamId} teamId={teamId} />;
}

function QcWorkspace({ teamId }: { teamId: string }) {
  const { envelope } = usePlatformContext();
  const viewerUserId = envelope?.account?.userId ?? null;
  const { confirm } = useConfirmAction();
  const [rows, setRows] = useState<QcRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [caps, setCaps] = useState<ReadonlyArray<ReviewerCapability> | "loading" | "failed">("loading");
  const [reviewers, setReviewers] = useState<Load<AssignableReviewer[]>>({ kind: "idle" });
  const [assignOpenSampleId, setAssignOpenSampleId] = useState<string | null>(null);
  const [assignResult, setAssignResult] = useState<{ sampleId: string; tone: "status" | "alert"; text: string } | null>(null);
  /**
   * Which sample currently has the FAIL picker open. Null when no
   * picker is open. Only one row can have the picker open at a time —
   * keeps the UI simple and prevents accidentally submitting against
   * the wrong row.
   */
  const [failOpenSampleId, setFailOpenSampleId] = useState<string | null>(null);
  /** In-flight guard so the operator cannot double-fire a verdict. */
  const [busySampleId, setBusySampleId] = useState<string | null>(null);
  const alive = useRef(true);
  const requestSeq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const samplesUrl = `/v1/reviewer/qc/samples?limit=100${mineOnly ? "&mine=true" : ""}&teamId=${encodeURIComponent(teamId)}`;

  // Only the newest read may write state, so a slow response for the
  // previous filter never paints under the current one.
  const refresh = useCallback(async (): Promise<QcRow[] | null> => {
    const seq = ++requestSeq.current;
    try {
      const res = await apiFetch(samplesUrl, { method: "GET" });
      const list = (res?.samples ?? []) as QcRow[];
      if (!alive.current || seq !== requestSeq.current) return list;
      setRows(list);
      setLoadError(null);
      return list;
    } catch (err) {
      if (!alive.current || seq !== requestSeq.current) return null;
      setLoadError(
        statusOf(err) === 403
          ? "You do not have access to QC samples in this workspace."
          : toSafeUserError(err, {
              message: "QC samples could not be loaded. Refresh to try again.",
            }).message,
      );
      return null;
    }
  }, [samplesUrl]);

  useEffect(() => {
    setRows(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    fetchReviewerWorkspace(teamId)
      .then((ws) => {
        if (alive.current) setCaps(ws ? ws.capabilities : "failed");
      })
      .catch(() => {
        if (alive.current) setCaps("failed");
      });
  }, [teamId]);

  const canAssign = Array.isArray(caps) && caps.includes("review.assign");
  const assignReason =
    caps === "loading"
      ? "Checking your reviewer permissions…"
      : caps === "failed"
        ? "Your reviewer permissions could not be loaded. Refresh the page to try again."
        : !canAssign
          ? "Only reviewers who can assign reviews can assign QC samples."
          : undefined;

  // The reviewer pool is read once an assigner needs it.
  useEffect(() => {
    if (!canAssign || reviewers.kind !== "idle") return;
    setReviewers({ kind: "loading" });
    apiFetch(
      `/v1/reviewer-ops/assignable-reviewers?teamId=${encodeURIComponent(teamId)}&limit=200`,
      { method: "GET" },
    )
      .then((res: { reviewers?: AssignableReviewer[] } | null) => {
        if (alive.current) setReviewers({ kind: "ready", value: Array.isArray(res?.reviewers) ? res.reviewers : [] });
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setReviewers(
          statusOf(err) === 403
            ? { kind: "denied" }
            : {
                kind: "failed",
                message: toSafeUserError(err, {
                  message: "The reviewer list could not be loaded. Try again.",
                }).message,
              },
        );
      });
  }, [canAssign, reviewers.kind, teamId]);

  const reviewerName = useCallback(
    (userId: string | null): ReactNode => {
      if (!userId) return "Unassigned";
      if (userId === viewerUserId) return "You";
      const known = reviewers.kind === "ready" ? reviewers.value.find((r) => r.userId === userId) : undefined;
      if (known?.displayName) return known.displayName;
      return (
        <>
          Another reviewer <code data-identifier>{userId}</code>
        </>
      );
    },
    [reviewers, viewerUserId],
  );

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
      if (busySampleId) return;
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
          setBanner(`Verdict ${identifierLabel(verdict)} recorded.`);
          setFailOpenSampleId(null);
          await refresh();
        } else {
          setBanner(`Verdict refused: ${identifierLabel(res.denial)}`);
        }
      } finally {
        if (alive.current) setBusySampleId(null);
      }
    },
    [refresh, busySampleId, teamId],
  );

  const onAssign = useCallback(
    async (sample: QcRow, qcReviewerUserId: string): Promise<boolean> => {
      if (busySampleId || !canAssign) return false;
      setAssignResult(null);
      setBusySampleId(sample.id);
      try {
        if (sample.qcReviewerUserId && sample.qcReviewerUserId !== qcReviewerUserId) {
          const ok = await confirm({
            title: "Reassign this QC sample?",
            description:
              "The current QC reviewer will no longer be able to record the verdict for this sample.",
            confirmLabel: "Reassign",
            tone: "warning",
          });
          if (!ok || !alive.current) return false;
        }
        try {
          await apiFetch(
            `/v1/reviewer/qc/samples/${encodeURIComponent(sample.id)}/assign?teamId=${encodeURIComponent(teamId)}`,
            { method: "POST", body: JSON.stringify({ qcReviewerUserId }) },
          );
        } catch (err) {
          if (!alive.current) return false;
          const code = codeOf(err);
          const status = statusOf(err);
          setAssignResult({
            sampleId: sample.id,
            tone: "alert",
            text:
              code === "QC_VERDICT_INVALID"
                ? "This sample already has a verdict, so it can no longer be assigned. The list has been refreshed."
                : code === "QC_SAMPLE_NOT_FOUND"
                  ? "This sample no longer exists in this workspace. The list has been refreshed."
                  : status === 409 && code === "NOT_PERMITTED"
                    ? "That person is not an active member of this workspace. Choose another reviewer."
                    : status === 403
                      ? "Only reviewers who can assign reviews can assign QC samples."
                      : toSafeUserError(err, {
                          message: "The QC sample could not be assigned. Nothing was changed.",
                        }).message,
          });
          if (code === "QC_VERDICT_INVALID" || code === "QC_SAMPLE_NOT_FOUND") await refresh();
          return false;
        }
        const list = await refresh();
        if (!alive.current) return false;
        const reread = list?.find((r) => r.id === sample.id);
        // A "Mine" view legitimately drops a sample assigned to someone else.
        const confirmed = reread
          ? reread.qcReviewerUserId === qcReviewerUserId
          : Boolean(list) && mineOnly && qcReviewerUserId !== viewerUserId;
        if (confirmed) {
          setAssignOpenSampleId(null);
          setAssignResult({
            sampleId: sample.id,
            tone: "status",
            text: "QC reviewer assigned. The saved sample shows the new assignee.",
          });
          return true;
        }
        setAssignResult({
          sampleId: sample.id,
          tone: "alert",
          text: list
            ? "The assignment was sent, but the saved sample does not show it yet. Refresh before continuing."
            : "The assignment was sent, but the samples could not be reloaded to confirm it. Refresh before continuing.",
        });
        return false;
      } finally {
        if (alive.current) setBusySampleId(null);
      }
    },
    [busySampleId, canAssign, confirm, mineOnly, refresh, teamId, viewerUserId],
  );

  return (
    <div
      data-qc-page
      style={{
        padding: 24,
        maxWidth: 1100,
        margin: "0 auto",
        color: "#0f172a",
        minWidth: 0,
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
        <QcMetric label="Pending samples" value={rows ? pending.length : "—"} />
        <QcMetric label="Rendered verdicts" value={rows ? rendered.length : "—"} />
        <QcMetric label="Loaded sample set" value={rows ? rows.length : "—"} />
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
        reached QC, not every closed workflow in the workspace. Only the
        assigned QC reviewer can record a sample&apos;s verdict.
      </div>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={mineOnly}
          onChange={(e) => setMineOnly(e.target.checked)}
          data-qc-mine-filter
        />
        Only samples assigned to me
      </label>
      {banner ? (
        <div
          data-qc-banner
          role="status"
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
      {canAssign && reviewers.kind === "denied" ? (
        <p role="alert" style={{ fontSize: 13 }}>
          The reviewer list is not available to you, so QC samples cannot be assigned from here.
        </p>
      ) : null}
      {canAssign && reviewers.kind === "failed" ? (
        <p role="alert" style={{ fontSize: 13 }}>{reviewers.message}</p>
      ) : null}

      {loadError ? (
        <div role="alert" data-qc-load-error style={{ marginBottom: 18, fontSize: 13 }}>
          {loadError}{" "}
          <Button size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : null}
      {rows === null && !loadError ? (
        <p role="status" style={{ fontSize: 13 }}>Loading QC samples…</p>
      ) : null}

      {rows !== null && !loadError && rows.length === 0 ? (
        <div style={{ marginBottom: 18 }}>
          {mineOnly ? (
            <p>No QC samples are assigned to you.</p>
          ) : (
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
          )}
        </div>
      ) : null}

      {rows !== null && !loadError ? (
        <>
          <h2 style={h2}>Pending ({pending.length})</h2>
          <QcTable
            rows={pending}
            onVerdict={onVerdict}
            failOpenSampleId={failOpenSampleId}
            onOpenFailPicker={setFailOpenSampleId}
            busySampleId={busySampleId}
            viewerUserId={viewerUserId}
            reviewerName={reviewerName}
            assign={{
              reason: assignReason,
              reviewers,
              openSampleId: assignOpenSampleId,
              onOpen: (id) => {
                setAssignResult(null);
                setAssignOpenSampleId(id);
              },
              onSubmit: onAssign,
              result: assignResult,
            }}
          />

          <h2 style={h2}>Rendered ({rendered.length})</h2>
          <QcTable
            rows={rendered}
            onVerdict={() => Promise.resolve()}
            readOnly
            failOpenSampleId={null}
            onOpenFailPicker={() => {}}
            busySampleId={null}
            viewerUserId={viewerUserId}
            reviewerName={reviewerName}
          />
        </>
      ) : null}
    </div>
  );
}

type AssignControls = {
  reason: string | undefined;
  reviewers: Load<AssignableReviewer[]>;
  openSampleId: string | null;
  onOpen: (sampleId: string | null) => void;
  onSubmit: (sample: QcRow, qcReviewerUserId: string) => Promise<boolean>;
  result: { sampleId: string; tone: "status" | "alert"; text: string } | null;
};

function QcTable({
  rows,
  onVerdict,
  readOnly,
  failOpenSampleId,
  onOpenFailPicker,
  busySampleId,
  viewerUserId,
  reviewerName,
  assign,
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
  viewerUserId: string | null;
  reviewerName: (userId: string | null) => ReactNode;
  assign?: AssignControls;
}) {
  const toggleRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  return (
    <div style={{ overflowX: "auto", marginBottom: 18 }}>
      <table
        data-qc-table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", color: "#475569" }}>
            <th style={th}>Workflow</th>
            <th style={th}>State</th>
            <th style={th}>QC reviewer</th>
            <th style={th}>Verdict</th>
            <th style={th}>Sampled at</th>
            <th style={th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isFailOpen = failOpenSampleId === r.id;
            const isAssignOpen = assign?.openSampleId === r.id;
            const isBusy = busySampleId === r.id;
            const verdictReason = !r.qcReviewerUserId
              ? "Assign a QC reviewer before recording a verdict."
              : !viewerUserId
                ? "Your account could not be identified. Refresh the page."
                : r.qcReviewerUserId !== viewerUserId
                  ? "Only the assigned QC reviewer can record this verdict."
                  : undefined;
            const assignable = r.state === "SAMPLED" || r.state === "ASSIGNED";
            const result = assign?.result?.sampleId === r.id ? assign.result : null;
            return (
              <RowFragment key={r.id} sampleId={r.id}>
                <tr data-qc-row={r.id}>
                  <td style={td}>
                    <code data-identifier>{r.workflowId.slice(0, 8)}…</code>
                  </td>
                  <td style={td}>{identifierLabel(r.state)}</td>
                  <td style={td} data-qc-assignee={r.id}>{reviewerName(r.qcReviewerUserId)}</td>
                  <td style={td}>
                    {r.verdict ? identifierLabel(r.verdict) : "—"}
                    {r.failureReason ? (
                      <div style={{ color: "#64748b", fontSize: 11 }}>
                        {QC_FAILURE_REASON_LABELS[r.failureReason] ??
                          identifierLabel(r.failureReason)}
                      </div>
                    ) : null}
                  </td>
                  <td style={td}>{formatUserDateTime(r.sampledAtUtc)}</td>
                  <td style={td}>
                    {readOnly ? (
                      "—"
                    ) : (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {QC_VERDICTS.map((v) => {
                          const reason =
                            verdictReason ??
                            (isFailOpen && v !== "FAIL"
                              ? "Finish or cancel the failure form first."
                              : undefined);
                          return (
                            <Button
                              key={v}
                              size="sm"
                              variant={v === "FAIL" ? "destructive" : v === "PASS" ? "primary" : "secondary"}
                              data-qc-verdict-btn={v}
                              disabled={isBusy || Boolean(reason)}
                              disabledReason={reason}
                              aria-label={`${identifierLabel(v)} verdict`}
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
                            >
                              {identifierLabel(v)}
                            </Button>
                          );
                        })}
                        {assign && assignable ? (
                          <Button
                            size="sm"
                            ref={(el) => {
                              toggleRefs.current[r.id] = el;
                            }}
                            aria-expanded={isAssignOpen}
                            aria-controls={`qc-assign-${r.id}`}
                            disabled={Boolean(assign.reason) || isBusy}
                            disabledReason={assign.reason}
                            onClick={() => assign.onOpen(isAssignOpen ? null : r.id)}
                            data-qc-assign-toggle={r.id}
                          >
                            {r.qcReviewerUserId ? "Reassign QC reviewer" : "Assign QC reviewer"}
                          </Button>
                        ) : null}
                      </div>
                    )}
                    {result ? (
                      <p role={result.tone} data-qc-assign-result={result.tone} style={{ fontSize: 12, margin: "6px 0 0" }}>
                        {result.text}
                      </p>
                    ) : null}
                  </td>
                </tr>
                {isAssignOpen && assign ? (
                  <tr data-qc-assign-row={r.id}>
                    <td colSpan={6} style={{ padding: 0 }}>
                      <QcAssignForm
                        id={`qc-assign-${r.id}`}
                        sample={r}
                        busy={isBusy}
                        reviewers={assign.reviewers}
                        onCancel={() => {
                          assign.onOpen(null);
                          toggleRefs.current[r.id]?.focus();
                        }}
                        onSubmit={async (userId) => {
                          const done = await assign.onSubmit(r, userId);
                          if (done) toggleRefs.current[r.id]?.focus();
                        }}
                      />
                    </td>
                  </tr>
                ) : null}
                {isFailOpen ? (
                  <tr data-qc-fail-picker-row={r.id}>
                    <td colSpan={6} style={{ padding: 0 }}>
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
    </div>
  );
}

function QcAssignForm({
  id,
  sample,
  busy,
  reviewers,
  onCancel,
  onSubmit,
}: {
  id: string;
  sample: QcRow;
  busy: boolean;
  reviewers: Load<AssignableReviewer[]>;
  onCancel: () => void;
  onSubmit: (userId: string) => Promise<void>;
}) {
  const fieldId = useId();
  const [choice, setChoice] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);
  const ready = reviewers.kind === "ready";
  useEffect(() => {
    if (ready) selectRef.current?.focus();
  }, [ready]);
  const reason = busy
    ? undefined
    : !ready
      ? "Load the reviewer list first."
      : !choice
        ? "Choose a reviewer."
        : choice === sample.qcReviewerUserId
          ? "That reviewer is already assigned."
          : undefined;
  return (
    <form
      id={id}
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason && !busy) void onSubmit(choice);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
      style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", borderTop: "1px solid var(--border)" }}
    >
      {reviewers.kind === "loading" || reviewers.kind === "idle" ? (
        <p role="status" style={{ margin: 0, fontSize: 12 }}>Loading reviewers…</p>
      ) : null}
      {ready && reviewers.value.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12 }}>
          No workspace member can review QC samples yet. Invite a reviewer first.
        </p>
      ) : null}
      {ready && reviewers.value.length > 0 ? (
        <label htmlFor={fieldId} style={{ display: "grid", gap: 4, fontSize: 12, flex: "1 1 200px", minWidth: 0 }}>
          QC reviewer
          <select
            id={fieldId}
            ref={selectRef}
            value={choice}
            disabled={busy}
            onChange={(e) => setChoice(e.target.value)}
            style={{ maxWidth: "100%" }}
          >
            <option value="">Choose a reviewer…</option>
            {reviewers.value.map((rv) => (
              <option key={rv.userId} value={rv.userId}>
                {rv.displayName ?? `Unnamed member (${rv.userId.slice(0, 8)})`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Button type="submit" size="sm" variant="primary" loading={busy} disabled={Boolean(reason)} disabledReason={reason} data-qc-assign-submit>
        Assign
      </Button>
      <Button size="sm" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </form>
  );
}

function QcMetric({ label, value }: { label: string; value: number | string }) {
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
