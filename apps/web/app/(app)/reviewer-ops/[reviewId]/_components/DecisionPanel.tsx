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
 * inline "Not recorded: …" alert beside the controls (T-002, F-21).
 *
 * Review remediation 2026-11-27 (F-01): there is NO client business gate.
 * Submit is enabled exactly when the server's action for the chosen kind is
 * allowed and the input is valid; a missing second reviewer never blocks the
 * FIRST decision (the server records it as pending). The disabled-submit
 * reason only names input problems. When the chosen verdict differs from the
 * coded assessment, a non-blocking note says so (F-18).
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

/**
 * A refused submission (F-21): the one sentence to show, and — for
 * `coding_incomplete` — the labels of the required fields still empty.
 */
export type DecisionSubmitFailure = { message: string; missingLabels?: string[] };

/** What the host's POST resolves to: null on success, else the refusal. */
export type DecisionSubmitResult = DecisionSubmitFailure | string | null;

/** A request from the page to focus the form, optionally preselecting a choice. */
export type DecisionFocusRequest = { choice: string | null; nonce: number };

/**
 * F-18 — the coded REVIEWER_VERDICT assessment the decision is compared with.
 * `ownerLabel` null = the viewer's own assessment.
 */
export type CodedAssessment = { verdict: string; ownerLabel: string | null };

const ASSESSMENT_WORDS: Readonly<Record<string, string>> = {
  APPROVE: "approve",
  REJECT: "reject",
  ESCALATE: "escalate",
  NEEDS_INFO: "needs more information",
};

/** The non-blocking mismatch note, or null when the assessment agrees or is unset. */
export function assessmentMismatchNote(choice: string, assessment: CodedAssessment | null | undefined): string | null {
  if (!assessment || (choice !== "APPROVE" && choice !== "REJECT")) return null;
  const said = ASSESSMENT_WORDS[assessment.verdict];
  if (!said || assessment.verdict === choice) return null;
  const whose = assessment.ownerLabel ? `${assessment.ownerLabel}'s coded assessment` : "Your coded assessment";
  const records = choice === "APPROVE" ? "approved" : "not accepted";
  return `${whose} says “${said}”; your decision records “${records}”. The decision is what counts.`;
}

export function DecisionForm({
  mode,
  stage,
  actions,
  reviewState,
  secondRequired,
  onSubmit,
  focusRequest,
  firstRecorded = false,
  assessment = null,
}: {
  mode: "decision" | "adjudication";
  /** FIRST or SECOND in decision mode; ignored for adjudication. */
  stage: "FIRST" | "SECOND";
  /** The server's action map; decides which verdict choices are open. */
  actions: ActionMap;
  reviewState: string | null;
  secondRequired: boolean;
  /** The page's decisions POST. Resolves to the refusal, or null on success. */
  onSubmit: (body: DecisionSubmitBody) => Promise<DecisionSubmitResult>;
  focusRequest?: DecisionFocusRequest | null;
  /** A FIRST decision is already recorded in this round (request-info consequence). */
  firstRecorded?: boolean;
  /** F-18 — the coded assessment to compare the chosen verdict with. */
  assessment?: CodedAssessment | null;
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
  const [missingLabels, setMissingLabels] = useState<string[]>([]);
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
  // F-01 — submit follows the server's action for the chosen kind (a closed
  // kind cannot be chosen) and the input; nothing else.
  const ready = choice !== "" && isOpen(choice) && trimmed.length > 0 && !submitting;
  // T-090 (stage D) — a disabled submit always says why: input problems only.
  const submitDisabledReason = submitting
    ? "Recording the decision…"
    : choice === ""
      ? "Choose a decision first."
      : trimmed.length === 0
        ? "Write a rationale first."
        : null;
  const consequence = decisionConsequence({ state: reviewState, secondRequired, choice, firstRecorded });
  const mismatch = mode === "decision" ? assessmentMismatchNote(choice, assessment) : null;
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
    setMissingLabels([]);
    const failure = await onSubmit({
      decision: choice,
      reasonCode: reason || undefined,
      rationale: trimmed,
    });
    if (failure) {
      // F-21 — the draft (choice + rationale) stays for the retry.
      if (typeof failure === "string") setError(failure);
      else {
        setError(failure.message);
        setMissingLabels(failure.missingLabels ?? []);
      }
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

      {/* T-093 (stage D) — ONE line says what a decision here is; the verbs
          carry no "(internal)" suffix. */}
      <p className="app-field-help" data-decision-internal-note style={{ margin: 0 }}>
        {mode === "adjudication"
          ? "An adjudication is an internal review outcome, not a public statement about the evidence's authenticity."
          : "A decision here is an internal review outcome, not a public statement about the evidence's authenticity."}
      </p>

      {consequence ? (
        <p className="app-field-help" data-decision-consequence style={{ margin: 0, overflowWrap: "anywhere" }}>
          {consequence}
        </p>
      ) : null}

      {mismatch ? (
        <p role="note" className="app-field-help" data-decision-assessment-mismatch style={{ margin: 0, overflowWrap: "anywhere" }}>
          {mismatch}
        </p>
      ) : null}

      {error ? (
        <div id={`${id}-error`} role="alert" data-decision-form-alert style={{ margin: 0, minWidth: 0 }}>
          <p
            className="app-field-error"
            data-decision-form-error
            {...(mode === "adjudication" ? { "data-adjudication-error": "" } : {})}
            style={{ margin: 0, overflowWrap: "anywhere" }}
          >
            {error}
          </p>
          {missingLabels.length > 0 ? (
            <ul className="app-field-error" data-decision-form-missing-fields style={{ margin: "4px 0 0 1.25rem", padding: 0 }}>
              {missingLabels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        {!ready && submitDisabledReason ? (
          <span id={`${id}-submit-reason`} className="app-field-help" data-decision-submit-reason style={{ margin: 0 }}>
            {submitDisabledReason}
          </span>
        ) : null}
        <button
          type="submit"
          className="app-primary-action"
          disabled={!ready}
          aria-busy={submitting || undefined}
          aria-describedby={!ready && submitDisabledReason ? `${id}-submit-reason` : undefined}
          title={!ready && submitDisabledReason ? submitDisabledReason : undefined}
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
