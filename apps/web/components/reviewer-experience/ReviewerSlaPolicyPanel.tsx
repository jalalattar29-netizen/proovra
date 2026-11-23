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
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { PageSection } from "../ui/PageShell";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
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

  if (!data) {
    return (
      <PageSection title="Review SLA policy">
        {error ? (
          <Card variant="status" tone="risk" role="alert" data-review-sla-policy-error>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span>{error}</span>
              <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            </div>
          </Card>
        ) : (
          <p className="app-field-help">Loading the review SLA policy…</p>
        )}
      </PageSection>
    );
  }

  const eff = data.policy.policy;
  const flags = data.flags;

  return (
    <div data-review-sla-policy data-review-sla-policy-mode={canEdit ? "edit" : "read"}>
      <PageSection
        title="Review SLA policy"
        description={
          canEdit
            ? "Deadlines for reviews in this workspace. Leave a field blank to keep the default. Saving asks you to confirm your identity."
            : "Deadlines for reviews in this workspace. Only workspace owners and admins can change them."
        }
        action={
          canEdit ? (
            <Button
              variant="primary"
              onClick={() => void save()}
              loading={busy}
              disabled={busy}
              data-review-sla-policy-save
            >
              {busy ? "Saving…" : "Save policy"}
            </Button>
          ) : undefined
        }
      >
        {error ? (
          <Card variant="status" tone="risk" role="alert">
            {error}
          </Card>
        ) : null}
        {notice ? (
          <Card variant="status" tone="verified" role="status">
            {notice}
          </Card>
        ) : null}
        <Card>
          <div style={gridStyle}>
            {HOUR_FIELDS.map((f) =>
              canEdit ? (
                <label key={f.key} style={labelStyle}>
                  <span>{f.label} (hours)</span>
                  <input
                    type="number"
                    min={1}
                    max={720}
                    className="app-form-input"
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
                  <span className="app-field-help">
                    {f.help} Now {eff[f.key]} h.
                  </span>
                </label>
              ) : (
                <div key={f.key} style={labelStyle} data-review-sla-policy-value={f.key}>
                  <span>{f.label}</span>
                  <strong style={{ fontSize: 15 }}>{eff[f.key]} h</strong>
                  <span className="app-field-help">{f.help}</span>
                </div>
              ),
            )}
          </div>
        </Card>
      </PageSection>

      <PageSection
        title="Step-up rules"
        description="When on, the action asks for a fresh identity check (MFA or a trusted device) before it is accepted."
      >
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {FLAG_FIELDS.map((f) => {
              const value = flagDraft[f.key] ?? flags[f.key];
              return canEdit ? (
                <label key={f.key} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    className="app-checkbox"
                    checked={value}
                    onChange={(e) => setFlagDraft((p) => ({ ...p, [f.key]: e.target.checked }))}
                  />
                  <span>{f.label}</span>
                </label>
              ) : (
                <div key={f.key} style={{ fontSize: 13 }} data-review-sla-policy-flag={f.key}>
                  {f.label}: <strong>{value ? "On" : "Off"}</strong>
                </div>
              );
            })}
          </div>
        </Card>
      </PageSection>

      <PageSection
        title="Reviewer inactivity"
        description="When set, a reminder is raised if an assigned reviewer has not touched a review for this long."
      >
        <Card>
          {canEdit ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min={1}
                max={720}
                className="app-form-input"
                style={{ width: 100 }}
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
              <span className="app-field-help">hours</span>
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 13 }}>
              {flags.reviewerInactivityHours
                ? `Reminder after ${flags.reviewerInactivityHours} h without activity.`
                : "Off."}
            </p>
          )}
        </Card>
      </PageSection>
      <StepUpModal control={stepUp} />
    </div>
  );
}

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
};

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--ink-secondary)",
};

export default ReviewerSlaPolicyPanel;
