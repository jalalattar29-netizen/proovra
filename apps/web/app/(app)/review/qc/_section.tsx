"use client";

/**
 * PROOVRA Phase 2A — QC workspace, now Monitoring → Quality (stage D, T-078).
 * `/review/qc` redirects to `/reviewer-ops/sla?section=quality`. Human QC
 * samples come first; Copilot output checks are a separate block (T-080).
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

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
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

import { OperationalEmptyState } from "../../../../components/operational";
import { CanonicalActionButton } from "../../../../components/external-review/CanonicalActionButton";
import { recordReference } from "../../../../lib/short-id";
import { UNNAMED_REVIEWER } from "../../../../lib/reviewer-workspace/reviewer-identity";
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

/** Monitoring → Quality: human QC samples (gated by the Monitoring page on `workspace.review_qc`). */
export function QcSection() {
  const teamId = useActiveSpaceId();
  if (!teamId) {
    return (
      <OperationalEmptyState
        title="Select a workspace"
        reason="Choose an active workspace before loading QC samples."
      />
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
      return UNNAMED_REVIEWER;
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
      // PRO-R2-05 — a QC verdict is final: PASS / PARTIAL ask first, like the
      // FAIL path does through its picker.
      if (verdict !== "FAIL") {
        const ok = await confirm({
          title: verdict === "PASS" ? "Record a PASS verdict?" : "Record a PARTIAL verdict?",
          description: "The quality-check verdict is final for this sample.",
          confirmLabel: verdict === "PASS" ? "Record PASS" : "Record PARTIAL",
          tone: "warning",
        });
        if (!ok) return;
      }
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
          setBanner(
            res.denial === "QC_REVIEWER_NOT_INDEPENDENT"
              ? "You decided the sampled review, so you cannot quality-check it. Another reviewer must record the verdict."
              : `Verdict refused: ${identifierLabel(res.denial)}`,
          );
        }
      } finally {
        if (alive.current) setBusySampleId(null);
      }
    },
    [refresh, busySampleId, teamId, confirm],
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
              code === "QC_REVIEWER_NOT_INDEPENDENT"
                ? "That person decided the sampled review, so they cannot quality-check it. Choose someone who did not decide it."
                : code === "QC_VERDICT_INVALID"
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
    // TEAM-UI-SPEC §1/§5 — the canonical page header (PageShell + PageHeader,
    // as every other Review page and the Evidence Library), not a loose <h1>.
    <div className="review-monitoring-section" data-qc-page data-monitoring-section-body="quality">
      <h2 className="app-panel__title" style={{ margin: 0 }}>Quality control samples</h2>
      <p className="app-field-help" style={{ margin: 0 }}>
        Human review of a sample of closed reviews. Verdicts feed reviewer accuracy metrics.
      </p>
      <div
        data-qc-metrics
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        <QcMetric label="Pending samples" value={rows ? pending.length : "—"} />
        <QcMetric label="Rendered verdicts" value={rows ? rendered.length : "—"} />
        <QcMetric label="Loaded sample set" value={rows ? rows.length : "—"} />
      </div>
      <p className="app-field-help" data-qc-scope-note style={{ margin: 0 }}>
        QC samples are generated from closed workflows through the canonical
        approve and reject lifecycle. This page shows the sampled set that has
        reached QC, not every closed workflow in the workspace. Only the
        assigned QC reviewer can record a sample&apos;s verdict.
      </p>
      <label className="app-field-label" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
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
          className="app-panel"
        >
          <div className="app-panel__body">{banner}</div>
        </div>
      ) : null}
      {canAssign && reviewers.kind === "denied" ? (
        <p role="alert" className="app-field-error">
          The reviewer list is not available to you, so QC samples cannot be assigned from here.
        </p>
      ) : null}
      {canAssign && reviewers.kind === "failed" ? (
        <p role="alert" className="app-field-error">{reviewers.message}</p>
      ) : null}

      {loadError ? (
        <div role="alert" data-qc-load-error className="app-panel">
          <div className="app-panel__body" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <span style={{ flex: "1 1 220px", minWidth: 0 }}>{loadError}</span>
            <CanonicalActionButton variant="secondary" onClick={() => void refresh()}>
              Retry
            </CanonicalActionButton>
          </div>
        </div>
      ) : null}
      {rows === null && !loadError ? (
        <p role="status" className="app-field-help">Loading QC samples…</p>
      ) : null}

      {rows !== null && !loadError && rows.length === 0 ? (
        <div>
          {mineOnly ? (
            <OperationalEmptyState
              kicker="Quality control"
              title="No QC samples are assigned to you."
              reason="Clear the filter to see every sample in this workspace."
              emptyStateCode="review_qc_empty_mine"
            />
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
          <section className="app-panel" data-qc-section="pending">
            <div className="app-panel__head">
              <h2 className="app-panel__title">Pending ({pending.length})</h2>
            </div>
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
          </section>

          <section className="app-panel" data-qc-section="rendered">
            <div className="app-panel__head">
              <h2 className="app-panel__title">Rendered ({rendered.length})</h2>
            </div>
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
          </section>
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
    // TEAM-UI-SPEC §4 — the shared responsive cutover: `.app-table[data-responsive]`
    // collapses each row to a labelled card at ≤ 720 px, so nothing clips at
    // 320/390 px and there is no sideways table scroll on a phone.
    <div className="app-table-surface--scroll">
      <table data-qc-table className="app-table" data-responsive="">
        <thead>
          <tr>
            <th scope="col">Review</th>
            <th scope="col">State</th>
            <th scope="col">QC reviewer</th>
            <th scope="col">Verdict</th>
            <th scope="col">Sampled at</th>
            <th scope="col">Actions</th>
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
                  <td data-label="Review">
                    <a href={`/reviewer-ops/${encodeURIComponent(r.workflowId)}`} className="review-rows__ref">
                      {recordReference("Review", r.workflowId)}
                    </a>
                  </td>
                  <td data-label="State">{identifierLabel(r.state)}</td>
                  <td data-label="QC reviewer" data-qc-assignee={r.id}>{reviewerName(r.qcReviewerUserId)}</td>
                  <td data-label="Verdict">
                    {r.verdict ? identifierLabel(r.verdict) : "—"}
                    {r.failureReason ? (
                      <div className="app-table__muted">
                        {QC_FAILURE_REASON_LABELS[r.failureReason] ??
                          identifierLabel(r.failureReason)}
                      </div>
                    ) : null}
                  </td>
                  <td data-label="Sampled at">{formatUserDateTime(r.sampledAtUtc)}</td>
                  <td data-label="" style={{ flexWrap: "wrap" }}>
                    {readOnly ? (
                      "—"
                    ) : (
                      <div className="app-table__actions" style={{ flexWrap: "wrap", justifyContent: "flex-start" }}>
                        {QC_VERDICTS.map((v) => {
                          const reason =
                            verdictReason ??
                            (isFailOpen && v !== "FAIL"
                              ? "Finish or cancel the failure form first."
                              : undefined);
                          return (
                            // TEAM-UI-SPEC §1/§4 — row actions are secondary.
                            // A FAIL verdict is a judgement, not data
                            // destruction, so it carries no destructive style;
                            // the verdict is submitted from its own panel.
                            <CanonicalActionButton
                              key={v}
                              variant="secondary"
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
                            </CanonicalActionButton>
                          );
                        })}
                        {assign && assignable ? (
                          <CanonicalActionButton
                            variant="ghost"
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
                          </CanonicalActionButton>
                        ) : null}
                      </div>
                    )}
                    {result ? (
                      <p role={result.tone} data-qc-assign-result={result.tone} className={result.tone === "alert" ? "app-field-error" : "app-field-help"} style={{ margin: "6px 0 0" }}>
                        {result.text}
                      </p>
                    ) : null}
                  </td>
                </tr>
                {isAssignOpen && assign ? (
                  <tr data-qc-assign-row={r.id}>
                    <td colSpan={6} data-label="" style={{ padding: 0 }}>
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
                    <td colSpan={6} data-label="" style={{ padding: 0 }}>
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
  const selectRef = useRef<HTMLButtonElement>(null);
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
      style={{ padding: 12, width: "100%", boxSizing: "border-box", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}
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
        <label htmlFor={fieldId} className="app-field-label" style={{ display: "grid", gap: 4, flex: "1 1 200px", minWidth: 0 }}>
          QC reviewer
          <AppListbox
            value={choice}
            options={[
              { value: "", label: "Choose a reviewer…" },
              ...reviewers.value.map((rv) => ({ value: rv.userId, label: rv.displayName ?? UNNAMED_REVIEWER })),
            ]}
            onChange={(next) => setChoice(next)}
            id={fieldId}
            disabled={busy}
            triggerRef={selectRef}
            style={{ maxWidth: "100%" }}
          />
        </label>
      ) : null}
      <CanonicalActionButton variant="secondary" onClick={onCancel} disabled={busy}>
        Cancel
      </CanonicalActionButton>
      <CanonicalActionButton type="submit" variant="primary" busy={busy} disabled={Boolean(reason)} disabledReason={reason} data-qc-assign-submit>
        Assign
      </CanonicalActionButton>
    </form>
  );
}

function QcMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="app-panel" data-qc-metric={label}>
      <div className="app-panel__body">
        <div className="app-field-help" style={{ margin: 0 }}>{label}</div>
        <div className="app-table__primary" style={{ fontSize: 18 }}>{value}</div>
      </div>
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
      role="group"
      aria-label="Record QC failure"
      style={{
        padding: 12,
        width: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="app-panel__title">
        Record QC failure — choose a reason and explain.
      </div>
      <label
        className="app-field-label"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <span>Reason</span>
        <AppListbox
          value={failureReason}
          options={[
            { value: "", label: "Choose a reason…" },
            ...QC_FAILURE_REASONS.map((r) => ({ value: r, label: QC_FAILURE_REASON_LABELS[r] ?? r })),
          ]}
          onChange={(next) => setFailureReason(next)}
          disabled={busy}
          triggerProps={{ "data-qc-fail-reason-select": "" }}
        />
      </label>
      <label
        className="app-field-label"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
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
          className="app-input"
          style={{ resize: "vertical" }}
        />
      </label>
      {/* TEAM-UI-SPEC §1 — Cancel secondary + the verdict submit as the one
          primary in this panel (a FAIL verdict is not data destruction). */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <CanonicalActionButton
          variant="secondary"
          data-qc-fail-cancel
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </CanonicalActionButton>
        <CanonicalActionButton
          variant="primary"
          data-qc-fail-submit
          disabled={!canSubmit}
          disabledReason={
            busy
              ? null
              : failureReason.length === 0
                ? "Choose a failure reason."
                : trimmed.length === 0
                  ? "Explain why the sample failed."
                  : null
          }
          aria-busy={busy || undefined}
          onClick={() => onSubmit(failureReason, trimmed)}
        >
          {busy ? "Submitting…" : "Record FAIL"}
        </CanonicalActionButton>
      </div>
    </div>
  );
}


