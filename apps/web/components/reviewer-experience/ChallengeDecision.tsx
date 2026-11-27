"use client";

/**
 * Challenge a recorded decision (filed as a reviewer disagreement).
 *
 * Moved from the retired Reviewer Workspace onto the shared Review page and
 * its focus mode (stage D, T-077) — Team keeps disagreements (direction 12).
 * The canonical `POST /v1/reviewer/work/:id/disagree` needs a real recorded
 * decision id, so the form lists the review's decisions
 * (`GET /v1/reviewer-ops/workspace/:id/decisions`) instead of taking free text.
 *
 * Named "Challenge a decision" (T-081): a filed challenge is a different thing
 * from a Conflict (two reviews that differ, waiting for adjudication).
 *
 * Review remediation 2026-11-27 (F-07): the host renders this only when the
 * server allows `challenge`, and the chooser lists ONLY the decisions the
 * server named challengeable (`viewer.challengeableDecisionIds`: recorded in
 * the current round, not by the viewer). Cancel collapses and keeps the draft;
 * a filed challenge links to Challenged decisions.
 */

import { reviewerDenialMessage } from "@proovra/shared";
import Link from "next/link";
import { useCallback, useId, useState } from "react";

import { formatUserDateTime } from "../../lib/date";
import {
  fileDisagreement,
  listWorkflowDecisions,
  type WorkflowDecisionRow,
} from "../../lib/reviewer-workspace/reviewer-api";
import { reviewerIdentityLabel } from "../../lib/reviewer-workspace/reviewer-identity";
import { AppListbox } from "../app-primitives/AppListbox";
import { DECISION_KIND_LABELS } from "../../app/(app)/reviewer-ops/[reviewId]/_components/inspector-model";

type Phase =
  | { phase: "CLOSED" }
  | { phase: "LOADING" }
  | { phase: "READY"; decisions: WorkflowDecisionRow[] }
  | { phase: "EMPTY" }
  | { phase: "ERROR" };

const MAX = 600;

const STAGE_WORDS: Readonly<Record<string, string>> = {
  FIRST: "First review",
  SECOND: "Second review",
  ADJUDICATION: "Adjudication",
};

export function ChallengeDecision({
  teamId,
  workflowId,
  viewerUserId,
  challengeableDecisionIds,
  onFiled,
}: {
  teamId: string;
  workflowId: string;
  viewerUserId: string | null;
  /** The server's challengeable decisions; absent (older API) = every recorded one. */
  challengeableDecisionIds?: ReadonlyArray<string> | null;
  onFiled?: () => void;
}) {
  const id = useId();
  const [state, setState] = useState<Phase>({ phase: "CLOSED" });
  const [selectedId, setSelectedId] = useState("");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string; filed?: boolean } | null>(null);
  const trimmed = rationale.trim();
  const tooLong = trimmed.length > MAX;

  const open = useCallback(async () => {
    setNotice(null);
    setState({ phase: "LOADING" });
    const all = await listWorkflowDecisions({ workflowId, teamId });
    const allowed = challengeableDecisionIds ? new Set(challengeableDecisionIds) : null;
    const rows = all === null ? null : allowed ? all.filter((d) => allowed.has(d.id)) : all;
    if (rows === null) setState({ phase: "ERROR" });
    else if (rows.length === 0) setState({ phase: "EMPTY" });
    else {
      setState({ phase: "READY", decisions: rows });
      // A kept selection that is no longer challengeable is dropped.
      setSelectedId((prev) => (rows.some((d) => d.id === prev) ? prev : ""));
    }
  }, [teamId, workflowId, challengeableDecisionIds]);

  const submit = async () => {
    if (state.phase !== "READY" || !selectedId || !trimmed || tooLong || busy) return;
    setBusy(true);
    try {
      const res = await fileDisagreement({ workflowId, originalDecisionId: selectedId, rationale: trimmed, teamId });
      if (res.ok) {
        setNotice({ ok: true, text: "Challenge filed. An owner or admin who made neither decision resolves it.", filed: true });
        setState({ phase: "CLOSED" });
        setSelectedId("");
        setRationale("");
        onFiled?.();
      } else {
        // Keep the form and the typed text for a retry.
        setNotice({ ok: false, text: `Challenge not filed. ${reviewerDenialMessage(res.denial)}` });
      }
    } catch {
      setNotice({ ok: false, text: "Challenge not filed. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const disabledReason =
    state.phase === "LOADING"
      ? "Recorded decisions are still loading."
      : state.phase === "EMPTY"
        ? "There is no recorded decision you can challenge."
        : state.phase === "ERROR"
          ? "Recorded decisions could not be loaded."
          : !selectedId
            ? "Choose the decision you challenge."
            : tooLong
              ? `Keep the rationale to ${MAX} characters.`
              : !trimmed
                ? "Write a rationale first."
                : null;

  return (
    <section className="app-panel" aria-labelledby={`${id}-title`} data-review-challenge data-review-challenge-phase={state.phase}>
      <div className="app-panel__head">
        <h2 id={`${id}-title`} className="app-panel__title">
          Challenge a decision
        </h2>
        {state.phase === "CLOSED" ? (
          <button type="button" className="app-secondary-action" data-review-challenge-open onClick={() => void open()}>
            Challenge…
          </button>
        ) : null}
      </div>
      <div className="app-panel__body" style={{ display: "grid", gap: 6, minWidth: 0 }}>
        {notice ? (
          <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "app-field-help" : "app-field-error"} data-review-challenge-notice style={{ margin: 0 }}>
            {notice.text}
            {notice.filed ? (
              <>
                {" "}
                <Link href="/review/disagreements" data-review-challenge-filed-link>
                  Open Challenged decisions
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {state.phase === "CLOSED" ? (
          <p className="app-field-help" style={{ margin: 0 }}>
            Formally challenge a recorded decision. A workspace owner or admin resolves the challenge.
          </p>
        ) : null}
        {state.phase === "LOADING" ? (
          <p role="status" className="app-field-help" style={{ margin: 0 }}>
            Loading recorded decisions…
          </p>
        ) : null}
        {state.phase === "EMPTY" ? (
          <p className="app-field-help" style={{ margin: 0 }} data-review-challenge-empty>
            There is no recorded decision you can challenge on this review.
          </p>
        ) : null}
        {state.phase === "ERROR" ? (
          <p role="alert" className="app-field-error" style={{ margin: 0 }}>
            Recorded decisions could not be loaded. Try again.
          </p>
        ) : null}
        {state.phase === "READY" ? (
          <>
            <label htmlFor={`${id}-decision`} className="app-field-label">
              Which decision are you challenging?
            </label>
            <AppListbox
              id={`${id}-decision`}
              value={selectedId}
              placeholder="Choose a recorded decision…"
              options={state.decisions.map((d) => ({
                value: d.id,
                label: `${STAGE_WORDS[d.stage] ?? "Review"} · ${DECISION_KIND_LABELS[d.decision] ?? "Decision"} · ${reviewerIdentityLabel(
                  { userId: d.reviewer.userId, displayName: d.reviewer.displayName, maskedEmail: d.reviewer.email },
                  viewerUserId,
                )} · ${formatUserDateTime(d.decidedAt)}`,
              }))}
              onChange={setSelectedId}
              triggerProps={{ "data-review-challenge-decision": "" }}
            />
            <label htmlFor={`${id}-rationale`} className="app-field-label">
              Rationale (required, up to {MAX} characters)
            </label>
            <textarea
              id={`${id}-rationale`}
              className="app-input app-textarea"
              rows={3}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              data-review-challenge-rationale
            />
          </>
        ) : null}
        {state.phase !== "CLOSED" ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {disabledReason ? (
              <span id={`${id}-reason`} className="app-field-help" style={{ margin: 0 }} data-review-challenge-reason>
                {disabledReason}
              </span>
            ) : null}
            {/* Cancel collapses the form; the chosen decision and the typed text are kept. */}
            <button type="button" className="app-ghost-action" onClick={() => setState({ phase: "CLOSED" })} data-review-challenge-cancel>
              Cancel
            </button>
            <button
              type="button"
              className="app-secondary-action app-secondary-action--filled"
              disabled={disabledReason !== null || busy}
              aria-busy={busy || undefined}
              aria-describedby={disabledReason ? `${id}-reason` : undefined}
              onClick={() => void submit()}
              data-review-challenge-submit
            >
              {busy ? "Filing…" : "File challenge"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
