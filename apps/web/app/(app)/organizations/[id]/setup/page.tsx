"use client";

/**
 * ENTERPRISE ONBOARDING WIZARD (owner-facing).
 *
 * After a platform admin provisions an enterprise customer, the ORG_OWNER
 * signs in, lands in their ORGANIZATION workspace (plan = ENTERPRISE), and
 * is guided from "workspace provisioned" to "enterprise ready".
 *
 * This is a THIN ORCHESTRATION layer. Every step reuses an endpoint that
 * ALREADY exists — see `_lib/wizardModel.ts` for the step→endpoint map.
 * The wizard persists NO new server state; checklist completion is DERIVED
 * from the same reads (see `deriveChecklist`).
 *
 * Gating:
 *   - ENTERPRISE tier gate is inherited from `organizations/layout.tsx`
 *     (non-enterprise users get a 404 before reaching here).
 *   - `PageRouteGate routeId="account.organization-setup"` gives the
 *     canonical loading/denied panel treatment.
 *   - ORG_OWNER / ORG_ADMIN is enforced server-side by every /v1/orgs/:id
 *     endpoint; client-side we surface `callerRole` and disable mutating
 *     UI (`canManage`) for lower roles, matching the org detail page.
 *
 * Reuse discipline: this file does NOT rebuild invites, billing, MFA
 * policy, retention, or legal-holds — it calls the exact endpoints those
 * surfaces already own and deep-links to them for anything deeper.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../../components/ui/PageShell";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { Badge } from "../../../../../components/ui/Badge";
import {
  WIZARD_STEPS,
  TOTAL_STEPS,
  initialWizardState,
  goNext,
  goBack,
  goToStep,
  skipStep,
  canGoBack,
  isLastStep,
  deriveChecklist,
  type WizardStepId,
  type WizardMachineState,
} from "./_lib/wizardModel";
import { SetupChecklist } from "./_lib/SetupChecklist";

// ---------------------------------------------------------------------------
// Wire shapes — mirror the existing responses (see org detail page + the
// security / retention / billing surfaces we reuse).
// ---------------------------------------------------------------------------

type OrgRole =
  | "ORG_OWNER"
  | "ORG_ADMIN"
  | "ORG_SECURITY_ADMIN"
  | "ORG_BILLING_ADMIN"
  | "ORG_AUDITOR"
  | "ORG_MEMBER";

const INVITE_ROLES: OrgRole[] = [
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
  "ORG_MEMBER",
];

const ROLE_LABELS: Record<OrgRole, string> = {
  ORG_OWNER: "Owner",
  ORG_ADMIN: "Admin",
  ORG_SECURITY_ADMIN: "Security admin",
  ORG_BILLING_ADMIN: "Billing admin",
  ORG_AUDITOR: "Auditor",
  ORG_MEMBER: "Member",
};

type OrgResponse = {
  organizationId: string;
  name: string;
  legalName: string | null;
  legalEmail: string | null;
  address: string | null;
  timezone: string | null;
  logoUrl: string | null;
  status: string;
  callerRole: OrgRole;
  summary: {
    memberCount: number;
    workspaceCount: number;
    pendingInviteCount: number;
  };
};

type MembersResponse = {
  members: Array<{
    membershipId: string;
    userId: string;
    email: string | null;
    displayName: string | null;
    role: OrgRole;
  }>;
};

type WorkspacesResponse = {
  workspaces: Array<{
    workspaceId: string;
    name: string;
    isPersonal: boolean;
  }>;
};

type PendingInvitesResponse = {
  summary: { totalPending: number };
};

// Security — MFA policy (see security-center/page.tsx).
type MfaPolicyLevel =
  | "OFF"
  | "ADMINS_ONLY"
  | "REVIEWERS_AND_ABOVE"
  | "ALL_MEMBERS"
  | "HIGH_RISK_ONLY";

const MFA_LEVELS: MfaPolicyLevel[] = [
  "OFF",
  "ADMINS_ONLY",
  "REVIEWERS_AND_ABOVE",
  "ALL_MEMBERS",
  "HIGH_RISK_ONLY",
];

const MFA_LABELS: Record<MfaPolicyLevel, string> = {
  OFF: "Off — no MFA required",
  ADMINS_ONLY: "Admins only",
  REVIEWERS_AND_ABOVE: "Reviewers and above",
  ALL_MEMBERS: "All members (recommended)",
  HIGH_RISK_ONLY: "High-risk actions only",
};

type MfaPolicyResponse = {
  policy: {
    teamId: string;
    level: MfaPolicyLevel;
    ssoReadyFlag: boolean;
    scimReadyFlag: boolean;
  };
};

// Billing (see billing/page.tsx → GET /v1/billing/overview).
type BillingOverviewResponse = {
  entitlement?: {
    plan?: string;
    teamSeats?: number;
  };
  summary?: {
    totalTeams?: number;
    activeTeamPlans?: number;
  };
};

// Retention (see evidence-lifecycle/retention/page.tsx).
const RETENTION_TEMPLATES = [
  "INSURANCE_7Y",
  "JOURNALISM_10Y",
  "CORPORATE_5Y",
  "CUSTOM",
] as const;
type RetentionTemplate = (typeof RETENTION_TEMPLATES)[number];

const RETENTION_LABELS: Record<RetentionTemplate, string> = {
  INSURANCE_7Y: "Insurance — 7 years",
  JOURNALISM_10Y: "Journalism — 10 years",
  CORPORATE_5Y: "Corporate — 5 years",
  CUSTOM: "Custom window",
};

type RetentionPoliciesResponse = {
  policies: Array<{ id?: string }>;
};

// Legal holds (see evidence-lifecycle/legal-holds/page.tsx).
const HOLD_KINDS = ["EVIDENCE", "CASE", "WORKSPACE", "ORGANIZATION"] as const;
type HoldKind = (typeof HOLD_KINDS)[number];

type EvidenceListResponse = {
  totalCount?: number;
};

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number };

// ---------------------------------------------------------------------------
// Entry — gated.
// ---------------------------------------------------------------------------

export default function OrganizationSetupPage() {
  return (
    <PageRouteGate routeId="account.organization-setup">
      <OrganizationSetupInner />
    </PageRouteGate>
  );
}

function OrganizationSetupInner() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  // -------- wizard state machine --------
  const [machine, setMachine] = useState<WizardMachineState>(initialWizardState);
  const step = WIZARD_STEPS[machine.stepIndex]!;

  // Resume at a step from a `#stepId` hash (checklist deep-links).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const idx = WIZARD_STEPS.findIndex((s) => s.id === hash);
    if (idx >= 0) setMachine((m) => goToStep(m, idx));
  }, []);

  // -------- reads --------
  const [org, setOrg] = useState<Loadable<OrgResponse>>({ kind: "loading" });
  const [members, setMembers] = useState<Loadable<MembersResponse>>({ kind: "loading" });
  const [workspaces, setWorkspaces] = useState<Loadable<WorkspacesResponse>>({ kind: "loading" });
  const [pending, setPending] = useState<Loadable<PendingInvitesResponse>>({ kind: "loading" });
  const [mfa, setMfa] = useState<Loadable<MfaPolicyResponse>>({ kind: "loading" });
  const [billing, setBilling] = useState<Loadable<BillingOverviewResponse>>({ kind: "loading" });
  const [retention, setRetention] = useState<Loadable<RetentionPoliciesResponse>>({ kind: "loading" });
  const [evidence, setEvidence] = useState<Loadable<EvidenceListResponse>>({ kind: "loading" });

  const safeFetch = useCallback(async <T,>(path: string): Promise<Loadable<T>> => {
    try {
      const data = (await apiFetch(path)) as T;
      return { kind: "ready", data };
    } catch (err: unknown) {
      const message = toSafeUserError(err, { message: "Failed to load." }).message;
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 0;
      return { kind: "error", message, status };
    }
  }, []);

  // The primary (first non-personal) workspace is where workspace-scoped
  // steps operate: workspace rename, MFA policy, retention.
  const primaryWorkspaceId = useMemo(() => {
    if (workspaces.kind !== "ready") return null;
    const nonPersonal = workspaces.data.workspaces.find((w) => !w.isPersonal);
    return (nonPersonal ?? workspaces.data.workspaces[0])?.workspaceId ?? null;
  }, [workspaces]);

  // Load org-scoped reads immediately.
  const loadOrgScoped = useCallback(async () => {
    if (!orgId) return;
    const [o, m, w, p] = await Promise.all([
      safeFetch<OrgResponse>(`/v1/orgs/${orgId}`),
      safeFetch<MembersResponse>(`/v1/orgs/${orgId}/members`),
      safeFetch<WorkspacesResponse>(`/v1/orgs/${orgId}/workspaces`),
      safeFetch<PendingInvitesResponse>(`/v1/orgs/${orgId}/invites`),
    ]);
    setOrg(o);
    setMembers(m);
    setWorkspaces(w);
    setPending(p);
    if (o.kind === "ready") {
      setCompanyName(o.data.name);
      setLegalName(o.data.legalName ?? "");
      setLegalEmail(o.data.legalEmail ?? "");
      setTimezone(o.data.timezone ?? "");
      setLogoUrl(o.data.logoUrl ?? "");
    }
  }, [orgId, safeFetch]);

  useEffect(() => {
    void loadOrgScoped();
  }, [loadOrgScoped]);

  // Billing (account-tier) + evidence count load once.
  const loadAccountScoped = useCallback(async () => {
    setBilling(await safeFetch<BillingOverviewResponse>("/v1/billing/overview"));
    setEvidence(await safeFetch<EvidenceListResponse>("/v1/evidence?scope=active&limit=1"));
  }, [safeFetch]);

  useEffect(() => {
    void loadAccountScoped();
  }, [loadAccountScoped]);

  // Workspace-scoped reads depend on the resolved primary workspace.
  const loadWorkspaceScoped = useCallback(async () => {
    if (!primaryWorkspaceId) return;
    const [mfaRes, retRes] = await Promise.all([
      safeFetch<MfaPolicyResponse>(
        `/v1/identity-security/mfa-policy?teamId=${encodeURIComponent(primaryWorkspaceId)}`,
      ),
      safeFetch<RetentionPoliciesResponse>("/v1/lifecycle/retention/policies"),
    ]);
    setMfa(mfaRes);
    setRetention(retRes);
    if (mfaRes.kind === "ready") setMfaLevel(mfaRes.data.policy.level);
    if (workspaces.kind === "ready") {
      const ws = workspaces.data.workspaces.find((w) => w.workspaceId === primaryWorkspaceId);
      if (ws) setWorkspaceName(ws.name);
    }
  }, [primaryWorkspaceId, safeFetch, workspaces]);

  useEffect(() => {
    void loadWorkspaceScoped();
  }, [loadWorkspaceScoped]);

  // -------- caller role / permission --------
  const callerRole: OrgRole | null = org.kind === "ready" ? org.data.callerRole : null;
  const canManage = callerRole === "ORG_OWNER" || callerRole === "ORG_ADMIN";

  // -------- per-step form state --------
  const [companyName, setCompanyName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [legalEmail, setLegalEmail] = useState("");
  const [timezone, setTimezone] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("ORG_MEMBER");
  const [invitedThisSession, setInvitedThisSession] = useState<string[]>([]);
  const [mfaLevel, setMfaLevel] = useState<MfaPolicyLevel>("ALL_MEMBERS");
  const [retentionTemplate, setRetentionTemplate] = useState<RetentionTemplate>("CORPORATE_5Y");
  const [retentionYears, setRetentionYears] = useState("");
  const [holdKind, setHoldKind] = useState<HoldKind>("ORGANIZATION");
  const [holdName, setHoldName] = useState("");
  const [holdReason, setHoldReason] = useState("");

  // -------- per-step busy / error / saved --------
  const [busy, setBusy] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [stepSaved, setStepSaved] = useState<Partial<Record<WizardStepId, boolean>>>({});

  const markSaved = useCallback((id: WizardStepId) => {
    setStepSaved((s) => ({ ...s, [id]: true }));
  }, []);

  // -------- mutations (each reuses an existing endpoint) --------

  const saveCompany = useCallback(async () => {
    const name = companyName.trim();
    if (!name) {
      setStepError("Organization name is required.");
      return;
    }
    setBusy(true);
    setStepError(null);
    try {
      const orNull = (s: string) => (s.trim() === "" ? null : s.trim());
      await apiFetch(`/v1/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          legalName: orNull(legalName),
          legalEmail: orNull(legalEmail),
          timezone: orNull(timezone),
        }),
      });
      markSaved("company");
      await loadOrgScoped();
    } catch (err) {
      setStepError(toSafeUserError(err, { message: "Failed to save company information." }).message);
    } finally {
      setBusy(false);
    }
  }, [orgId, companyName, legalName, legalEmail, timezone, loadOrgScoped, markSaved]);

  const saveWorkspace = useCallback(async () => {
    if (!primaryWorkspaceId) {
      setStepError("No workspace is bound to this organization yet.");
      return;
    }
    const name = workspaceName.trim();
    if (!name) {
      setStepError("Workspace name is required.");
      return;
    }
    setBusy(true);
    setStepError(null);
    try {
      await apiFetch(`/v1/teams/${primaryWorkspaceId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      markSaved("workspace");
    } catch (err) {
      setStepError(toSafeUserError(err, { message: "Failed to rename the workspace." }).message);
    } finally {
      setBusy(false);
    }
  }, [primaryWorkspaceId, workspaceName, markSaved]);

  const saveBranding = useCallback(async () => {
    setBusy(true);
    setStepError(null);
    try {
      await apiFetch(`/v1/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: (companyName.trim() || (org.kind === "ready" ? org.data.name : "")),
          logoUrl: logoUrl.trim() === "" ? null : logoUrl.trim(),
        }),
      });
      markSaved("branding");
      await loadOrgScoped();
    } catch (err) {
      setStepError(toSafeUserError(err, { message: "Failed to save branding." }).message);
    } finally {
      setBusy(false);
    }
  }, [orgId, companyName, logoUrl, org, loadOrgScoped, markSaved]);

  const sendInvite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) {
      setStepError("Email is required.");
      return;
    }
    setBusy(true);
    setStepError(null);
    try {
      await apiFetch(`/v1/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      setInvitedThisSession((s) => [...s, email]);
      setInviteEmail("");
      markSaved("invite");
      void loadOrgScoped();
    } catch (err) {
      setStepError(toSafeUserError(err, { message: "Failed to send the invite." }).message);
    } finally {
      setBusy(false);
    }
  }, [orgId, inviteEmail, inviteRole, loadOrgScoped, markSaved]);

  const saveMfa = useCallback(async () => {
    if (!primaryWorkspaceId) {
      setStepError("No workspace is bound to this organization yet.");
      return;
    }
    setBusy(true);
    setStepError(null);
    try {
      const res = (await apiFetch("/v1/identity-security/mfa-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: primaryWorkspaceId, level: mfaLevel }),
      })) as { error?: { code?: string } } | null;
      if (res && res.error && res.error.code === "STEP_UP_REQUIRED") {
        setStepError("This change needs step-up verification. Set it from Security Center.");
        return;
      }
      markSaved("security");
      await loadWorkspaceScoped();
    } catch (err) {
      setStepError(toSafeUserError(err, { message: "Failed to save the MFA policy." }).message);
    } finally {
      setBusy(false);
    }
  }, [primaryWorkspaceId, mfaLevel, loadWorkspaceScoped, markSaved]);

  const saveRetention = useCallback(async () => {
    if (retentionTemplate === "CUSTOM" && !retentionYears) {
      setStepError("Enter a number of years for a custom window.");
      return;
    }
    setBusy(true);
    setStepError(null);
    try {
      await apiFetch("/v1/lifecycle/retention/policies", {
        method: "POST",
        body: JSON.stringify({
          name: `${RETENTION_LABELS[retentionTemplate]} (default)`,
          template: retentionTemplate,
          ...(retentionTemplate === "CUSTOM" && retentionYears
            ? { years: Number.parseInt(retentionYears, 10) }
            : {}),
          scopeKind: "WORKSPACE",
          scopeTargetId: primaryWorkspaceId ?? null,
        }),
      });
      markSaved("retention");
      await loadWorkspaceScoped();
    } catch (err) {
      setStepError(toSafeUserError(err, { message: "Failed to create the retention policy." }).message);
    } finally {
      setBusy(false);
    }
  }, [retentionTemplate, retentionYears, primaryWorkspaceId, loadWorkspaceScoped, markSaved]);

  const createLegalHold = useCallback(async () => {
    const name = holdName.trim();
    const reason = holdReason.trim();
    if (!name || !reason) {
      setStepError("A legal hold needs both a name and a reason.");
      return;
    }
    setBusy(true);
    setStepError(null);
    try {
      await apiFetch("/v1/lifecycle/legal-holds", {
        method: "POST",
        body: JSON.stringify({
          kind: holdKind,
          name,
          reason,
          expiresAtUtc: null,
          scopeTargetId: holdKind === "ORGANIZATION" ? orgId : primaryWorkspaceId ?? null,
        }),
      });
      markSaved("legalHolds");
      setHoldName("");
      setHoldReason("");
    } catch (err) {
      setStepError(toSafeUserError(err, { message: "Failed to create the legal hold." }).message);
    } finally {
      setBusy(false);
    }
  }, [holdKind, holdName, holdReason, orgId, primaryWorkspaceId, markSaved]);

  // -------- checklist derivation (shared source of truth) --------
  const criteria = useMemo(
    () =>
      deriveChecklist({
        org:
          org.kind === "ready"
            ? {
                legalName: org.data.legalName,
                legalEmail: org.data.legalEmail,
                timezone: org.data.timezone,
              }
            : null,
        memberCount: members.kind === "ready" ? members.data.members.length : null,
        pendingInviteCount:
          pending.kind === "ready" ? pending.data.summary.totalPending : null,
        mfaPolicyLevel: mfa.kind === "ready" ? mfa.data.policy.level : null,
        retentionPolicyCount:
          retention.kind === "ready" ? retention.data.policies.length : null,
        evidenceCount:
          evidence.kind === "ready" ? evidence.data.totalCount ?? 0 : null,
      }),
    [org, members, pending, mfa, retention, evidence],
  );

  const setupHref = `/organizations/${orgId}/setup`;

  // -------- navigation --------
  const onNext = useCallback(() => {
    setStepError(null);
    setMachine((m) => goNext(m));
  }, []);
  const onBack = useCallback(() => {
    setStepError(null);
    setMachine((m) => goBack(m));
  }, []);
  const onSkip = useCallback(() => {
    setStepError(null);
    setMachine((m) => skipStep(m));
  }, []);

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------

  return (
    <PageShell
      data-page="organization-setup-wizard"
      data-org-id={orgId}
      data-caller-role={callerRole ?? ""}
      data-step-id={step.id}
      data-step-index={machine.stepIndex}
      data-total-steps={TOTAL_STEPS}
      header={
        <PageHeader
          eyebrow="Enterprise onboarding"
          title={`Set up ${org.kind === "ready" ? org.data.name : "your organization"}`}
          subtitle="A guided path from a freshly provisioned workspace to enterprise ready. Optional steps can be skipped and finished later."
          secondaryActions={
            <Link
              href={`/organizations/${orgId}`}
              data-action="breadcrumb-org"
              style={linkReset}
            >
              <Button variant="ghost" size="sm">
                ← Organization
              </Button>
            </Link>
          }
        />
      }
    >
      {org.kind === "error" && org.status === 403 && (
        <div role="alert" style={errorBox}>
          You don’t have access to this organization’s setup.
        </div>
      )}
      {callerRole !== null && !canManage && (
        <div role="alert" data-role-restricted style={warnBox}>
          You’re signed in as {ROLE_LABELS[callerRole]}. Setup changes
          require an organization Owner or Admin.
        </div>
      )}

      {/* Progress indicator */}
      <ProgressBar
        steps={WIZARD_STEPS.map((s) => ({
          id: s.id,
          title: s.title,
          skippable: s.skippable,
        }))}
        currentIndex={machine.stepIndex}
        skipped={machine.skipped}
        onJump={(idx) => setMachine((m) => goToStep(m, idx))}
      />

      {/* Step body */}
      <Card
        variant="summary"
        data-step-body={step.id}
        header={
          <div>
            <div style={kicker}>
              Step {step.index} of {TOTAL_STEPS}
              {step.skippable ? " · optional" : ""}
            </div>
            <h2
              style={{
                margin: "0.25rem 0 0.15rem",
                fontSize: 18,
                fontWeight: 650,
                color: "var(--ink-primary, #0f172a)",
              }}
            >
              {step.title}
            </h2>
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
              {step.subtitle}
            </p>
          </div>
        }
      >
        {stepError && (
          <div role="alert" data-state="error" style={errorBox}>
            {stepError}
          </div>
        )}

        {/* ---- STEP: Company ---- */}
        {step.id === "company" && (
          <form
            data-step-form="company"
            onSubmit={(e) => {
              e.preventDefault();
              void saveCompany();
            }}
            style={formGrid}
          >
            <Field label="Organization name" required>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={!canManage || busy}
                data-input="company-name"
                style={input}
              />
            </Field>
            <Field label="Legal name" hint="(optional)">
              <input
                type="text"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                disabled={!canManage || busy}
                data-input="legal-name"
                style={input}
              />
            </Field>
            <Field label="Legal email" hint="(optional)">
              <input
                type="email"
                value={legalEmail}
                onChange={(e) => setLegalEmail(e.target.value)}
                disabled={!canManage || busy}
                data-input="legal-email"
                style={input}
              />
            </Field>
            <Field label="Timezone" hint="(IANA, e.g. America/Los_Angeles)">
              <input
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={!canManage || busy}
                data-input="timezone"
                spellCheck={false}
                style={input}
              />
            </Field>
            <SaveRow saved={stepSaved.company} disabled={!canManage || busy}>
              {busy ? "Saving…" : "Save company information"}
            </SaveRow>
          </form>
        )}

        {/* ---- STEP: Workspace ---- */}
        {step.id === "workspace" && (
          <form
            data-step-form="workspace"
            onSubmit={(e) => {
              e.preventDefault();
              void saveWorkspace();
            }}
            style={formGrid}
          >
            <Field label="Workspace name" required>
              <input
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                disabled={!canManage || busy || !primaryWorkspaceId}
                data-input="workspace-name"
                style={input}
              />
            </Field>
            {!primaryWorkspaceId && workspaces.kind === "ready" && (
              <div style={hintBox}>
                No workspace is bound yet.{" "}
                <Link href="/teams" data-action="open-workspace-admin">
                  Create one in Workspace administration →
                </Link>
              </div>
            )}
            <SaveRow
              saved={stepSaved.workspace}
              disabled={!canManage || busy || !primaryWorkspaceId}
            >
              {busy ? "Saving…" : "Save workspace name"}
            </SaveRow>
          </form>
        )}

        {/* ---- STEP: Branding ---- */}
        {step.id === "branding" && (
          <form
            data-step-form="branding"
            onSubmit={(e) => {
              e.preventDefault();
              void saveBranding();
            }}
            style={formGrid}
          >
            <Field label="Logo URL" hint="(appears on reports & verification pages)">
              <input
                type="url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                disabled={!canManage || busy}
                placeholder="https://"
                spellCheck={false}
                data-input="logo-url"
                style={input}
              />
            </Field>
            <SaveRow saved={stepSaved.branding} disabled={!canManage || busy}>
              {busy ? "Saving…" : "Save branding"}
            </SaveRow>
          </form>
        )}

        {/* ---- STEP: Administrator (confirmation, no-op) ---- */}
        {step.id === "administrator" && (
          <div data-step-form="administrator" style={{ fontSize: 13.5 }}>
            {org.kind === "ready" ? (
              <>
                <p style={{ marginTop: 0 }}>
                  Your organization already has a primary administrator — the
                  owner who signed in to run this setup.
                </p>
                <OwnerCard members={members} />
                <p style={{ marginBottom: 0, opacity: 0.8 }}>
                  You can add more admins on the{" "}
                  <Link href={`/organizations/${orgId}/admin/members`}>
                    Members
                  </Link>{" "}
                  page, or in the “Invite employees” step next.
                </p>
              </>
            ) : (
              <p>Loading owner…</p>
            )}
          </div>
        )}

        {/* ---- STEP: Invite ---- */}
        {step.id === "invite" && (
          <div data-step-form="invite" style={{ display: "grid", gap: 12 }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendInvite();
              }}
              style={formGrid}
            >
              <Field label="Employee email" required>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  disabled={!canManage || busy}
                  data-input="invite-email"
                  style={input}
                />
              </Field>
              <Field label="Role">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                  disabled={!canManage || busy}
                  data-input="invite-role"
                  style={input}
                >
                  {INVITE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy}
                  disabled={!canManage || busy || !inviteEmail.trim()}
                  data-action="send-invite"
                >
                  {busy ? "Sending…" : "Send invite"}
                </Button>
                <span style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
                  Add as many people as you like — the form clears after each.
                </span>
              </div>
            </form>
            {invitedThisSession.length > 0 && (
              <div data-invited-count={invitedThisSession.length} style={hintBox}>
                Invited this session: {invitedThisSession.join(", ")}
              </div>
            )}
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Manage, resend, or revoke invites any time on the{" "}
              <Link href={`/organizations/${orgId}/admin/members`}>
                Members page
              </Link>
              .
            </div>
          </div>
        )}

        {/* ---- STEP: Billing ---- */}
        {step.id === "billing" && (
          <div data-step-form="billing" style={{ fontSize: 13.5 }}>
            {billing.kind === "loading" && <p>Loading billing overview…</p>}
            {billing.kind === "error" && (
              <div role="alert" style={errorBox}>
                {billing.status === 403
                  ? "Billing visibility requires an admin or billing-admin role."
                  : "Couldn’t load the billing overview."}
              </div>
            )}
            {billing.kind === "ready" && (
              <div style={{ display: "grid", gap: 10 }}>
                <ReadOnlyRow
                  label="Plan"
                  value={billing.data.entitlement?.plan ?? "—"}
                  dataAttr="billing-plan"
                />
                <ReadOnlyRow
                  label="Included team seats"
                  value={
                    typeof billing.data.entitlement?.teamSeats === "number"
                      ? String(billing.data.entitlement.teamSeats)
                      : "—"
                  }
                  dataAttr="billing-seats"
                />
                <ReadOnlyRow
                  label="Active team plans"
                  value={
                    typeof billing.data.summary?.activeTeamPlans === "number"
                      ? String(billing.data.summary.activeTeamPlans)
                      : "—"
                  }
                  dataAttr="billing-active-teams"
                />
                <p style={{ margin: 0, opacity: 0.75, fontSize: 12.5 }}>
                  These values are read-only here. Manage plan and payment on{" "}
                  <Link href="/billing" data-action="open-billing">
                    Billing
                  </Link>
                  .
                </p>
              </div>
            )}
          </div>
        )}

        {/* ---- STEP: Security ---- */}
        {step.id === "security" && (
          <div data-step-form="security" style={{ display: "grid", gap: 14 }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveMfa();
              }}
              style={formGrid}
            >
              <Field label="MFA policy">
                <select
                  value={mfaLevel}
                  onChange={(e) => setMfaLevel(e.target.value as MfaPolicyLevel)}
                  disabled={!canManage || busy || !primaryWorkspaceId}
                  data-input="mfa-level"
                  style={input}
                >
                  {MFA_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {MFA_LABELS[l]}
                    </option>
                  ))}
                </select>
              </Field>
              <SaveRow
                saved={stepSaved.security}
                disabled={!canManage || busy || !primaryWorkspaceId}
              >
                {busy ? "Saving…" : "Save MFA policy"}
              </SaveRow>
            </form>

            {/* SSO / SCIM — detect + link + recommend (do NOT rebuild). */}
            <div data-security-readiness style={{ display: "grid", gap: 8 }}>
              <ReadinessRow
                label="Single sign-on (SAML / OIDC)"
                ready={mfa.kind === "ready" ? mfa.data.policy.ssoReadyFlag : null}
                href="/admin/identity"
                cta="Configure SSO"
              />
              <ReadinessRow
                label="SCIM user provisioning"
                ready={mfa.kind === "ready" ? mfa.data.policy.scimReadyFlag : null}
                href="/admin/identity/scim"
                cta="Configure SCIM"
              />
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Deeper SSO configuration lives in{" "}
                <Link href="/security-center/sso" data-action="open-sso">
                  Security Center → SSO
                </Link>
                . We recommend enabling SSO for all enterprise workspaces.
              </div>
            </div>
          </div>
        )}

        {/* ---- STEP: Retention ---- */}
        {step.id === "retention" && (
          <form
            data-step-form="retention"
            onSubmit={(e) => {
              e.preventDefault();
              void saveRetention();
            }}
            style={formGrid}
          >
            <Field label="Default retention window">
              <select
                value={retentionTemplate}
                onChange={(e) => setRetentionTemplate(e.target.value as RetentionTemplate)}
                disabled={!canManage || busy}
                data-input="retention-template"
                style={input}
              >
                {RETENTION_TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {RETENTION_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            {retentionTemplate === "CUSTOM" && (
              <Field label="Years" required>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={retentionYears}
                  onChange={(e) => setRetentionYears(e.target.value)}
                  disabled={!canManage || busy}
                  data-input="retention-years"
                  style={input}
                />
              </Field>
            )}
            <SaveRow
              saved={stepSaved.retention}
              disabled={
                !canManage ||
                busy ||
                (retentionTemplate === "CUSTOM" && !retentionYears)
              }
            >
              {busy ? "Creating…" : "Set retention default"}
            </SaveRow>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Manage all policies on{" "}
              <Link href="/evidence-lifecycle/retention" data-action="open-retention">
                Retention
              </Link>
              .
            </div>
          </form>
        )}

        {/* ---- STEP: Legal holds ---- */}
        {step.id === "legalHolds" && (
          <form
            data-step-form="legalHolds"
            onSubmit={(e) => {
              e.preventDefault();
              void createLegalHold();
            }}
            style={formGrid}
          >
            <p style={{ marginTop: 0, fontSize: 13, opacity: 0.85 }}>
              Optional. A legal hold suspends deletion for its scope until
              released. Most organizations skip this during setup and place
              holds when litigation is anticipated.
            </p>
            <Field label="Hold scope">
              <select
                value={holdKind}
                onChange={(e) => setHoldKind(e.target.value as HoldKind)}
                disabled={!canManage || busy}
                data-input="hold-kind"
                style={input}
              >
                {HOLD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.charAt(0) + k.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name" required>
              <input
                type="text"
                value={holdName}
                onChange={(e) => setHoldName(e.target.value)}
                disabled={!canManage || busy}
                data-input="hold-name"
                style={input}
              />
            </Field>
            <Field label="Reason" required>
              <input
                type="text"
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                disabled={!canManage || busy}
                data-input="hold-reason"
                style={input}
              />
            </Field>
            <SaveRow
              saved={stepSaved.legalHolds}
              disabled={!canManage || busy || !holdName.trim() || !holdReason.trim()}
            >
              {busy ? "Creating…" : "Create legal hold"}
            </SaveRow>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Manage holds on{" "}
              <Link href="/evidence-lifecycle/legal-holds" data-action="open-legal-holds">
                Legal holds
              </Link>
              .
            </div>
          </form>
        )}

        {/* ---- STEP: Evidence defaults (informational) ---- */}
        {step.id === "evidenceDefaults" && (
          <div data-step-form="evidenceDefaults" style={{ fontSize: 13.5 }}>
            <p style={{ marginTop: 0 }}>
              Evidence capture and preservation defaults (hashing, signing,
              timestamping) are on by default for every workspace and are
              managed per workspace.
            </p>
            <Link
              href={primaryWorkspaceId ? `/teams/${primaryWorkspaceId}` : "/teams"}
              data-action="open-workspace-settings"
              style={linkReset}
            >
              <Button variant="secondary" size="sm">
                Open workspace settings →
              </Button>
            </Link>
          </div>
        )}

        {/* ---- STEP: First capture ---- */}
        {step.id === "firstCapture" && (
          <div data-step-form="firstCapture" style={{ fontSize: 13.5 }}>
            <p style={{ marginTop: 0 }}>
              Record your organization’s first piece of signed, hashed
              evidence. This proves the full pipeline end-to-end.
            </p>
            <Link href="/capture" data-action="open-capture" style={linkReset}>
              <Button variant="primary" size="sm">
                Capture evidence →
              </Button>
            </Link>
          </div>
        )}

        {/* ---- STEP: Finish (success) ---- */}
        {step.id === "finish" && (
          <SuccessScreen
            orgName={org.kind === "ready" ? org.data.name : "your organization"}
            criteria={criteria}
            setupHref={setupHref}
          />
        )}
      </Card>

      {/* Nav controls */}
      <nav
        data-wizard-nav
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          disabled={!canGoBack(machine)}
          data-action="wizard-back"
        >
          ← Back
        </Button>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {step.skippable && !isLastStep(machine) && (
            <Button
              type="button"
              variant="ghost"
              onClick={onSkip}
              data-action="wizard-skip"
            >
              Skip for now
            </Button>
          )}
          {!isLastStep(machine) ? (
            <Button
              type="button"
              variant="primary"
              onClick={onNext}
              data-action="wizard-next"
            >
              Next →
            </Button>
          ) : (
            <Link href="/home" data-action="go-to-workspace" style={linkReset}>
              <Button variant="primary">Go to workspace →</Button>
            </Link>
          )}
        </div>
      </nav>

      {/* Live checklist alongside the wizard */}
      <div>
        <SetupChecklist criteria={criteria} />
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Sub-components.
// ---------------------------------------------------------------------------

function ProgressBar({
  steps,
  currentIndex,
  skipped,
  onJump,
}: {
  steps: Array<{ id: WizardStepId; title: string; skippable: boolean }>;
  currentIndex: number;
  skipped: ReadonlySet<WizardStepId>;
  onJump: (idx: number) => void;
}) {
  const pct = Math.round(((currentIndex + 1) / steps.length) * 100);
  return (
    <div data-wizard-progress data-progress-pct={pct}>
      <div
        style={{
          height: 6,
          borderRadius: 999,
          background: "var(--surface-muted, #f1f4f9)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "var(--enterprise-accent, #6b5bff)",
            transition: "width 160ms ease",
          }}
        />
      </div>
      <ol
        style={{
          listStyle: "none",
          display: "flex",
          gap: 6,
          padding: 0,
          margin: "8px 0 0",
          overflowX: "auto",
          fontSize: 11,
        }}
      >
        {steps.map((s, idx) => {
          const state =
            idx === currentIndex
              ? "current"
              : skipped.has(s.id)
                ? "skipped"
                : idx < currentIndex
                  ? "done"
                  : "upcoming";
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onJump(idx)}
                data-progress-step={s.id}
                data-progress-state={state}
                title={s.title}
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                  background:
                    state === "current"
                      ? "var(--status-governance-bg, #eeebff)"
                      : state === "done"
                        ? "var(--status-verified-bg, #ecfdf5)"
                        : "var(--surface-card, #ffffff)",
                  color: "var(--ink-primary, #0f172a)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  opacity: state === "upcoming" ? 0.6 : 1,
                }}
              >
                {idx + 1}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SuccessScreen({
  orgName,
  criteria,
  setupHref,
}: {
  orgName: string;
  criteria: ReadonlyArray<ReturnType<typeof deriveChecklist>[number]>;
  setupHref: string;
}) {
  return (
    <div data-success-screen style={{ textAlign: "center", padding: "0.5rem 0" }}>
      <div
        aria-hidden
        style={{
          width: 56,
          height: 56,
          borderRadius: 999,
          background: "var(--status-verified-bg, #ecfdf5)",
          border: "2px solid var(--status-verified-solid, #10b981)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 26,
          color: "var(--status-verified-fg, #065f46)",
          margin: "0 auto 0.6rem",
        }}
      >
        ✓
      </div>
      <h2 style={{ margin: "0 0 0.35rem", fontSize: 20, fontWeight: 650, color: "var(--ink-primary, #0f172a)" }}>
        {orgName} is enterprise ready
      </h2>
      <p style={{ margin: "0 auto 1rem", fontSize: 13.5, color: "var(--ink-secondary, #475569)", maxWidth: 520 }}>
        Your organization is set up. You can revisit any optional step from the
        checklist below at any time.
      </p>
      <div style={{ maxWidth: 480, margin: "0 auto 1rem", textAlign: "left" }}>
        <SetupChecklist criteria={criteria} setupHref={setupHref} compact />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
        <Link href="/home" data-action="success-go-to-workspace" style={linkReset}>
          <Button variant="primary" size="sm">
            Go to workspace →
          </Button>
        </Link>
        <Link href="/capture" data-action="success-capture" style={linkReset}>
          <Button variant="secondary" size="sm">
            Capture evidence
          </Button>
        </Link>
      </div>
    </div>
  );
}

function OwnerCard({ members }: { members: Loadable<MembersResponse> }) {
  const owner =
    members.kind === "ready"
      ? members.data.members.find((m) => m.role === "ORG_OWNER") ?? null
      : null;
  return (
    <div data-owner-card style={{ margin: "0.5rem 0 0.9rem" }}>
      <Card variant="admin" padding="compact">
        {owner ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: "var(--ink-primary, #0f172a)" }}>
                {owner.displayName || owner.email || "(owner)"}
              </div>
              {owner.email && (
                <div style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
                  {owner.email}
                </div>
              )}
            </div>
            <Badge tone="governance" subtle>
              {ROLE_LABELS.ORG_OWNER}
            </Badge>
          </div>
        ) : (
          <span style={{ color: "var(--ink-muted, #94a3b8)" }}>Loading owner…</span>
        )}
      </Card>
    </div>
  );
}

function ReadinessRow({
  label,
  ready,
  href,
  cta,
}: {
  label: string;
  ready: boolean | null;
  href: string;
  cta: string;
}) {
  const stateLabel = ready === null ? "…" : ready ? "Ready" : "Not configured";
  return (
    <div
      data-readiness-row
      data-readiness-state={ready === null ? "loading" : ready ? "ready" : "todo"}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "0.6rem 0.75rem",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        borderRadius: 10,
        background: "var(--surface-card, #ffffff)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: "var(--ink-primary, #0f172a)" }}>{label}</span>
        <Badge tone={ready ? "verified" : "neutral"} subtle>
          {stateLabel}
        </Badge>
      </div>
      <Link href={href} style={linkReset}>
        <Button variant="ghost" size="sm">
          {cta} →
        </Button>
      </Link>
    </div>
  );
}

function ReadOnlyRow({
  label,
  value,
  dataAttr,
}: {
  label: string;
  value: string;
  dataAttr: string;
}) {
  return (
    <div
      data-readonly-row={dataAttr}
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 10,
        padding: "0.55rem 0.7rem",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        borderRadius: 10,
        background: "var(--surface-card, #ffffff)",
      }}
    >
      <span style={{ color: "var(--ink-muted, #94a3b8)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: "var(--ink-primary, #0f172a)" }}>{value}</span>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
      {label}
      {required ? <span style={{ color: "var(--status-risk-fg, #991b1b)" }}> *</span> : null}
      {hint ? <small style={{ color: "var(--ink-muted, #94a3b8)" }}> {hint}</small> : null}
      {children}
    </label>
  );
}

function SaveRow({
  children,
  disabled,
  saved,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  saved?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={disabled}
        data-action="step-save"
      >
        {children}
      </Button>
      {saved && (
        <span data-step-saved>
          <Badge tone="verified" subtle>
            Saved ✓
          </Badge>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles.
// ---------------------------------------------------------------------------

const kicker: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-muted, #94a3b8)",
};

const formGrid: React.CSSProperties = {
  display: "grid",
  gap: 12,
  maxWidth: 520,
};

const input: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "0.5rem 0.6rem",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: 10,
  background: "var(--surface-card, #ffffff)",
  color: "var(--ink-primary, #0f172a)",
  fontSize: 13,
};

const linkReset: React.CSSProperties = {
  textDecoration: "none",
  flexShrink: 0,
};

const errorBox: React.CSSProperties = {
  marginTop: 8,
  marginBottom: 8,
  padding: "0.5rem 0.65rem",
  border: "1px solid var(--status-risk-border, #fecaca)",
  borderRadius: 10,
  fontSize: 13,
  color: "var(--status-risk-fg, #991b1b)",
  background: "var(--status-risk-bg, #fef2f2)",
};

const warnBox: React.CSSProperties = {
  marginTop: 8,
  padding: "0.5rem 0.65rem",
  border: "1px solid var(--status-pending-border, #fde68a)",
  borderRadius: 10,
  fontSize: 13,
  color: "var(--status-pending-fg, #78350f)",
  background: "var(--status-pending-bg, #fef3c7)",
};

const hintBox: React.CSSProperties = {
  padding: "0.5rem 0.65rem",
  border: "1px dashed var(--border-strong, rgba(15,23,42,0.14))",
  borderRadius: 10,
  fontSize: 12.5,
  color: "var(--ink-secondary, #475569)",
};
