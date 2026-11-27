"use client";
import { AppStatusText } from "../app-primitives/AppStatusText";

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
import {
  REVIEW_ACTIONS_WITHOUT_STEP_UP,
  REVIEW_STEP_UP_ALWAYS_ON,
  reviewStepUpFlagGoverns,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import "./review-surfaces.css";
import {
  StepUpModal,
  isStepUpCancelled,
  stepUpCancelMessage,
  stepUpEnrollmentHref,
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
  // Review remediation 2026-11-27 — explicit Review policies (BEHAVIOUR-SPEC §2, §3, §6).
  reviewRequiresIndependentApproval?: boolean;
  reviewRequiresTeamPlacement?: boolean;
  reviewRequiresCompleteCoding?: boolean;
  /** Read-only: when complete-coding enforcement was turned on (reviews started after it are enforced). */
  reviewRequiresCompleteCodingSince?: string | null;
};

type StepUpFlagKey = "requireStepUpForApprove" | "requireStepUpForReject" | "requireStepUpForEscalationResolve" | "requireStepUpForBulk";

type ReviewPolicyKey = "reviewRequiresIndependentApproval" | "reviewRequiresTeamPlacement" | "reviewRequiresCompleteCoding";

/** The three Review policies, each with what it does in plain words. */
const REVIEW_POLICY_FIELDS: ReadonlyArray<{ key: ReviewPolicyKey; label: string; help: string }> = [
  {
    key: "reviewRequiresIndependentApproval",
    label: "Every review needs an independent second decision",
    help: "When on, a reviewer's approval or rejection is recorded as the first decision and stays pending until a different reviewer confirms it. When off, one reviewer's decision finalizes the review unless an escalation, a legal hold or a redaction requires a second decision.",
  },
  {
    key: "reviewRequiresTeamPlacement",
    label: "Reviewers must be placed in a Collaboration Team",
    help: "When on, only members placed in a Collaboration Team can be assigned, claim or give a second decision on reviews; members who leave their last team release the reviews they hold. When off, every active member with review permission and access to the evidence can review.",
  },
  {
    key: "reviewRequiresCompleteCoding",
    label: "Approving or rejecting requires complete coding (applies to reviews started after you turn it on)",
    help: "When on, approve and reject are refused until the required coding fields are filled. Requesting information is never blocked. Reviews already started before you turn it on are not affected.",
  },
];

/**
 * `version` / `teamId` (T-041, additive): the policy version the panel read,
 * sent back as `expectedVersion` so a save over a newer policy is refused, and
 * the workspace the answer belongs to.
 */
type ApiResponse = { policy: PolicyEnvelope; flags: Flags; version?: number; teamId?: string };

/** What the panel holds, always bound to the workspace it was loaded for (T-041). */
type Loaded = {
  teamId: string;
  data: ApiResponse;
  overrides: Partial<PolicyHours>;
  flagDraft: Partial<Flags>;
};

const HOUR_FIELDS: ReadonlyArray<{ key: keyof PolicyHours; label: string; help: string }> = [
  { key: "assignmentHours", label: "Assignment", help: "Time for a new review to get an owner." },
  { key: "firstReviewHours", label: "First review", help: "Time for the first decision once assigned." },
  { key: "completionHours", label: "Completion", help: "Time for the review to finish." },
  { key: "escalationHours", label: "Escalation", help: "Overdue time before an escalation is raised." },
  { key: "dueSoonHours", label: "Due-soon window", help: "How early a review is marked due soon." },
];

/**
 * T-031 / T-035 — each checkbox names exactly what it governs, generated from
 * the same shared table the server gate reads (`reviewStepUpFlagGoverns`), so
 * the copy cannot drift from enforcement.
 */
const FLAG_FIELDS: ReadonlyArray<{ key: StepUpFlagKey; label: string }> = [
  { key: "requireStepUpForApprove", label: "Ask for a second factor to approve" },
  { key: "requireStepUpForReject", label: "Ask for a second factor to reject, close, reopen or archive" },
  { key: "requireStepUpForEscalationResolve", label: "Ask for a second factor to resolve or suppress an escalation" },
  { key: "requireStepUpForBulk", label: "Ask for a second factor for bulk actions" },
];

const SAVE_NEEDS_FACTOR_REASON =
  "Saving review settings needs a second factor, and this account has none yet. Set one up under Settings → Security.";

export function ReviewerSlaPolicyPanel({
  teamId,
  canEdit,
}: {
  teamId: string;
  /** The viewer's role holds `governance.policy.manage` in this workspace. */
  canEdit: boolean;
}) {
  /*
   * T-041 (stage B) — EVERYTHING THE PANEL SHOWS AND SAVES IS BOUND TO THE
   * WORKSPACE IT WAS LOADED FOR. After a workspace switch the previous
   * workspace's values are never shown (the binding no longer matches, so the
   * panel reads as loading), a late answer for the old workspace is dropped,
   * and Save is impossible until the new workspace's policy has arrived. A
   * failed load shows the error only, never the previous values.
   */
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ teamId: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stale, setStale] = useState(false);
  /** T-033 — whether this account holds a second factor; null while unknown. */
  const [hasFactor, setHasFactor] = useState<boolean | null>(null);
  const stepUp = useStepUpAction({ teamId });

  const current = loaded && loaded.teamId === teamId ? loaded : null;
  const data = current?.data ?? null;
  const overrides = current?.overrides ?? {};
  const flagDraft = current?.flagDraft ?? {};
  const errorText = error && error.teamId === teamId ? error.text : null;

  const setOverrides = useCallback(
    (fn: (p: Partial<PolicyHours>) => Partial<PolicyHours>) =>
      setLoaded((l) => (l && l.teamId === teamId ? { ...l, overrides: fn(l.overrides) } : l)),
    [teamId],
  );
  const setFlagDraft = useCallback(
    (fn: (p: Partial<Flags>) => Partial<Flags>) =>
      setLoaded((l) => (l && l.teamId === teamId ? { ...l, flagDraft: fn(l.flagDraft) } : l)),
    [teamId],
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setNotice(null);
    setStale(false);
    apiFetch(`/v1/reviewer-ops/sla-policy?teamId=${encodeURIComponent(teamId)}`, { method: "GET" })
      .then((r: ApiResponse) => {
        if (cancelled) return;
        setLoaded({ teamId, data: r, overrides: r.policy.sources.workspace ?? {}, flagDraft: {} });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError({ teamId, text: toSafeUserError(err, { message: "Could not load the review SLA policy." }).message });
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, attempt]);

  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    apiFetch("/v1/identity/mfa/factors")
      .then((r: { hasMfa?: boolean } | null) => {
        if (!cancelled) setHasFactor(r ? Boolean(r.hasMfa) : null);
      })
      .catch(() => {
        // Unknown: the server still decides; nothing is disabled on a guess.
        if (!cancelled) setHasFactor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canEdit]);

  const needsFactor = canEdit && hasFactor === false;

  const save = useCallback(async () => {
    if (!canEdit || !current || needsFactor) return;
    const boundTeamId = current.teamId;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(current.overrides)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) clean[k] = Math.floor(v);
      }
      const res = (await stepUp.runStepUpAction((stepUpHeaders) =>
        apiFetch("/v1/reviewer-ops/sla-policy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // The workspace this panel was loaded for, named explicitly: the
            // server refuses a mismatch with the active workspace (T-042).
            "x-proovra-workspace-id": boundTeamId,
            ...(stepUpHeaders ?? {}),
          },
          body: JSON.stringify({
            teamId: boundTeamId,
            ...(typeof current.data.version === "number" ? { expectedVersion: current.data.version } : {}),
            overrides: Object.keys(clean).length > 0 ? clean : undefined,
            flags: Object.keys(current.flagDraft).length > 0 ? current.flagDraft : undefined,
          }),
        }),
      )) as ApiResponse;
      setLoaded((l) =>
        l && l.teamId === boundTeamId
          ? { teamId: boundTeamId, data: res, overrides: res.policy.sources.workspace ?? {}, flagDraft: {} }
          : l,
      );
      setNotice("Review SLA policy saved.");
    } catch (err) {
      if (isStepUpCancelled(err)) {
        const text = stepUpCancelMessage(err, "");
        if (text) setError({ teamId: boundTeamId, text });
        return;
      }
      const code = (err as { code?: string }).code;
      if (code === "POLICY_VERSION_CONFLICT" || code === "WORKSPACE_MISMATCH") {
        setStale(true);
        setError({
          teamId: boundTeamId,
          text:
            code === "WORKSPACE_MISMATCH"
              ? "This page was showing a different workspace than the one you're working in, so nothing was saved. Reload to see this workspace's policy."
              : "Someone changed this policy since you opened it, so nothing was saved. Reload to see the current values, then make your change again.",
        });
        return;
      }
      setError({ teamId: boundTeamId, text: toSafeUserError(err, { message: "Could not save the review SLA policy." }).message });
    } finally {
      setBusy(false);
    }
  }, [canEdit, current, needsFactor, stepUp]);

  const reset = useCallback(() => {
    if (!data) return;
    setOverrides(() => data.policy.sources.workspace ?? {});
    setFlagDraft(() => ({}));
    setError(null);
    setNotice(null);
  }, [data, setFlagDraft, setOverrides]);

  if (!data) {
    return (
      <section className="app-panel" aria-labelledby="review-sla-policy-title">
        <div className="app-panel__head">
          <h2 className="app-panel__title" id="review-sla-policy-title">Review SLA policy</h2>
        </div>
        <div className="app-panel__body">
          {errorText ? (
            <div className="app-alert app-alert--danger" role="alert" data-review-sla-policy-error>
              {errorText}{" "}
              <button
                type="button"
                className="app-secondary-action"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Retry
              </button>
            </div>
          ) : (
            <p className="app-field-help" data-review-sla-policy-loading>Loading the review SLA policy…</p>
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
      {errorText ? (
        <div className="app-alert app-alert--danger" role="alert" data-review-sla-policy-save-error>
          {errorText}
          {stale ? (
            <>
              {" "}
              <button type="button" className="app-secondary-action" onClick={() => setAttempt((n) => n + 1)}>
                Reload
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {needsFactor ? (
        <div className="app-alert app-alert--warning" role="status" data-review-sla-policy-needs-factor id="review-sla-needs-factor">
          {SAVE_NEEDS_FACTOR_REASON}{" "}
          <a href={stepUpEnrollmentHref("/review/settings")} data-review-sla-policy-enroll-link>
            Set up two-factor
          </a>
          , then come back here to save.
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
              ? "Deadlines for reviews in this workspace. Leave a field blank to keep the default. Saving always asks for a second factor."
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
            When a rule is on, the actions it lists ask for a second factor — a passkey or security key, an
            authenticator app, your organization&apos;s sign-in or (where allowed) a verified phone. A password
            is not accepted instead.
          </p>
          {FLAG_FIELDS.map((f) => {
            const value = flagDraft[f.key] ?? flags[f.key];
            const governs = reviewStepUpFlagGoverns(f.key);
            const governsList = (
              <ul className="app-field-help" data-review-sla-policy-governs={f.key} style={{ margin: "2px 0 8px 1.5rem" }}>
                {governs.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            );
            return canEdit ? (
              <div key={f.key}>
                <label className="review-check-row">
                  <input
                    type="checkbox"
                    className="app-checkbox"
                    checked={value}
                    // T-034 — a rule that would ask for a second factor cannot
                    // be turned on by an account that has none (Save needs one
                    // too); the reason is stated above and here.
                    disabled={needsFactor && !value}
                    title={needsFactor && !value ? SAVE_NEEDS_FACTOR_REASON : undefined}
                    aria-describedby={needsFactor && !value ? "review-sla-needs-factor" : undefined}
                    data-review-sla-policy-flag-input={f.key}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setFlagDraft((p) => ({ ...p, [f.key]: checked }));
                    }}
                  />
                  <span>{f.label}</span>
                </label>
                {governsList}
              </div>
            ) : (
              <div key={f.key}>
                <div className="review-check-row" data-review-sla-policy-flag={f.key}>
                  <span>{f.label}:</span>
                  <AppStatusText tone={value ? "green" : "slate"}>{value ? "On" : "Off"}</AppStatusText>
                </div>
                {governsList}
              </div>
            );
          })}
          <div data-review-sla-policy-always-on>
            <p className="app-field-help" style={{ marginBottom: 2 }}>
              These always apply, whatever is selected here:
            </p>
            <ul className="app-field-help" style={{ margin: "0 0 8px 1.5rem" }}>
              {REVIEW_STEP_UP_ALWAYS_ON.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="app-field-help" style={{ marginBottom: 2 }}>
              These never ask for a second factor:
            </p>
            <ul className="app-field-help" style={{ margin: "0 0 0 1.5rem" }} data-review-sla-policy-never>
              {REVIEW_ACTIONS_WITHOUT_STEP_UP.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="app-panel" aria-labelledby="review-policy-title" data-review-policy-section>
        <div className="app-panel__head">
          <h2 className="app-panel__title" id="review-policy-title">Review policy</h2>
        </div>
        <div className="app-panel__body">
          <p className="app-field-help">
            Rules every review in this workspace follows. They change who may decide, never past decisions.
          </p>
          {REVIEW_POLICY_FIELDS.map((f) => {
            const value = Boolean(flagDraft[f.key] ?? flags[f.key] ?? false);
            const helpId = `review-policy-${f.key}-help`;
            const since =
              f.key === "reviewRequiresCompleteCoding" && flags.reviewRequiresCompleteCoding && flags.reviewRequiresCompleteCodingSince
                ? ` On since ${formatUserDateTime(flags.reviewRequiresCompleteCodingSince)}.`
                : "";
            return canEdit ? (
              <div key={f.key}>
                <label className="review-check-row">
                  <input
                    type="checkbox"
                    className="app-checkbox"
                    checked={value}
                    aria-describedby={helpId}
                    data-review-policy-flag-input={f.key}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setFlagDraft((p) => ({ ...p, [f.key]: checked }));
                    }}
                  />
                  <span>{f.label}</span>
                </label>
                <p id={helpId} className="app-field-help" style={{ margin: "2px 0 8px 1.5rem" }}>
                  {f.help}
                  {since}
                </p>
              </div>
            ) : (
              <div key={f.key}>
                <div className="review-check-row" data-review-policy-flag={f.key}>
                  <span>{f.label}:</span>
                  <AppStatusText tone={value ? "green" : "slate"}>{value ? "On" : "Off"}</AppStatusText>
                </div>
                <p className="app-field-help" style={{ margin: "2px 0 8px 1.5rem" }}>
                  {f.help}
                  {since}
                </p>
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
                    setFlagDraft((p: Partial<Flags>) => ({
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
            disabled={busy || needsFactor}
            aria-busy={busy || undefined}
            // T-033 — the requirement is stated before the person acts.
            title={needsFactor ? SAVE_NEEDS_FACTOR_REASON : undefined}
            aria-describedby={needsFactor ? "review-sla-needs-factor" : undefined}
            data-disabled-reason={needsFactor ? SAVE_NEEDS_FACTOR_REASON : undefined}
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
