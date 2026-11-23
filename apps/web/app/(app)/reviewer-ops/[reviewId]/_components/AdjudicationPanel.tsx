"use client";

/**
 * Explicit adjudication panel.
 *
 * Shown only while the two reviews disagree. Adjudication is its own action
 * (decisions route, adjudication kinds) taken by an owner or admin who made
 * neither decision; the ordinary Approve / Reject never adjudicate.
 *
 * The POST lives with the host page (`onSubmit`), which maps refusals and
 * reloads both the workspace and the decision lineage.
 */

import { useId, useState } from "react";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  DECISION_KIND_LABELS,
  DECISION_OPTION_LABELS,
  REASON_CODE_LABELS,
  STAGE_LABELS,
} from "./inspector-model";

export type AdjudicationKind = "UPHOLD_FIRST" | "UPHOLD_SECOND" | "NEEDS_MORE_INFO" | "UNRESOLVED";

const KINDS: AdjudicationKind[] = ["UPHOLD_FIRST", "UPHOLD_SECOND", "NEEDS_MORE_INFO", "UNRESOLVED"];

export type AdjudicationContextDecision = {
  id: string;
  stage: string;
  decision: string;
  reasonCode: string | null;
  rationale: string;
  decidedAt: string;
  reviewerName: string;
};

const MAX = 4000;

export function AdjudicationPanel({
  decisions,
  canAdjudicate,
  blockedReason,
  onSubmit,
}: {
  decisions: AdjudicationContextDecision[];
  canAdjudicate: boolean;
  blockedReason: string | null;
  /** Resolves to an error message, or null on success. */
  onSubmit: (body: { decision: AdjudicationKind; reasonCode: string; rationale: string }) => Promise<string | null>;
}) {
  const id = useId();
  const [kind, setKind] = useState<AdjudicationKind | "">("");
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contested = decisions.filter((d) => d.stage === "FIRST" || d.stage === "SECOND").slice(-2);
  const ready = canAdjudicate && kind !== "" && rationale.trim().length > 0 && !submitting;

  return (
    <section
      data-section="reviewer-adjudication"
      aria-labelledby={`${id}-title`}
      style={{
        border: "1px solid var(--warning-border)",
        background: "var(--warning-subtle-bg)",
        borderRadius: "var(--radius-md)",
        padding: 16,
        marginBottom: 12,
        minWidth: 0,
      }}
    >
      <h3 id={`${id}-title`} className="app-panel__title">
        Adjudication
      </h3>
      <p style={{ fontSize: 13, marginTop: 0 }}>
        The first and second reviews disagree. An owner or admin who made neither decision settles it here.
        Approve and Reject cannot settle a disagreement.
      </p>
      {contested.length > 0 ? (
        <ul
          data-adjudication-contested
          style={{ listStyle: "none", padding: 0, margin: "0 0 10px", display: "grid", gap: 6 }}
        >
          {contested.map((d) => (
            <li
              key={d.id}
              style={{
                padding: "8px 10px",
                border: "1px solid var(--border-standard)",
                background: "var(--surface-standard)",
                borderRadius: 6,
                fontSize: 13,
                minWidth: 0,
                overflowWrap: "anywhere",
              }}
            >
              <strong>{STAGE_LABELS[d.stage] ?? "Review"}</strong>
              {" · "}
              {DECISION_KIND_LABELS[d.decision] ?? "Decision"}
              {d.reasonCode ? ` · ${REASON_CODE_LABELS[d.reasonCode] ?? "Other"}` : ""}
              {" · "}
              {d.reviewerName}
              {" · "}
              <time dateTime={d.decidedAt}>{formatUserDateTime(d.decidedAt)}</time>
              <div style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{d.rationale}</div>
            </li>
          ))}
        </ul>
      ) : null}

      {canAdjudicate ? (
        <form
          data-adjudication-form
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || !kind) return;
            setSubmitting(true);
            setError(null);
            void onSubmit({ decision: kind, reasonCode: "REVIEWER_DISAGREEMENT", rationale: rationale.trim() })
              .then((err) => {
                if (err) setError(err);
                else {
                  setKind("");
                  setRationale("");
                }
              })
              .finally(() => setSubmitting(false));
          }}
          style={{ display: "grid", gap: 6, minWidth: 0 }}
        >
          <label className="app-field-label" htmlFor={`${id}-kind`}>
            Adjudication
          </label>
          <AppListbox
            id={`${id}-kind`}
            value={kind}
            options={[
              { value: "", label: "Choose an outcome…" },
              ...KINDS.map((k) => ({ value: k, label: DECISION_OPTION_LABELS[k] ?? k })),
            ]}
            onChange={(next) => setKind(next as AdjudicationKind | "")}
            disabled={submitting}
            style={{ maxWidth: "100%" }}
            triggerProps={{ "data-adjudication-kind": "" }}
          />
          <label className="app-field-label" htmlFor={`${id}-rationale`}>
            Rationale
          </label>
          <textarea
            id={`${id}-rationale`}
            className="app-textarea"
            value={rationale}
            onChange={(e) => setRationale(e.target.value.slice(0, MAX))}
            disabled={submitting}
            rows={3}
            required
            data-adjudication-rationale
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical" }}
          />
          <span className="app-field-help" style={{ margin: 0 }}>
            {rationale.length}/{MAX} characters. Required. Recorded in the audit log.
          </span>
          {error ? (
            <p role="alert" className="app-alert app-alert--danger" data-adjudication-error style={{ margin: 0 }}>
              {error}
            </p>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="submit"
              className="app-primary-action"
              disabled={!ready}
              aria-busy={submitting || undefined}
              data-adjudication-submit
            >
              {submitting ? "Recording…" : "Record adjudication"}
            </button>
          </div>
        </form>
      ) : (
        <p data-adjudication-blocked className="app-alert app-alert--warn" style={{ margin: 0 }}>
          {blockedReason ?? "Adjudication needs an owner or admin who made neither decision."}
        </p>
      )}
    </section>
  );
}
