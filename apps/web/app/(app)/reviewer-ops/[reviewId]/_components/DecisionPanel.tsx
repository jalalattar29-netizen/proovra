"use client";

/**
 * TEAM-UI-SPEC §2 — the ONE decision-entry form of the review inspector.
 *
 * Every verdict (FIRST and SECOND) and every adjudication is entered here and
 * posted to `POST /v1/reviewer-ops/workspace/:id/decisions` by the host page,
 * which handles the step-up challenge, maps refusals and reloads everything.
 * There are no standalone Approve / Reject / Request information buttons and
 * no second adjudication panel.
 *
 *   decision mode      Approve (internal) · Reject (internal) · Request
 *                      information — each enabled exactly as the server's
 *                      action map says, a closed one carrying its reason.
 *   adjudication mode  the adjudication kinds, for an independent owner or
 *                      admin while the two reviews disagree. Same layout.
 *
 * Then ONE rationale field (required, counter) with an optional category inside
 * the same field group (Team remediation T-012: there used to be a separate
 * "Reason (optional but recommended)" control beside the rationale), the
 * one-line consequence from the lineage state, and ONE primary submit labelled
 * by the choice. A refusal keeps the choice and the typed text and shows an
 * inline alert beside the controls (T-002); `blockedReason` disables submit
 * with its reason before anything is sent (T-015).
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import {
  ADJUDICATION_KINDS,
  DECISION_OPTION_LABELS,
  REASON_CODE_LABELS,
  VERDICT_ACTION,
  VERDICT_CHOICES,
  decisionConsequence,
  decisionSubmitLabel,
  type ActionMap,
} from "./inspector-model";

const MAX = 4000;

const REASON_CODES = [
  "EVIDENCE_INCOMPLETE",
  "REPORT_FAILED",
  "INTEGRITY_CONCERN",
  "CUSTODY_CONCERN",
  "MISSING_CONTEXT",
  "LEGAL_HOLD_ISSUE",
  "REDACTION_REQUIRED",
  "REVIEWER_DISAGREEMENT",
  "OTHER",
] as const;

export type DecisionSubmitBody = { decision: string; reasonCode?: string; rationale: string };

/** A request from the page to focus the form, optionally preselecting a choice. */
export type DecisionFocusRequest = { choice: string | null; nonce: number };

export function DecisionForm({
  mode,
  stage,
  actions,
  reviewState,
  secondRequired,
  onSubmit,
  focusRequest,
  blockedReason = null,
}: {
  mode: "decision" | "adjudication";
  /** FIRST or SECOND in decision mode; ignored for adjudication. */
  stage: "FIRST" | "SECOND";
  /** The server's action map; decides which verdict choices are open. */
  actions: ActionMap;
  reviewState: string | null;
  secondRequired: boolean;
  /** The page's decisions POST. Resolves to an error message, or null on success. */
  onSubmit: (body: DecisionSubmitBody) => Promise<string | null>;
  focusRequest?: DecisionFocusRequest | null;
  /** T-015 — when set, submission is closed for this reason (shown beside the controls). */
  blockedReason?: string | null;
}) {
  const id = useId();
  const choices: string[] = mode === "adjudication" ? ADJUDICATION_KINDS : VERDICT_CHOICES;
  const isOpen = useCallback(
    (choice: string): boolean => {
      if (mode === "adjudication") return true;
      const action = VERDICT_ACTION[choice as keyof typeof VERDICT_ACTION];
      return action ? actions[action].allowed : false;
    },
    [mode, actions],
  );
  const [choice, setChoice] = useState<string>("");
  const [reason, setReason] = useState<string>(mode === "adjudication" ? "REVIEWER_DISAGREEMENT" : "");
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rationaleRef = useRef<HTMLTextAreaElement | null>(null);

  // The page asks for focus ("Go to decision", or M with Request information
  // preselected). A preselection is honoured only when that choice is open.
  // A request made before this form mounted (it remounts after a reload) is
  // already spent: only a NEW request moves focus.
  const handledNonce = useRef(focusRequest?.nonce ?? 0);
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === handledNonce.current) return;
    handledNonce.current = focusRequest.nonce;
    const wanted = focusRequest.choice;
    if (wanted && choices.includes(wanted) && isOpen(wanted)) {
      setChoice(wanted);
      setError(null);
      const index = choices.indexOf(wanted);
      radioRefs.current[index]?.focus();
      return;
    }
    const selected = choices.indexOf(choice);
    const first = selected >= 0 ? selected : choices.findIndex((c) => isOpen(c));
    if (first >= 0) radioRefs.current[first]?.focus();
    // `choice` is read for the focus target only; a new request is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const pick = (next: string) => {
    if (!isOpen(next) || submitting) return;
    setChoice(next);
    setError(null);
  };

  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!forward && !back) return;
    e.preventDefault();
    for (let step = 1; step <= choices.length; step++) {
      const next = (index + (forward ? step : -step) + choices.length) % choices.length;
      if (isOpen(choices[next]!)) {
        pick(choices[next]!);
        radioRefs.current[next]?.focus();
        return;
      }
    }
  };

  const trimmed = rationale.trim();
  const ready = choice !== "" && trimmed.length > 0 && !submitting && !blockedReason;
  const consequence = decisionConsequence({ state: reviewState, secondRequired, choice });
  const closedReasons = choices
    .filter((c) => !isOpen(c))
    .map((c) => {
      const action = VERDICT_ACTION[c as keyof typeof VERDICT_ACTION];
      return action ? { choice: c, reason: actions[action].reason } : null;
    })
    .filter((r): r is { choice: string; reason: string | null } => Boolean(r && r.reason));
  // One line per distinct reason: three closed choices for one cause read once.
  const distinctReasons = Array.from(new Set(closedReasons.map((r) => r.reason as string)));

  const submit = async () => {
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    if (!choice) {
      setError("Choose a decision.");
      return;
    }
    if (!trimmed) {
      setError("Rationale is required.");
      rationaleRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    const failure = await onSubmit({
      decision: choice,
      reasonCode: reason || undefined,
      rationale: trimmed,
    });
    if (failure) {
      setError(failure);
    } else {
      setChoice("");
      setReason(mode === "adjudication" ? "REVIEWER_DISAGREEMENT" : "");
      setRationale("");
    }
    setSubmitting(false);
  };

  const legend =
    mode === "adjudication"
      ? "Adjudication outcome"
      : `Decision — ${stage === "FIRST" ? "first" : "second"} review`;

  return (
    <form
      data-decision-form
      data-decision-mode={mode}
      data-decision-form-stage={mode === "adjudication" ? "ADJUDICATION" : stage}
      {...(mode === "adjudication" ? { "data-adjudication-form": "" } : {})}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{ display: "grid", gap: 10, minWidth: 0 }}
    >
      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <span id={`${id}-legend`} className="app-field-label">
          {legend}
        </span>
        <div
          role="radiogroup"
          aria-labelledby={`${id}-legend`}
          aria-required="true"
          className="app-tabs"
          data-decision-form-decision
          {...(mode === "adjudication" ? { "data-adjudication-kind": "" } : {})}
          style={{ flexWrap: "wrap", height: "auto", minWidth: 0 }}
        >
          {choices.map((c, index) => {
            const checked = choice === c;
            const open = isOpen(c);
            const focusable = checked || (choice === "" && index === choices.findIndex((x) => isOpen(x)));
            return (
              <button
                key={c}
                ref={(el) => {
                  radioRefs.current[index] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={focusable ? 0 : -1}
                disabled={!open || submitting}
                className={checked ? "app-tab is-active" : "app-tab"}
                data-decision-choice={c}
                data-decision-choice-allowed={open ? "true" : "false"}
                onClick={() => pick(c)}
                onKeyDown={(e) => onRadioKey(e, index)}
                style={{ whiteSpace: "normal", height: "auto", minHeight: 36 }}
              >
                {DECISION_OPTION_LABELS[c] ?? c}
              </button>
            );
          })}
        </div>
        {distinctReasons.length > 0 ? (
          <p className="app-field-help" data-decision-choice-reasons style={{ margin: 0, overflowWrap: "anywhere" }}>
            {distinctReasons.join(" ")}
          </p>
        ) : null}
      </div>

      <fieldset
        data-decision-rationale-group
        style={{ display: "grid", gap: 4, minWidth: 0, border: 0, padding: 0, margin: 0 }}
      >
        <label className="app-field-label" htmlFor={`${id}-rationale`}>
          Rationale
        </label>
        <textarea
          id={`${id}-rationale`}
          ref={rationaleRef}
          className="app-input app-textarea"
          value={rationale}
          onChange={(e) => setRationale(e.target.value.slice(0, MAX))}
          disabled={submitting}
          rows={3}
          required
          aria-describedby={`${id}-rationale-help${error ? ` ${id}-error` : ""}`}
          aria-invalid={error ? true : undefined}
          placeholder="Explain the decision. Recorded in the audit log and visible to later reviewers."
          data-decision-form-rationale
          {...(mode === "adjudication" ? { "data-adjudication-rationale": "" } : {})}
          style={{ boxSizing: "border-box" }}
        />
        <p id={`${id}-rationale-help`} className="app-field-help" style={{ margin: 0 }}>
          {rationale.length}/{MAX} characters. Required.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
          <span id={`${id}-category`} className="app-field-help" style={{ margin: 0 }}>
            Category
          </span>
          <AppListbox
            id={`${id}-reason`}
            value={reason}
            options={[
              { value: "", label: "None" },
              ...REASON_CODES.map((r) => ({ value: r, label: REASON_CODE_LABELS[r] ?? r })),
            ]}
            onChange={(next) => setReason(next)}
            disabled={submitting}
            style={{ maxWidth: "100%" }}
            triggerProps={{ "data-decision-form-reason": "", "aria-labelledby": `${id}-category` }}
          />
        </div>
      </fieldset>

      {consequence ? (
        <p className="app-field-help" data-decision-consequence style={{ margin: 0, overflowWrap: "anywhere" }}>
          {consequence}
        </p>
      ) : null}

      {blockedReason && !error ? (
        <p role="note" className="app-field-help" data-decision-form-blocked style={{ margin: 0, overflowWrap: "anywhere" }}>
          {blockedReason}
        </p>
      ) : null}

      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="app-field-error"
          data-decision-form-error
          {...(mode === "adjudication" ? { "data-adjudication-error": "" } : {})}
          style={{ margin: 0, overflowWrap: "anywhere" }}
        >
          {error}
        </p>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
        <button
          type="submit"
          className="app-primary-action"
          disabled={!ready}
          aria-busy={submitting || undefined}
          data-decision-form-submit
          {...(mode === "adjudication" ? { "data-adjudication-submit": "" } : {})}
        >
          {submitting ? (
            <>
              <span className="app-spinner" aria-hidden="true" /> Recording…
            </>
          ) : (
            decisionSubmitLabel(choice)
          )}
        </button>
      </div>
    </form>
  );
}
