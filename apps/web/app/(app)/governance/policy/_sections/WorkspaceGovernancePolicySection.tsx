"use client";

/**
 * PHASE 12B CLUSTER 9 — Workspace Governance Policy section.
 *
 * This is the product surface for `GET/PUT /v1/governance/policy`
 * (`WorkspaceGovernancePolicy`): retention default, evidence-deletion mode,
 * the legal-hold / publication approval gates, the review-before-export gates,
 * intake switches and the three download switches. Until now those controls
 * existed only in the API — the database could say "deletion DISABLED" and no
 * operator had a way to see or set it.
 *
 * IT IS NOT THE REVIEWER SLA POLICY. The surrounding page administers
 * `/v1/reviewer-ops/sla-policy`, which is a DIFFERENT engine with different
 * fields and a different write contract. The two are mounted side by side and
 * share no state, no fetch and no save button on purpose: merging them would
 * mean one Save writing two unrelated policy stores.
 *
 * THE CLIENT HOLDS NO POLICY AUTHORITY
 *   * It renders the server's values and submits a patch + `expectedVersion`.
 *   * It never computes an effective policy, never decides a permission, and
 *     never assumes a save succeeded — `server` is only ever replaced by a
 *     response body.
 *   * A stale `expectedVersion` comes back as 409 POLICY_VERSION_CONFLICT with
 *     zero mutation; the operator is told the policy changed and offered a
 *     reload rather than being allowed to overwrite.
 *   * Switching workspace discards both local edits and any in-flight
 *     response (see `contextRef`), so a late reply can never paint one
 *     workspace's policy under another workspace's heading.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useActiveWorkspaceId, useCan } from "../../../../../lib/platform-context";
import { useToast } from "../../../../../components/ui";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { PageSection } from "../../../../../components/ui/PageShell";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import {
  inputStyle,
  mutedStyle,
  selectStyle,
  TOKENS,
} from "../../../reviewer-ops/ui-tokens";

// ---------------------------------------------------------------------------
// Wire shapes — mirrors of the server projection. Read-only to this file.
// ---------------------------------------------------------------------------

type EvidenceDeletionMode = "ALLOWED" | "ADMIN_ONLY" | "DISABLED";

type WorkspaceGovernancePolicy = {
  defaultRetentionDays: number | null;
  evidenceDeletionMode: EvidenceDeletionMode;
  requireLegalHoldApprovalForDeletion: boolean;
  requireReviewBeforeReport: boolean;
  requireReviewBeforePackage: boolean;
  requireReviewBeforePublicVerify: boolean;
  allowExternalIntake: boolean;
  allowAnonymousIntake: boolean;
  allowPublicVerify: boolean;
  allowPackageDownload: boolean;
  allowReportDownload: boolean;
  allowOriginalDownload: boolean;
  requirePublicationApproval: boolean;
  requireLegalHoldReleaseApproval: boolean;
  /** "workspace_row" when a row exists, "default" when the workspace has none. */
  source: "workspace_row" | "default";
};

type PolicyEnvelope = {
  policy: WorkspaceGovernancePolicy;
  /** Concurrency token. 0 = no policy row exists yet. */
  version: number;
};

type BooleanFieldKey =
  | "requireLegalHoldApprovalForDeletion"
  | "requireReviewBeforeReport"
  | "requireReviewBeforePackage"
  | "requireReviewBeforePublicVerify"
  | "allowExternalIntake"
  | "allowAnonymousIntake"
  | "allowPublicVerify"
  | "allowPackageDownload"
  | "allowReportDownload"
  | "allowOriginalDownload"
  | "requirePublicationApproval"
  | "requireLegalHoldReleaseApproval";

type Draft = Partial<
  Pick<WorkspaceGovernancePolicy, "defaultRetentionDays" | "evidenceDeletionMode"> &
    Record<BooleanFieldKey, boolean>
>;

type LoadState =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; envelope: PolicyEnvelope };

const DELETION_MODES: ReadonlyArray<{
  value: EvidenceDeletionMode;
  label: string;
  hint: string;
}> = [
  {
    value: "ALLOWED",
    label: "Allowed",
    hint: "Anyone with delete permission can delete a record.",
  },
  {
    value: "ADMIN_ONLY",
    label: "Owners and admins only",
    hint: "Delete permission is not enough — the actor must also be an owner or admin.",
  },
  {
    value: "DISABLED",
    label: "Disabled",
    hint: "No one can delete a record through the product, regardless of role.",
  },
];

type BooleanGroup = {
  title: string;
  description: string;
  fields: ReadonlyArray<{ key: BooleanFieldKey; label: string; hint: string }>;
};

const BOOLEAN_GROUPS: ReadonlyArray<BooleanGroup> = [
  {
    title: "Approval gates",
    description:
      "When on, the action cannot complete until the approval it names has been recorded.",
    fields: [
      {
        key: "requireLegalHoldApprovalForDeletion",
        label: "Require legal-hold approval before deletion",
        hint: "A record covered by a legal hold needs an explicit approval before deletion is even attempted.",
      },
      {
        key: "requireLegalHoldReleaseApproval",
        label: "Require approval to release a legal hold",
        hint: "Releasing a hold needs a recorded approval, not just the permission to release it.",
      },
      {
        key: "requirePublicationApproval",
        label: "Require approval before publishing to public verify",
        hint: "Publishing a record for outside verification needs a recorded approval first.",
      },
    ],
  },
  {
    title: "Review gates",
    description:
      "When on, a record must have completed internal review before it can leave the workspace in that form.",
    fields: [
      {
        key: "requireReviewBeforeReport",
        label: "Require review before generating a report",
        hint: "",
      },
      {
        key: "requireReviewBeforePackage",
        label: "Require review before generating a verification package",
        hint: "",
      },
      {
        key: "requireReviewBeforePublicVerify",
        label: "Require review before publishing to public verify",
        hint: "",
      },
    ],
  },
  {
    title: "Intake",
    description:
      "Controls whether this workspace can collect records from people outside it.",
    fields: [
      {
        key: "allowExternalIntake",
        label: "Allow external intake links",
        hint: "Turning this off blocks every intake link, including named-contributor links.",
      },
      {
        key: "allowAnonymousIntake",
        label: "Allow anonymous and pseudonymous intake",
        hint: "Applies only while external intake is allowed.",
      },
    ],
  },
  {
    title: "What can leave the workspace",
    description:
      "Each switch is enforced on the server for every download and publication attempt.",
    fields: [
      {
        key: "allowReportDownload",
        label: "Allow report download",
        hint: "",
      },
      {
        key: "allowPackageDownload",
        label: "Allow verification package download",
        hint: "",
      },
      {
        key: "allowOriginalDownload",
        label: "Allow original file download",
        hint: "",
      },
      {
        key: "allowPublicVerify",
        label: "Allow public verification pages",
        hint: "Turning this off does not unpublish existing pages — it blocks new publication.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function WorkspaceGovernancePolicySection() {
  // Server-projected workspace context. Never client-inferred.
  const workspaceId = useActiveWorkspaceId();
  // Server-projected capability. Affordance ONLY — the API is the authority
  // and re-decides on every request.
  const canManage = useCan("GOVERNANCE_ACT");
  const { addToast } = useToast();
  const stepUp = useStepUpAction({ teamId: workspaceId });

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft>({});
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * STALE-CONTEXT REJECTION. Bumped on every workspace change and every
   * deliberate reload; an async continuation whose token no longer matches
   * writes nothing. Without this, a slow response for workspace A can land
   * after the operator has switched to workspace B.
   */
  const contextRef = useRef(0);

  const load = useCallback(
    async (reason: "initial" | "reload") => {
      if (!workspaceId) return;
      const token = ++contextRef.current;
      setState({ kind: "loading" });
      setDraft({});
      setConflict(false);
      try {
        // apiFetch returns the PARSED body and throws on non-2xx.
        const res = (await apiFetch("/v1/governance/policy", {
          method: "GET",
        })) as PolicyEnvelope | null;
        if (token !== contextRef.current) return;
        if (!res || !res.policy) {
          setState({
            kind: "error",
            message: toSafeUserError(
              { code: "PARSE_ERROR" },
              { message: "Could not read the workspace governance policy." },
            ).message,
          });
          return;
        }
        setState({
          kind: "ready",
          envelope: { policy: res.policy, version: res.version ?? 0 },
        });
        if (reason === "reload") {
          addToast("Loaded the latest saved policy.", "info");
        }
      } catch (err) {
        if (token !== contextRef.current) return;
        const safe = toSafeUserError(err, {
          message: "Could not load the workspace governance policy.",
        });
        const code = (err as { code?: string }).code ?? "";
        const status = (err as { statusCode?: number }).statusCode ?? 0;
        const denied =
          status === 401 ||
          status === 403 ||
          status === 404 ||
          code === "FORBIDDEN" ||
          code === "UNAUTHORIZED";
        setState(
          denied
            ? { kind: "denied", message: safe.message }
            : { kind: "error", message: safe.message },
        );
      }
    },
    [workspaceId, addToast],
  );

  // Workspace switch (or first mount) — discard everything local and re-read.
  useEffect(() => {
    contextRef.current += 1;
    setDraft({});
    setConflict(false);
    if (!workspaceId) {
      setState({ kind: "loading" });
      return;
    }
    void load("initial");
  }, [workspaceId, load]);

  const serverPolicy = state.kind === "ready" ? state.envelope.policy : null;

  /** Only the fields whose draft value genuinely differs from the server. */
  const patch = useMemo<Draft>(() => {
    if (!serverPolicy) return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (value === undefined) continue;
      if (value !== serverPolicy[key as keyof WorkspaceGovernancePolicy]) {
        out[key] = value;
      }
    }
    return out as Draft;
  }, [draft, serverPolicy]);

  const changedFields = Object.keys(patch);
  const dirty = changedFields.length > 0;

  const reset = useCallback(() => {
    setDraft({});
    setConflict(false);
  }, []);

  const save = useCallback(async () => {
    if (state.kind !== "ready" || !dirty) return;
    const token = contextRef.current;
    const expectedVersion = state.envelope.version;
    setBusy(true);
    setConflict(false);
    try {
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/governance/policy", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          // No workspace subject in the body — the server derives it.
          body: JSON.stringify({ expectedVersion, ...patch }),
        }),
      )) as PolicyEnvelope | null;
      if (token !== contextRef.current) return;
      if (!res || !res.policy) {
        // Never assume the save landed. Re-read instead of guessing.
        await load("reload");
        return;
      }
      setState({
        kind: "ready",
        envelope: { policy: res.policy, version: res.version ?? 0 },
      });
      setDraft({});
      addToast("Governance policy saved.", "success");
    } catch (err) {
      if (token !== contextRef.current) return;
      const code = (err as { code?: string }).code ?? "";
      if (code === "STEP_UP_CANCEL") {
        // The operator declined the challenge. Nothing was written and their
        // edits are still on screen — that is not an error to report.
        return;
      }
      if (code === "POLICY_VERSION_CONFLICT") {
        setConflict(true);
        return;
      }
      notifyApiError(addToast, err, {
        message: "Could not save the workspace governance policy.",
      });
    } finally {
      setBusy(false);
    }
  }, [state, dirty, patch, stepUp, addToast, load]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const description =
    "Preservation, deletion and release controls for this workspace. " +
    "Every switch here is enforced on the server for each attempt — this page " +
    "reads and writes those values, it does not evaluate them.";

  if (!workspaceId || state.kind === "loading") {
    return (
      <PageSection
        title="Workspace governance policy"
        description={description}
        data-workspace-governance-policy
        data-workspace-governance-policy-state="loading"
      >
        <Card>
          <p style={mutedStyle}>Loading workspace governance policy…</p>
        </Card>
      </PageSection>
    );
  }

  if (state.kind === "denied") {
    return (
      <PageSection
        title="Workspace governance policy"
        description={description}
        data-workspace-governance-policy
        data-workspace-governance-policy-state="denied"
      >
        <Card variant="status" tone="neutral">
          <p style={{ margin: 0, fontSize: 13, color: TOKENS.inkMuted }}>
            {state.message}
          </p>
          <p style={{ ...mutedStyle, marginTop: 6 }}>
            Ask a workspace owner or admin for governance access.
          </p>
        </Card>
      </PageSection>
    );
  }

  if (state.kind === "error") {
    return (
      <PageSection
        title="Workspace governance policy"
        description={description}
        data-workspace-governance-policy
        data-workspace-governance-policy-state="error"
      >
        <Card variant="status" tone="risk">
          <p style={{ margin: 0, fontSize: 13, color: TOKENS.inkMuted }}>
            {state.message}
          </p>
          <div style={{ marginTop: 10 }}>
            <Button
              variant="secondary"
              onClick={() => void load("reload")}
              data-workspace-governance-policy-retry
            >
              Try again
            </Button>
          </div>
        </Card>
      </PageSection>
    );
  }

  const policy = state.envelope.policy;
  const readBool = (key: BooleanFieldKey): boolean =>
    draft[key] !== undefined ? (draft[key] as boolean) : policy[key];
  const retentionValue =
    draft.defaultRetentionDays !== undefined
      ? draft.defaultRetentionDays
      : policy.defaultRetentionDays;
  const deletionMode =
    draft.evidenceDeletionMode !== undefined
      ? draft.evidenceDeletionMode
      : policy.evidenceDeletionMode;

  return (
    <PageSection
      title="Workspace governance policy"
      description={description}
      data-workspace-governance-policy
      data-workspace-governance-policy-state="ready"
      action={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button
            variant="secondary"
            onClick={reset}
            disabled={busy || !dirty}
            data-workspace-governance-policy-reset
          >
            Discard changes
          </Button>
          <Button
            variant="enterprise"
            onClick={() => void save()}
            loading={busy}
            disabled={busy || !dirty || !canManage}
            data-workspace-governance-policy-save
          >
            {busy ? "Saving…" : "Save governance policy"}
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Card padding="compact">
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              alignItems: "baseline",
              fontSize: 12,
              color: TOKENS.inkSubtle,
            }}
          >
            <span data-workspace-governance-policy-version>
              Saved version {state.envelope.version === 0 ? "—" : state.envelope.version}
            </span>
            <span data-workspace-governance-policy-source>
              {policy.source === "workspace_row"
                ? "This workspace has its own saved policy."
                : "No policy has been saved yet — the values below are the platform defaults."}
            </span>
            <span data-workspace-governance-policy-dirty={dirty ? "true" : "false"}>
              {dirty
                ? `${changedFields.length} unsaved change${changedFields.length === 1 ? "" : "s"}`
                : "No unsaved changes"}
            </span>
          </div>
        </Card>

        {conflict ? (
          <Card
            variant="status"
            tone="risk"
            data-workspace-governance-policy-conflict
          >
            <strong style={{ fontSize: 13, color: TOKENS.ink }}>
              This policy was changed by someone else
            </strong>
            <p style={{ ...mutedStyle, marginTop: 6 }}>
              Nothing was saved. Another administrator updated this policy after
              you loaded it, so your change was refused rather than allowed to
              overwrite theirs. Load the latest values, then reapply your change.
            </p>
            <div style={{ marginTop: 10 }}>
              <Button
                variant="secondary"
                onClick={() => void load("reload")}
                disabled={busy}
                data-workspace-governance-policy-reload-latest
              >
                Reload latest policy
              </Button>
            </div>
          </Card>
        ) : null}

        {!canManage ? (
          <Card variant="status" tone="neutral">
            <p style={{ margin: 0, fontSize: 13, color: TOKENS.inkMuted }}>
              You can view this policy but not change it. Saving is decided by
              the server on every attempt.
            </p>
          </Card>
        ) : null}

        <Card title="Retention and deletion" padding="compact">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 12,
                color: TOKENS.inkMuted,
              }}
            >
              <span>Default retention (days)</span>
              <input
                type="number"
                min={0}
                max={36500}
                value={retentionValue ?? ""}
                placeholder="No default"
                disabled={busy || !canManage}
                data-workspace-governance-policy-field="defaultRetentionDays"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    setDraft((p) => ({ ...p, defaultRetentionDays: null }));
                    return;
                  }
                  const n = Number(raw);
                  if (Number.isFinite(n) && n >= 0) {
                    setDraft((p) => ({
                      ...p,
                      defaultRetentionDays: Math.floor(n),
                    }));
                  }
                }}
                style={{ ...inputStyle, maxWidth: 160 }}
              />
              <span style={{ fontSize: 11, color: TOKENS.inkSubtle }}>
                Saved value:{" "}
                {policy.defaultRetentionDays === null
                  ? "no default"
                  : `${policy.defaultRetentionDays} days`}
                . Applied when a record is created; an explicit longer retention
                already on a record is never shortened.
              </span>
            </label>

            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 12,
                color: TOKENS.inkMuted,
              }}
            >
              <span>Record deletion</span>
              <select
                value={deletionMode}
                disabled={busy || !canManage}
                data-workspace-governance-policy-field="evidenceDeletionMode"
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    evidenceDeletionMode: e.target
                      .value as EvidenceDeletionMode,
                  }))
                }
                style={{ ...selectStyle, maxWidth: 280 }}
              >
                {DELETION_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 11, color: TOKENS.inkSubtle }}>
                Saved value:{" "}
                {DELETION_MODES.find((m) => m.value === policy.evidenceDeletionMode)
                  ?.label ?? policy.evidenceDeletionMode}
                .{" "}
                {DELETION_MODES.find((m) => m.value === deletionMode)?.hint ?? ""}
              </span>
            </label>
          </div>
        </Card>

        {BOOLEAN_GROUPS.map((group) => (
          <Card
            key={group.title}
            title={group.title}
            subtitle={group.description}
            padding="compact"
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {group.fields.map((f) => (
                <PolicyToggle
                  key={f.key}
                  fieldKey={f.key}
                  label={f.label}
                  hint={f.hint}
                  value={readBool(f.key)}
                  savedValue={policy[f.key]}
                  disabled={busy || !canManage}
                  onChange={(v) => setDraft((p) => ({ ...p, [f.key]: v }))}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>

      <StepUpModal control={stepUp} />
    </PageSection>
  );
}

// ---------------------------------------------------------------------------
// PolicyToggle — one boolean field, always showing its SAVED value alongside
// the pending one so an operator can never mistake a draft for the truth.
// ---------------------------------------------------------------------------

function PolicyToggle({
  fieldKey,
  label,
  hint,
  value,
  savedValue,
  disabled,
  onChange,
}: {
  fieldKey: string;
  label: string;
  hint: string;
  value: boolean;
  savedValue: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const changed = value !== savedValue;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          color: TOKENS.ink,
        }}
      >
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          data-workspace-governance-policy-field={fieldKey}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
      <span style={{ fontSize: 11, color: TOKENS.inkSubtle, paddingLeft: 24 }}>
        Saved: {savedValue ? "on" : "off"}
        {changed ? ` · unsaved change to ${value ? "on" : "off"}` : ""}
        {hint ? ` · ${hint}` : ""}
      </span>
    </div>
  );
}

export default WorkspaceGovernancePolicySection;
