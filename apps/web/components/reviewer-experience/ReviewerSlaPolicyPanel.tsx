"use client";

/**
 * TEAM-SPEC §2 item 9 / §3 — the reviewer SLA policy, as a shared panel.
 *
 * The only UI for `/v1/reviewer-ops/sla-policy` lived on the Enterprise-only
 * `/governance/policy` page, which 404'd for every Team workspace while the
 * API served the policy (read: REVIEW_TASKS_AND_QUEUES; write: the same plus
 * `governance.policy.manage` and a step-up) to any entitled workspace. This
 * panel is the reviewer half of that page, mounted in Review settings
 * (`/review/settings`); the Governance page is unchanged.
 *
 * Who sees what:
 *   - every member who can open Review settings reads the effective policy;
 *   - the edit form (and Save) is offered only when the viewer's role holds
 *     `governance.policy.manage` — the permission the API enforces. The API
 *     refuses everyone else regardless; this only avoids offering a control
 *     that would always be refused.
 *
 * Same contract as the Governance page: POST with `overrides` / `flags`,
 * step-up via `useStepUpAction`.
 *
 * TEAM-UI-SPEC §1 (round 3) — three app-panel cards inside ONE form; the
 * form footer carries the only primary (Save policy) beside a secondary Reset
 * that discards unsaved edits. Fields are app-field-label + app-input.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import "./review-surfaces.css";
import {
  StepUpModal,
  isStepUpCancelled,
  useStepUpAction,
} from "../identity-security/StepUpModal";

type PolicyHours = {
  assignmentHours: number;
  firstReviewHours: number;
  completionHours: number;
  escalationHours: number;
  dueSoonHours: number;
};

type PolicyEnvelope = {
  policy: PolicyHours;
  sources: {
    template: Partial<PolicyHours>;
    workspace: Partial<PolicyHours>;
    env: Partial<PolicyHours>;
  };
};

type Flags = {
  requireStepUpForApprove: boolean;
  requireStepUpForReject: boolean;
  requireStepUpForEscalationResolve: boolean;
  requireStepUpForBulk: boolean;
  reviewerInactivityHours: number | null;
};

type ApiResponse = { policy: PolicyEnvelope; flags: Flags };

const HOUR_FIELDS: ReadonlyArray<{ key: keyof PolicyHours; label: string; help: string }> = [
  { key: "assignmentHours", label: "Assignment", help: "Time for a new review to get an owner." },
  { key: "firstReviewHours", label: "First review", help: "Time for the first decision once assigned." },
  { key: "completionHours", label: "Completion", help: "Time for the review to finish." },
  { key: "escalationHours", label: "Escalation", help: "Overdue time before an escalation is raised." },
  { key: "dueSoonHours", label: "Due-soon window", help: "How early a review is marked due soon." },
];

const FLAG_FIELDS: ReadonlyArray<{ key: Exclude<keyof Flags, "reviewerInactivityHours">; label: string }> = [
  { key: "requireStepUpForApprove", label: "Require step-up to approve" },
  { key: "requireStepUpForReject", label: "Require step-up to reject" },
  { key: "requireStepUpForEscalationResolve", label: "Require step-up to resolve or suppress an escalation" },
  { key: "requireStepUpForBulk", label: "Require step-up for bulk actions" },
];

export function ReviewerSlaPolicyPanel({
  teamId,
  canEdit,
}: {
  teamId: string;
  /** The viewer's role holds `governance.policy.manage` in this workspace. */
  canEdit: boolean;
}) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [overrides, setOverrides] = useState<Partial<PolicyHours>>({});
  const [flagDraft, setFlagDraft] = useState<Partial<Flags>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const stepUp = useStepUpAction({ teamId });

  useEffect(() => {
    let cancelled = false;
    setError(null);
    apiFetch(`/v1/reviewer-ops/sla-policy?teamId=${encodeURIComponent(teamId)}`, { method: "GET" })
      .then((r: ApiResponse) => {
        if (cancelled) return;
        setData(r);
        setOverrides(r.policy.sources.workspace ?? {});
        setFlagDraft({});
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(toSafeUserError(err, { message: "Could not load the review SLA policy." }).message);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, attempt]);

  const save = useCallback(async () => {
    if (!canEdit) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) clean[k] = Math.floor(v);
      }
      const res = (await stepUp.runStepUpAction((stepUpHeaders) =>
        apiFetch("/v1/reviewer-ops/sla-policy", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(stepUpHeaders ?? {}) },
          body: JSON.stringify({
            teamId,
            overrides: Object.keys(clean).length > 0 ? clean : undefined,
            flags: Object.keys(flagDraft).length > 0 ? flagDraft : undefined,
          }),
        }),
      )) as ApiResponse;
      setData(res);
      setFlagDraft({});
      setNotice("Review SLA policy saved.");
    } catch (err) {
      if (isStepUpCancelled(err)) return;
      setError(toSafeUserError(err, { message: "Could not save the review SLA policy." }).message);
    } finally {
      setBusy(false);
    }
  }, [canEdit, flagDraft, overrides, stepUp, teamId]);

  const reset = useCallback(() => {
    if (!data) return;
    setOverrides(data.policy.sources.workspace ?? {});
    setFlagDraft({});
    setError(null);
    setNotice(null);
  }, [data]);

  if (!data) {
    return (
      <section className="app-panel" aria-labelledby="review-sla-policy-title">
        <div className="app-panel__head">
          <h2 className="app-panel__title" id="review-sla-policy-title">Review SLA policy</h2>
        </div>
        <div className="app-panel__body">
          {error ? (
            <div className="app-alert app-alert--danger" role="alert" data-review-sla-policy-error>
              {error}{" "}
              <button
                type="button"
                className="app-secondary-action"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Retry
              </button>
            </div>
          ) : (
            <p className="app-field-help">Loading the review SLA policy…</p>
          )}
        </div>
      </section>
    );
  }

  const eff = data.policy.policy;
  const flags = data.flags;
  const dirty = Object.keys(flagDraft).length > 0 ||
    JSON.stringify(overrides) !== JSON.stringify(data.policy.sources.workspace ?? {});

  return (
    <>
    <form
      className="review-panel-stack"
      data-review-sla-policy
      data-review-sla-policy-mode={canEdit ? "edit" : "read"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {error ? (
        <div className="app-alert app-alert--danger" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="app-alert app-alert--ok" role="status">
          {notice}
        </div>
      ) : null}

      <section className="app-panel" aria-labelledby="review-sla-policy-title">
        <div className="app-panel__head">
          <h2 className="app-panel__title" id="review-sla-policy-title">Review SLA policy</h2>
        </div>
        <div className="app-panel__body review-panel-stack">
          <p className="app-field-help">
            {canEdit
              ? "Deadlines for reviews in this workspace. Leave a field blank to keep the default. Saving asks you to confirm your identity."
              : "Deadlines for reviews in this workspace. Only workspace owners and admins can change them."}
          </p>
          <div className="review-field-grid">
            {HOUR_FIELDS.map((f) =>
              canEdit ? (
                <div key={f.key}>
                  <label className="app-field-label" htmlFor={`review-sla-${f.key}`}>
                    {f.label} (hours)
                  </label>
                  <input
                    id={`review-sla-${f.key}`}
                    type="number"
                    min={1}
                    max={720}
                    className="app-input"
                    value={typeof overrides[f.key] === "number" ? overrides[f.key] : ""}
                    placeholder={String(eff[f.key])}
                    data-review-sla-policy-field={f.key}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "") {
                        setOverrides((p) => ({ ...p, [f.key]: undefined }));
                        return;
                      }
                      const n = Number(raw);
                      if (Number.isFinite(n) && n > 0) setOverrides((p) => ({ ...p, [f.key]: n }));
                    }}
                  />
                  <p className="app-field-help">
                    {f.help} Now {eff[f.key]} h.
                  </p>
                </div>
              ) : (
                <div key={f.key} data-review-sla-policy-value={f.key}>
                  <span className="app-field-label">{f.label}</span>
                  <span className="app-fact-value">{eff[f.key]} h</span>
                  <p className="app-field-help">{f.help}</p>
                </div>
              ),
            )}
          </div>
        </div>
      </section>

      <section className="app-panel" aria-labelledby="review-sla-stepup-title">
        <div className="app-panel__head">
          <h2 className="app-panel__title" id="review-sla-stepup-title">Step-up rules</h2>
        </div>
        <div className="app-panel__body">
          <p className="app-field-help">
            When on, the action asks for a fresh identity check (MFA or a trusted device) before it is accepted.
          </p>
          {FLAG_FIELDS.map((f) => {
            const value = flagDraft[f.key] ?? flags[f.key];
            return canEdit ? (
              <label key={f.key} className="review-check-row">
                <input
                  type="checkbox"
                  className="app-checkbox"
                  checked={value}
                  data-review-sla-policy-flag-input={f.key}
                  onChange={(e) => setFlagDraft((p) => ({ ...p, [f.key]: e.target.checked }))}
                />
                <span>{f.label}</span>
              </label>
            ) : (
              <div key={f.key} className="review-check-row" data-review-sla-policy-flag={f.key}>
                <span>{f.label}:</span>
                <span className={value ? "app-chip app-chip--ok" : "app-chip"}>{value ? "On" : "Off"}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="app-panel" aria-labelledby="review-sla-inactivity-title">
        <div className="app-panel__head">
          <h2 className="app-panel__title" id="review-sla-inactivity-title">Reviewer inactivity</h2>
        </div>
        <div className="app-panel__body">
          {canEdit ? (
            <div className="review-field-grid">
              <div>
                <label className="app-field-label" htmlFor="review-sla-inactivity">
                  Reminder after (hours)
                </label>
                <input
                  id="review-sla-inactivity"
                  type="number"
                  min={1}
                  max={720}
                  className="app-input"
                  aria-label="Reviewer inactivity threshold in hours"
                  value={flagDraft.reviewerInactivityHours ?? flags.reviewerInactivityHours ?? ""}
                  placeholder="Off"
                  onChange={(e) => {
                    const n = e.target.value === "" ? null : Number(e.target.value);
                    setFlagDraft((p) => ({
                      ...p,
                      reviewerInactivityHours:
                        n === null || (Number.isFinite(n) && n > 0) ? n : undefined,
                    }));
                  }}
                />
                <p className="app-field-help">
                  When set, a reminder is raised if an assigned reviewer has not touched a review for this long.
                </p>
              </div>
            </div>
          ) : (
            <p className="app-field-help">
              {flags.reviewerInactivityHours
                ? `Reminder after ${flags.reviewerInactivityHours} h without activity.`
                : "Off."}
            </p>
          )}
        </div>
      </section>

      {canEdit ? (
        <div className="review-panel__actions" data-review-sla-policy-actions>
          <button
            type="button"
            className="app-secondary-action"
            onClick={reset}
            disabled={busy || !dirty}
            data-review-sla-policy-reset
          >
            Reset
          </button>
          <button
            type="submit"
            className="app-primary-action"
            disabled={busy}
            aria-busy={busy || undefined}
            data-review-sla-policy-save
          >
            {busy ? "Saving…" : "Save policy"}
          </button>
        </div>
      ) : null}
    </form>
    {/* Outside the form: a submit inside the step-up dialog must not bubble
        (through the portal) into the policy form. */}
    <StepUpModal control={stepUp} />
    </>
  );
}

export default ReviewerSlaPolicyPanel;
