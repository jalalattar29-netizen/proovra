"use client";

/**
 * PHASE 12B — Organization MFA policy editor. Product surface for
 *
 *   GET   /v1/identity/mfa-admin/policy/:teamId
 *   PATCH /v1/identity/mfa-admin/policy/:teamId
 *
 * Both were registered with no consumer, so the enforced MFA posture of an
 * Organization could only be changed by hand against the API.
 *
 * THE CLIENT HOLDS NO POLICY AUTHORITY
 *   * It renders the server's values and submits a patch plus the
 *     `expectedPolicyVersion` IT READ. That version is part of the ATOMIC
 *     database mutation predicate on the server, so a concurrent editor
 *     cannot be silently overwritten.
 *   * A stale version comes back 409 MFA_POLICY_VERSION_CONFLICT with ZERO
 *     mutation. We reload the server projection and tell the operator to
 *     review and retry — never a generic failure toast.
 *   * The workspace is never typed by the operator: it comes from
 *     `lib/platform-context`, and a response landing after a workspace
 *     switch is discarded.
 *   * The patch is step-up gated on the server; `useStepUpAction` supplies
 *     the verified challenge header on the retry.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { useToast } from "../../../../../components/ui";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { PageSection } from "../../../../../components/ui/PageShell";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionDescription,
  SectionError,
  SectionLoading,
  classifyError,
  sectionInputStyle,
  sectionLabelStyle,
  sectionMuted,
  type SectionState,
} from "./section-state";

type MfaPolicyLevel =
  | "OFF"
  | "ADMINS_ONLY"
  | "REVIEWERS_AND_ABOVE"
  | "ALL_MEMBERS"
  | "HIGH_RISK_ONLY";

type FailMode = "SMART" | "FAIL_OPEN" | "FAIL_CLOSED";

type MfaPolicy = {
  teamId: string;
  level: MfaPolicyLevel;
  stepUpTtlSeconds: number;
  trustedDeviceTtlDays: number;
  mfaRequiredFlag: boolean;
  ssoReadyFlag: boolean;
  scimReadyFlag: boolean;
  mfaEnforcementFailMode: FailMode | null;
  policyVersion: number;
};

const LEVELS: ReadonlyArray<{ value: MfaPolicyLevel; label: string; hint: string }> = [
  { value: "OFF", label: "Off", hint: "No workspace-wide MFA requirement." },
  {
    value: "ADMINS_ONLY",
    label: "Owners and admins",
    hint: "Only privileged roles must hold a second factor.",
  },
  {
    value: "REVIEWERS_AND_ABOVE",
    label: "Reviewers and above",
    hint: "Everyone who can act on evidence must hold a second factor.",
  },
  {
    value: "ALL_MEMBERS",
    label: "Everyone",
    hint: "Every member of the organization must hold a second factor.",
  },
  {
    value: "HIGH_RISK_ONLY",
    label: "High risk only",
    hint: "MFA is demanded when the server scores the session HIGH or CRITICAL.",
  },
];

const FAIL_MODES: ReadonlyArray<{ value: "INHERIT" | FailMode; label: string; hint: string }> = [
  {
    value: "INHERIT",
    label: "Use the platform default",
    hint: "No per-organization override.",
  },
  {
    value: "SMART",
    label: "Smart",
    hint: "Personal users fail open, organization users fail closed when the evaluator is unavailable.",
  },
  {
    value: "FAIL_CLOSED",
    label: "Fail closed",
    hint: "If the evaluator cannot decide, access is refused. Recommended for enterprise.",
  },
  {
    value: "FAIL_OPEN",
    label: "Fail open",
    hint: "If the evaluator cannot decide, access continues. Not recommended.",
  },
];

type Draft = {
  level?: MfaPolicyLevel;
  stepUpTtlSeconds?: number;
  trustedDeviceTtlDays?: number;
  failMode?: "INHERIT" | FailMode;
};

export function MfaPolicySection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { addToast } = useToast();
  const stepUp = useStepUpAction({ teamId });

  const [state, setState] = useState<SectionState<MfaPolicy>>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft>({});
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (reason: "initial" | "reload") => {
      if (!teamId) return;
      setState({ kind: "loading" });
      setDraft({});
      const captured = stamp();
      try {
        const res = (await apiFetch(
          `/v1/identity/mfa-admin/policy/${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as { policy?: MfaPolicy } | null;
        if (isStale(captured)) return;
        if (!res?.policy) {
          setState({
            kind: "error",
            message: "The server did not return an MFA policy for this workspace.",
          });
          return;
        }
        setState({ kind: "ready", data: res.policy });
        setConflict(false);
        if (reason === "reload") {
          addToast("Loaded the latest saved MFA policy.", "info");
        }
      } catch (err) {
        if (isStale(captured)) return;
        setState(
          classifyError<MfaPolicy>(err, "We couldn't load the MFA policy."),
        );
      }
    },
    [teamId, stamp, isStale, addToast],
  );

  useEffect(() => {
    setDraft({});
    setConflict(false);
    void load("initial");
  }, [load]);

  const policy = state.kind === "ready" ? state.data : null;

  const currentLevel = draft.level ?? policy?.level ?? "OFF";
  const currentStepUpTtl = draft.stepUpTtlSeconds ?? policy?.stepUpTtlSeconds ?? 900;
  const currentDeviceTtl =
    draft.trustedDeviceTtlDays ?? policy?.trustedDeviceTtlDays ?? 30;
  const currentFailMode: "INHERIT" | FailMode =
    draft.failMode ?? policy?.mfaEnforcementFailMode ?? "INHERIT";

  const dirty =
    policy !== null &&
    (currentLevel !== policy.level ||
      currentStepUpTtl !== policy.stepUpTtlSeconds ||
      currentDeviceTtl !== policy.trustedDeviceTtlDays ||
      currentFailMode !== (policy.mfaEnforcementFailMode ?? "INHERIT"));

  const save = useCallback(async () => {
    if (!teamId || !policy || !dirty) return;
    const captured = stamp();
    const expectedPolicyVersion = policy.policyVersion;
    setBusy(true);
    setConflict(false);
    try {
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch(`/v1/identity/mfa-admin/policy/${encodeURIComponent(teamId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            expectedPolicyVersion,
            level: currentLevel,
            stepUpTtlSeconds: currentStepUpTtl,
            trustedDeviceTtlDays: currentDeviceTtl,
            mfaEnforcementFailMode:
              currentFailMode === "INHERIT" ? null : currentFailMode,
          }),
        }),
      )) as { policy?: MfaPolicy } | null;
      if (isStale(captured)) return;
      // Always reload from the server projection rather than trusting the
      // echo, so the displayed version is provably the persisted one.
      if (res?.policy) {
        setState({ kind: "ready", data: res.policy });
        setDraft({});
        addToast("MFA policy saved.", "success");
      } else {
        await load("reload");
      }
    } catch (err) {
      if (isStale(captured)) return;
      const code = ((err as { code?: string }).code ?? "").toUpperCase();
      if (code === "STEP_UP_CANCEL") return;
      if (code === "MFA_POLICY_VERSION_CONFLICT") {
        setConflict(true);
        void load("reload");
        return;
      }
      notifyApiError(addToast, err, {
        message: "We couldn't save the MFA policy.",
      });
    } finally {
      setBusy(false);
    }
  }, [
    teamId,
    policy,
    dirty,
    stepUp,
    currentLevel,
    currentStepUpTtl,
    currentDeviceTtl,
    currentFailMode,
    stamp,
    isStale,
    addToast,
    load,
  ]);

  const description = (
    <SectionDescription text="The enforced multi-factor posture for this organization. Every value here is evaluated on the server for each sign-in and each sensitive action — this panel reads and writes those values, it never decides them." />
  );

  if (!teamId) {
    return (
      <PageSection title="MFA policy" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to read or change its MFA policy." />
      </PageSection>
    );
  }
  if (state.kind === "loading") {
    return (
      <PageSection title="MFA policy" description={description}>
        <SectionLoading label="Reading the organization MFA policy…" />
      </PageSection>
    );
  }
  if (state.kind === "denied") {
    return (
      <PageSection title="MFA policy" description={description}>
        <SectionDenied
          message={state.message}
          hint="MFA policy administration requires owner or admin access on an Enterprise organization. This is a refusal, not an unset policy."
        />
      </PageSection>
    );
  }
  if (state.kind === "error") {
    return (
      <PageSection title="MFA policy" description={description}>
        <SectionError message={state.message} onRetry={() => void load("reload")} />
      </PageSection>
    );
  }

  const saved = state.data;

  return (
    <PageSection
      title="MFA policy"
      description={description}
      data-mfa-policy-section
      action={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Badge tone="neutral">version {saved.policyVersion}</Badge>
          <Button
            variant="secondary"
            onClick={() => setDraft({})}
            disabled={busy || !dirty}
          >
            Discard changes
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            loading={busy}
            disabled={busy || !dirty}
            data-mfa-policy-save
          >
            {busy ? "Saving…" : "Save MFA policy"}
          </Button>
        </div>
      }
          >
      {conflict ? (
        <Card
          variant="status"
          tone="pending"
          padding="compact"
          style={{ marginBottom: 12 }}
          data-mfa-policy-conflict
        >
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
            Reloaded — review and retry
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 12.5 }}>
            Someone else changed this policy while you were editing it. Nothing
            you submitted was written. The values below are the current saved
            policy; re-apply your change and save again.
          </p>
        </Card>
      ) : null}

      <Card padding="comfortable">
        <div style={{ display: "grid", gap: 16 }}>
          <div>
            <span style={sectionLabelStyle}>Who must hold a second factor</span>
            <div style={{ display: "grid", gap: 6 }}>
              {LEVELS.map((l) => (
                <label
                  key={l.value}
                  className="adm-choice"
                >
                  <input
                    type="radio"
                    name="mfa-policy-level"
                    checked={currentLevel === l.value}
                    onChange={() => setDraft((d) => ({ ...d, level: l.value }))}
                  />
                  <span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{l.label}</span>
                    <span style={{ ...sectionMuted, display: "block" }}>{l.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            }}
          >
            <label>
              <span style={sectionLabelStyle}>
                Step-up validity (seconds, 60–3600)
              </span>
              <input
                type="number"
                min={60}
                max={3600}
                value={currentStepUpTtl}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    stepUpTtlSeconds: Number.parseInt(e.target.value, 10) || 60,
                  }))
                }
                style={sectionInputStyle}
              />
              <span style={{ ...sectionMuted, display: "block", marginTop: 4 }}>
                How long one verified step-up remains usable.
              </span>
            </label>
            <label>
              <span style={sectionLabelStyle}>Trusted device lifetime (days, 1–180)</span>
              <input
                type="number"
                min={1}
                max={180}
                value={currentDeviceTtl}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    trustedDeviceTtlDays: Number.parseInt(e.target.value, 10) || 1,
                  }))
                }
                style={sectionInputStyle}
              />
              <span style={{ ...sectionMuted, display: "block", marginTop: 4 }}>
                After this, a device must be trusted again.
              </span>
            </label>
          </div>

          <div>
            <span style={sectionLabelStyle}>
              If the enforcement evaluator is unavailable
            </span>
            <div style={{ display: "grid", gap: 6 }}>
              {FAIL_MODES.map((m) => (
                <label
                  key={m.value}
                  className="adm-choice"
                >
                  <input
                    type="radio"
                    name="mfa-fail-mode"
                    checked={currentFailMode === m.value}
                    onChange={() => setDraft((d) => ({ ...d, failMode: m.value }))}
                  />
                  <span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</span>
                    <span style={{ ...sectionMuted, display: "block" }}>{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge tone={saved.mfaRequiredFlag ? "verified" : "neutral"}>
              MFA declared: {saved.mfaRequiredFlag ? "yes" : "no"}
            </Badge>
            <Badge tone={saved.ssoReadyFlag ? "verified" : "neutral"}>
              SSO ready: {saved.ssoReadyFlag ? "yes" : "no"}
            </Badge>
            <Badge tone={saved.scimReadyFlag ? "verified" : "neutral"}>
              SCIM ready: {saved.scimReadyFlag ? "yes" : "no"}
            </Badge>
          </div>
        </div>
      </Card>

      <StepUpModal control={stepUp} />
    </PageSection>
  );
}

export default MfaPolicySection;
