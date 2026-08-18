"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

/**
 * Phase A.1B — Organization detail (operational console).
 *
 * Sectioned layout — every section is wired to a real audited
 * endpoint:
 *
 *   1. Header   → GET  /v1/orgs/:id                (read)
 *   2. Overview → derived counts (members, workspaces, pending invites,
 *                 owners, last audit)
 *   3. Settings → PATCH /v1/orgs/:id               (admin+)
 *   4. Members  → GET  /v1/orgs/:id/members        (member+)
 *                 PATCH /v1/orgs/:id/members/:mid  (admin+)
 *                 DELETE /v1/orgs/:id/members/:mid (admin+)
 *   5. Invites  → GET  /v1/orgs/:id/invites        (admin+)
 *                 POST /v1/orgs/:id/invites        (admin+)
 *                 POST /v1/orgs/:id/invites/:iid/resend
 *                 DELETE /v1/orgs/:id/invites/:iid
 *   6. Workspaces → GET /v1/orgs/:id/workspaces    (member+)
 *                 POST /v1/orgs/:id/workspaces/:teamId/suspend (admin+)
 *                 POST /v1/orgs/:id/workspaces/:teamId/resume  (admin+)
 *   7. Audit    → GET  /v1/orgs/:id/audit-events?cursor=&take=&type=
 *                 (auditor+)
 *
 * Operational rules:
 *
 *   - All CTAs are wired to real audited endpoints. Lifecycle actions
 *     (leave — lifecycle Phase 1; transfer ownership + organization
 *     closure — lifecycle Phase 6) are fully self-service: leave in the
 *     header for non-owners, transfer/closure in the owner-only
 *     lifecycle section below.
 *   - Billing visibility is honest: Phase 2.7X has not unified org-
 *     level billing yet — per-workspace billing remains the source of
 *     truth. We deep-link to /teams (Workspace administration) and
 *     /billing rather than render a fake plan/seats card.
 *   - Governance visibility surfaces what the canonical endpoints
 *     ALREADY own (member role distribution, pending invite count,
 *     last audit event). No invented signals.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { usePlatformContext } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OrgWorkspaceLifecycleControls } from "../../../../components/organizations/OrgWorkspaceLifecycleControls";
import {
  formatUserDate,
  formatUserTime,
  formatUtcAuditDateTime,
} from "../../../../lib/date";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge, type BadgeTone } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import {
  StepUpVerify,
  extractStepUp,
  type StepUpMethods,
  type StepUpProof,
} from "../../security-center/components/PersonalSecuritySections";

// ---------------------------------------------------------------------------
// Types — mirror Phase 2.7X Stage 3/4/5 wire shapes.
// ---------------------------------------------------------------------------

type OrgRole =
  | "ORG_OWNER"
  | "ORG_ADMIN"
  | "ORG_SECURITY_ADMIN"
  | "ORG_BILLING_ADMIN"
  | "ORG_AUDITOR"
  | "ORG_MEMBER";

const ROLE_RANK: Record<OrgRole, number> = {
  ORG_OWNER: 5,
  ORG_ADMIN: 4,
  ORG_SECURITY_ADMIN: 3,
  ORG_BILLING_ADMIN: 3,
  ORG_AUDITOR: 2,
  ORG_MEMBER: 1,
};

const ROLE_LABELS: Record<OrgRole, string> = {
  ORG_OWNER: "Owner",
  ORG_ADMIN: "Admin",
  ORG_SECURITY_ADMIN: "Security admin",
  ORG_BILLING_ADMIN: "Billing admin",
  ORG_AUDITOR: "Auditor",
  ORG_MEMBER: "Member",
};

const ALL_ROLES: OrgRole[] = [
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
  "ORG_BILLING_ADMIN",
  "ORG_AUDITOR",
  "ORG_MEMBER",
];

type OrgResponse = {
  organizationId: string;
  name: string;
  legalName: string | null;
  legalEmail: string | null;
  // Phase A.1B Wave 2 — full metadata round-trip on the GET so the
  // Settings panel can prefill every field the PATCH accepts.
  address: string | null;
  timezone: string | null;
  logoUrl: string | null;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  billingOwnerUserId: string | null;
  verificationState: string | null;
  verifiedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
  callerRole: OrgRole;
  summary: {
    memberCount: number;
    workspaceCount: number;
    pendingInviteCount: number;
  };
};

type MembersResponse = {
  organizationId: string;
  summary: { totalMembers: number };
  members: Array<{
    membershipId: string;
    userId: string;
    email: string | null;
    displayName: string | null;
    role: OrgRole;
    memberSince: string;
  }>;
};

type WorkspaceBilling = {
  plan: string;
  status: string;
  includedSeats: number;
  overSeatLimit: boolean;
  billingOwnerUserId: string | null;
};

type WorkspacesResponse = {
  organizationId: string;
  summary: { totalWorkspaces: number };
  // Phase A.1B Wave 2 — billing visibility flag. true when caller is
  // ORG_OWNER / ORG_ADMIN / ORG_BILLING_ADMIN; false otherwise.
  callerCanSeeBilling: boolean;
  workspaces: Array<{
    workspaceId: string;
    name: string;
    isPersonal: boolean;
    createdAt: string;
    // Optional — present only when callerCanSeeBilling = true.
    billing?: WorkspaceBilling;
  }>;
};

type AuditResponse = {
  organizationId: string;
  summary: {
    totalEvents: number;
    nextCursor?: string | null;
    appliedTake?: number;
    appliedEventTypeFilter?: string[] | null;
  };
  events: Array<{
    id: string;
    actorUserId: string | null;
    actorEmail: string | null;
    actorDisplayName: string | null;
    eventType: string;
    targetType: string;
    targetId: string | null;
    metadata: unknown;
    createdAt: string;
  }>;
};

type PendingInvitesResponse = {
  organizationId: string;
  summary: { totalPending: number };
  invites: Array<{
    inviteId: string;
    email: string;
    role: OrgRole;
    invitedByUserId: string;
    expiresAt: string;
    lastResentAt: string | null;
    resendCount: number;
    createdAt: string;
  }>;
};

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number };

// ---------------------------------------------------------------------------
// Page entry.
// ---------------------------------------------------------------------------

export default function OrganizationDetailPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <OrganizationDetailInner />
    </PageRouteGate>
  );
}

function OrganizationDetailInner() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  // ---- data state ----
  const [org, setOrg] = useState<Loadable<OrgResponse>>({ kind: "loading" });
  const [members, setMembers] = useState<Loadable<MembersResponse>>({ kind: "loading" });
  const [workspaces, setWorkspaces] = useState<Loadable<WorkspacesResponse>>({ kind: "loading" });
  const [audit, setAudit] = useState<Loadable<AuditResponse>>({ kind: "loading" });
  const [pendingInvites, setPendingInvites] = useState<Loadable<PendingInvitesResponse>>({
    kind: "loading",
  });

  // Phase 4 (Enterprise Administration) dedup — the member/invite/audit
  // mutation state (row busy maps, invite modal, audit filter) moved to the
  // canonical admin tabs (admin/members, admin/audit). This page keeps only
  // the settings mutation + the read-only summary loads.

  // ---- settings form ----
  const [settingsName, setSettingsName] = useState("");
  const [settingsLegalName, setSettingsLegalName] = useState("");
  const [settingsLegalEmail, setSettingsLegalEmail] = useState("");
  const [settingsAddress, setSettingsAddress] = useState("");
  const [settingsTimezone, setSettingsTimezone] = useState("");
  const [settingsLogoUrl, setSettingsLogoUrl] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSavedAt, setSettingsSavedAt] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Generic safe loader.
  // ---------------------------------------------------------------------------
  const safeFetch = useCallback(
    async <T,>(path: string): Promise<Loadable<T>> => {
      try {
        // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
        const data = (await apiFetch(path)) as T;
        return { kind: "ready", data };
      } catch (err: unknown) {
        const message = toSafeUserError(err, { message: "Failed to load." }).message;
        const status =
          typeof (err as { statusCode?: number }).statusCode === "number"
            ? ((err as { statusCode: number }).statusCode)
            : 0;
        return { kind: "error", message, status };
      }
    },
    [],
  );

  /**
   * PHASE 13 (NEW-064) — REVALIDATE WITHOUT UNMOUNTING WHAT ALREADY RENDERED.
   *
   * `fetchAll` used to reset every section to `{ kind: "loading" }`
   * unconditionally. Each section renders its list ONLY while `kind === "ready"`
   * (`{workspaces.kind === "loading" && <RowLoading />}`), so a refresh tore the
   * whole `<ul>` down and built it again from scratch.
   *
   * That destroyed component state the user had just produced. `fetchAll` is the
   * `onChanged` callback every lifecycle control calls after a SUCCESSFUL
   * mutation, and `OrgWorkspaceLifecycleControls` announces that success from its
   * own `notice` state inside a `role="status"` region — inside the list. So the
   * sequence was: mutate, set the announcement, refresh, unmount the
   * announcement. The region came back mounted and EMPTY, which means a screen
   * reader was told nothing at all about an action that suspended a workspace
   * and locked its members out.
   *
   * Keeping the previous `ready` data while revalidating fixes that for every
   * child at once, and removes the flash of skeleton a sighted user saw on each
   * refresh. A section that has NEVER loaded still shows its loading state — the
   * only thing that changes is that a reload of already-present data stops being
   * a teardown.
   */
  const revalidate = useCallback(
    <T,>(prev: Loadable<T>): Loadable<T> =>
      prev.kind === "ready" ? prev : { kind: "loading" },
    [],
  );

  const fetchAll = useCallback(async () => {
    if (!orgId) return;
    setOrg(revalidate);
    setMembers(revalidate);
    setWorkspaces(revalidate);
    setAudit(revalidate);
    setPendingInvites(revalidate);

    // Audit is read here for the summary tile + deep-link count only; the
    // filterable timeline + CSV export live on the canonical admin/audit tab.
    const [o, m, w, a, p] = await Promise.all([
      safeFetch<OrgResponse>(`/v1/orgs/${orgId}`),
      safeFetch<MembersResponse>(`/v1/orgs/${orgId}/members`),
      safeFetch<WorkspacesResponse>(`/v1/orgs/${orgId}/workspaces`),
      safeFetch<AuditResponse>(`/v1/orgs/${orgId}/audit-events`),
      safeFetch<PendingInvitesResponse>(`/v1/orgs/${orgId}/invites`),
    ]);
    setOrg(o);
    setMembers(m);
    setWorkspaces(w);
    setAudit(a);
    setPendingInvites(p);

    if (o.kind === "ready") {
      setSettingsName(o.data.name);
      setSettingsLegalName(o.data.legalName ?? "");
      setSettingsLegalEmail(o.data.legalEmail ?? "");
      setSettingsAddress(o.data.address ?? "");
      setSettingsTimezone(o.data.timezone ?? "");
      setSettingsLogoUrl(o.data.logoUrl ?? "");
    }
  }, [orgId, safeFetch, revalidate]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const callerRole: OrgRole | null = org.kind === "ready" ? org.data.callerRole : null;
  const canMutate = callerRole !== null && ROLE_RANK[callerRole] >= ROLE_RANK.ORG_ADMIN;

  // ---------------------------------------------------------------------------
  // Derived governance signals.
  // ---------------------------------------------------------------------------
  const roleTally = useMemo(() => {
    if (members.kind !== "ready") return null;
    const tally: Record<OrgRole, number> = {
      ORG_OWNER: 0,
      ORG_ADMIN: 0,
      ORG_SECURITY_ADMIN: 0,
      ORG_BILLING_ADMIN: 0,
      ORG_AUDITOR: 0,
      ORG_MEMBER: 0,
    };
    for (const m of members.data.members) {
      tally[m.role] = (tally[m.role] ?? 0) + 1;
    }
    return tally;
  }, [members]);

  const pendingCount = pendingInvites.kind === "ready"
    ? pendingInvites.data.summary.totalPending
    : null;

  const lastAuditAt = audit.kind === "ready" && audit.data.events.length > 0
    ? audit.data.events[0]!.createdAt
    : null;

  // ---------------------------------------------------------------------------
  // Mutations. (Member/invite mutation lives on admin/members now; only the
  // org-profile Settings PATCH remains on this page.)
  // ---------------------------------------------------------------------------
  const submitSettings = useCallback(async () => {
    const name = settingsName.trim();
    if (!name) {
      setSettingsError("Name is required.");
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const orNull = (s: string) => (s.trim() === "" ? null : s.trim());
      await apiFetch(`/v1/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          legalName: orNull(settingsLegalName),
          legalEmail: orNull(settingsLegalEmail),
          address: orNull(settingsAddress),
          timezone: orNull(settingsTimezone),
          logoUrl: orNull(settingsLogoUrl),
        }),
      });
      setSettingsSavedAt(new Date().toISOString());
      await fetchAll();
    } catch (err: unknown) {
      const message =
        toSafeUserError(err, { message: "Failed to save settings." }).message;
      setSettingsError(message);
    } finally {
      setSettingsBusy(false);
    }
  }, [
    orgId,
    settingsName,
    settingsLegalName,
    settingsLegalEmail,
    settingsAddress,
    settingsTimezone,
    settingsLogoUrl,
    fetchAll,
  ]);

  // ---------------------------------------------------------------------------
  // Leave organization (lifecycle Phase 1, 2026-07-16).
  //
  // Self-service departure for non-owners. The backend enforces the owner
  // guard (409 OWNERSHIP_TRANSFER_REQUIRED) and revokes workspace access in
  // the same transaction; on success we refresh the platform envelope (the
  // active workspace falls back to Personal) and return to the org list.
  // ---------------------------------------------------------------------------
  const router = useRouter();
  const { confirm } = useConfirmAction();
  const platformCtx = usePlatformContext();
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const leaveOrganization = useCallback(async () => {
    if (org.kind !== "ready" || leaveBusy) return;
    const ok = await confirm({
      title: `Leave ${org.data.name}?`,
      description:
        "You will immediately lose access to this organization and its workspaces. Your past activity remains attributed to you in the organization's audit records. An owner or admin must re-invite you to return.",
      confirmLabel: "Leave organization",
      tone: "danger",
      testId: "org-leave-confirm",
    });
    if (!ok) return;
    setLeaveBusy(true);
    setLeaveError(null);
    try {
      await apiFetch(`/v1/orgs/${orgId}/leave`, { method: "POST" });
      try {
        await platformCtx.refresh();
      } catch {
        /* envelope refresh is best-effort; navigation reloads it */
      }
      router.replace("/organizations");
    } catch (err) {
      const e = err as { body?: { error?: { code?: string; message?: string } } };
      if (e.body?.error?.code === "OWNERSHIP_TRANSFER_REQUIRED") {
        setLeaveError(
          e.body.error.message ??
            "You are the organization owner. Transfer ownership or close the organization before leaving.",
        );
      } else {
        setLeaveError(
          toSafeUserError(err, {
            message: "Could not leave the organization. Please try again.",
          }).message,
        );
      }
    } finally {
      setLeaveBusy(false);
    }
  }, [org, orgId, leaveBusy, confirm, platformCtx, router]);

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------
  const contextStrip =
    org.kind === "ready" ? (
      <>
        <Badge tone={roleBadgeTone(org.data.callerRole)} subtle>
          Your role · {ROLE_LABELS[org.data.callerRole]}
        </Badge>
        <span data-pill="status">
          <Badge tone="verified" subtle>
            {org.data.status}
          </Badge>
        </span>
        <span style={{ fontSize: 12.5, color: "var(--ink-muted, #94a3b8)" }}>
          {org.data.summary.memberCount} member
          {org.data.summary.memberCount === 1 ? "" : "s"} ·{" "}
          {org.data.summary.workspaceCount} workspace
          {org.data.summary.workspaceCount === 1 ? "" : "s"}
        </span>
        {(org.data.legalName || org.data.legalEmail) && (
          <span style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
            {org.data.legalName ? `Legal: ${org.data.legalName}` : null}
            {org.data.legalName && org.data.legalEmail ? " · " : ""}
            {org.data.legalEmail ?? null}
          </span>
        )}
      </>
    ) : undefined;

  return (
    <PageShell
      data-phase-a-1b-organization-detail
      data-org-id={orgId}
      data-caller-role={callerRole ?? ""}
      header={
        <PageHeader
          eyebrow="Organization · Governance"
          title={org.kind === "ready" ? org.data.name : "Organization"}
          subtitle="Governance and identity tenant — members, roles, invites, audit timeline, and legal metadata. Workspace evidence access is managed separately."
          contextStrip={contextStrip}
          secondaryActions={
            <>
              <Link
                href="/organizations"
                data-action="breadcrumb-organizations"
                style={linkReset}
              >
                <Button variant="ghost" size="sm">
                  ← All organizations
                </Button>
              </Link>
              {org.kind === "ready" && (
                <Link
                  href="/teams"
                  data-action="cross-link-workspace-admin"
                  style={linkReset}
                >
                  <Button variant="secondary" size="sm">
                    Workspace admin →
                  </Button>
                </Link>
              )}
              {/* Leave — hidden for ORG_OWNER (must transfer or close first;
                  the backend enforces the same guard regardless). */}
              {org.kind === "ready" &&
                org.data.callerRole !== "ORG_OWNER" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void leaveOrganization()}
                    loading={leaveBusy}
                    disabled={leaveBusy}
                    data-action="leave-organization"
                  >
                    Leave organization
                  </Button>
                )}
            </>
          }
          primaryAction={
            org.kind === "ready" ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(org.data.callerRole === "ORG_OWNER" ||
                  org.data.callerRole === "ORG_ADMIN") && (
                  <Link
                    href={`/organizations/${org.data.organizationId}/setup`}
                    data-action="open-organization-setup"
                    data-org-id={org.data.organizationId}
                    style={linkReset}
                  >
                    <Button variant="enterprise" size="sm">
                      Enterprise setup →
                    </Button>
                  </Link>
                )}
                <Link
                  href={`/organizations/${org.data.organizationId}/admin`}
                  data-action="open-organization-admin"
                  data-org-id={org.data.organizationId}
                  style={linkReset}
                >
                  <Button variant="primary" size="sm">
                    Open Admin →
                  </Button>
                </Link>
              </div>
            ) : undefined
          }
        />
      }
    >
      {/* ============================== HEADER STATES ====================== */}
      {leaveError ? (
        <div
          role="alert"
          data-section="leave-organization-error"
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(179,38,30,0.35)",
            background: "rgba(179,38,30,0.06)",
            color: "#8f1d16",
            fontSize: 13,
          }}
        >
          {leaveError}
        </div>
      ) : null}

      {org.kind === "loading" && (
        <SectionLoading dataSection="org-meta" />
      )}

      {org.kind === "error" && (
        <SectionError
          dataSection="org-meta"
          status={org.status}
          message={org.message}
          forbiddenMessage="You don’t have access to this organization."
        />
      )}

      {org.kind === "ready" && (
        <span data-section="org-meta" data-state="ready" hidden />
      )}

      {/* ====================== ONBOARDING NEXT STEPS ====================== */}
      {org.kind === "ready" &&
        org.data.callerRole === "ORG_OWNER" &&
        org.data.summary.memberCount === 1 && (
          <Card
            variant="status"
            tone="governance"
            data-section="org-onboarding-next-steps"
            title="You just created this organization — next steps"
            subtitle="Three governance steps that turn a single-owner org into a real collaborative tenant. Each one is wired to a real audited endpoint."
          >
            <ol
              data-onboarding-steps
              style={{
                margin: 0,
                paddingLeft: "1.2rem",
                fontSize: 13.5,
                display: "grid",
                gap: 8,
              }}
            >
              <li data-onboarding-step="invite-first-member">
                <strong>Invite the first member.</strong> Open{" "}
                <Link
                  href={`/organizations/${orgId}/admin/members`}
                  data-action="onboarding-open-admin-members"
                >
                  Members in the Admin console
                </Link>
                , pick a role, and share the invite token URL. Audited as{" "}
                <code>ORG_INVITE_CREATED</code>.
              </li>
              <li data-onboarding-step="set-legal-metadata">
                <strong>Set legal metadata.</strong> Fill name, legal name,
                and legal email in the <strong>Settings</strong> panel below
                so audit timeline events and exports carry your org’s
                identity. Audited as <code>ORG_UPDATED</code>.
              </li>
              <li data-onboarding-step="bind-workspace">
                <strong>Bind a workspace.</strong> Workspaces are where
                evidence and cases live. Create one in{" "}
                <Link
                  href="/teams"
                  data-action="onboarding-open-workspace-admin"
                >
                  Workspace administration
                </Link>
                ; the binding shows up in this org’s Workspaces panel below.
              </li>
            </ol>
          </Card>
        )}

      {/* ============================ OVERVIEW =============================== */}
      <section
        data-section="org-overview"
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        <OverviewTile
          dataAttr="tile-governance"
          title="Governance"
          primary={
            org.kind === "ready"
              ? `${org.data.summary.memberCount} member${org.data.summary.memberCount === 1 ? "" : "s"}`
              : "—"
          }
          secondary={
            pendingCount === null
              ? "Loading pending invites…"
              : `${pendingCount} pending invite${pendingCount === 1 ? "" : "s"}`
          }
          footer={
            roleTally
              ? roleTallyShort(roleTally)
              : "Role distribution loading…"
          }
        />
        <OverviewTile
          dataAttr="tile-workspaces"
          title="Workspaces"
          primary={
            org.kind === "ready"
              ? `${org.data.summary.workspaceCount}`
              : "—"
          }
          secondary={
            workspaces.kind === "ready" && workspaces.data.summary.totalWorkspaces > 0
              ? workspaces.data.workspaces
                  .slice(0, 3)
                  .map((w) => w.name)
                  .join(", ")
              : "No workspaces bound to this organization yet."
          }
          footer={
            <Link
              href="/teams"
              data-action="overview-open-workspace-admin"
              style={tileLink}
            >
              Open in Workspace administration →
            </Link>
          }
        />
        <OverviewTile
          dataAttr="tile-billing"
          title="Billing"
          primary={
            workspaces.kind === "ready" &&
            workspaces.data.callerCanSeeBilling &&
            workspaces.data.workspaces.length > 0
              ? billingTileSummary(workspaces.data.workspaces)
              : "Workspace-scoped"
          }
          secondary={
            workspaces.kind === "ready" && workspaces.data.callerCanSeeBilling
              ? "Per-workspace plan + seat usage shown below. Org-level billing unification is on the Phase 2.7X roadmap; for now the workspace is the billing unit."
              : "Org-level billing unification is on the Phase 2.7X roadmap. Today, plan / seats / addons are managed per workspace. Visibility requires ORG_ADMIN+ or ORG_BILLING_ADMIN."
          }
          footer={
            <Link
              href="/billing"
              data-action="overview-open-billing"
              style={tileLink}
            >
              Open billing →
            </Link>
          }
        />
        <OverviewTile
          dataAttr="tile-audit"
          title="Audit"
          primary={
            audit.kind === "ready"
              ? `${audit.data.summary.totalEvents} event${audit.data.summary.totalEvents === 1 ? "" : "s"}`
              : audit.kind === "error" && audit.status === 403
                ? "Auditor-only"
                : "—"
          }
          secondary={
            lastAuditAt
              ? `Latest ${formatUtcAuditDateTime(lastAuditAt)}`
              : audit.kind === "ready"
                ? "No events recorded yet."
                : audit.kind === "error" && audit.status === 403
                  ? "Requires ORG_AUDITOR or higher."
                  : "Loading…"
          }
        />
      </section>

      {/* ============================ SETTINGS =============================== */}
      <Card
        variant="admin"
        data-section="org-settings"
        title="Settings"
        subtitle="Identity metadata. ORG_ADMIN+ required."
      >
        {!canMutate && (
          <div data-state="forbidden" style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
            You don’t have permission to change settings. Ask an
            organization admin.
          </div>
        )}
        {canMutate && org.kind === "ready" && (
          <form
            data-form="org-settings"
            onSubmit={(e) => {
              e.preventDefault();
              void submitSettings();
            }}
            style={{ display: "grid", gap: 10, maxWidth: 540 }}
          >
            <label style={settingsLabel}>
              Name
              <input
                type="text"
                value={settingsName}
                onChange={(e) => setSettingsName(e.target.value)}
                required
                disabled={settingsBusy}
                maxLength={180}
                data-input="settings-name"
                style={modalInput}
              />
            </label>
            <label style={settingsLabel}>
              Legal name <small style={{ opacity: 0.7 }}>(optional)</small>
              <input
                type="text"
                value={settingsLegalName}
                onChange={(e) => setSettingsLegalName(e.target.value)}
                disabled={settingsBusy}
                maxLength={180}
                data-input="settings-legal-name"
                style={modalInput}
              />
            </label>
            <label style={settingsLabel}>
              Legal email <small style={{ opacity: 0.7 }}>(optional)</small>
              <input
                type="email"
                value={settingsLegalEmail}
                onChange={(e) => setSettingsLegalEmail(e.target.value)}
                disabled={settingsBusy}
                data-input="settings-legal-email"
                style={modalInput}
              />
            </label>
            <label style={settingsLabel}>
              Mailing address <small style={{ opacity: 0.7 }}>(optional)</small>
              <input
                type="text"
                value={settingsAddress}
                onChange={(e) => setSettingsAddress(e.target.value)}
                disabled={settingsBusy}
                data-input="settings-address"
                style={modalInput}
              />
            </label>
            <label style={settingsLabel}>
              Timezone{" "}
              <small style={{ opacity: 0.7 }}>
                (IANA, e.g. America/Los_Angeles)
              </small>
              <input
                type="text"
                value={settingsTimezone}
                onChange={(e) => setSettingsTimezone(e.target.value)}
                disabled={settingsBusy}
                maxLength={64}
                data-input="settings-timezone"
                style={modalInput}
                spellCheck={false}
              />
            </label>
            <label style={settingsLabel}>
              Logo URL <small style={{ opacity: 0.7 }}>(optional)</small>
              <input
                type="url"
                value={settingsLogoUrl}
                onChange={(e) => setSettingsLogoUrl(e.target.value)}
                disabled={settingsBusy}
                placeholder="https://"
                data-input="settings-logo-url"
                style={modalInput}
                spellCheck={false}
              />
            </label>
            {settingsError && (
              <div role="alert" data-state="error" style={modalErrorBox}>
                {settingsError}
              </div>
            )}
            {settingsSavedAt && !settingsError && (
              <div
                data-state="saved"
                style={{
                  padding: "0.5rem 0.65rem",
                  border: "1px solid var(--status-verified-border, #a7f3d0)",
                  borderRadius: 10,
                  fontSize: 12,
                  color: "var(--status-verified-fg, #065f46)",
                  background: "var(--status-verified-bg, #ecfdf5)",
                }}
              >
                Saved at {formatUserTime(settingsSavedAt)}.
              </div>
            )}
            <div>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={settingsBusy}
                disabled={settingsBusy || !settingsName.trim()}
                data-action="submit-settings"
              >
                {settingsBusy ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </form>
        )}
      </Card>

      {/* ===================== MEMBERS (canonical deep-link) ================= */}
      {/*
        Phase 4 (Enterprise Administration) dedup — the member roster,
        role-change, remove, invite, and pending-invite management surfaces
        that used to be embedded here now live ONLY on the canonical
        /organizations/:id/admin/members tab (the admin shell). This page
        keeps the org profile, overview, workspaces, and enterprise setup;
        member mutation is a single canonical surface, not two. The
        overview "Governance" tile above still surfaces the member + pending
        counts, so the at-a-glance signal is preserved; the deep-link below
        is the one place to act on them.
      */}
      <Card
        variant="summary"
        data-section="org-members-deeplink"
        header={
          <SectionHeader
            title="Members & invites"
            subtitle="Managing members, roles, and pending invites moved to the Admin console — one canonical surface for member governance."
            right={
              <Link
                href={`/organizations/${orgId}/admin/members`}
                data-action="open-admin-members"
                style={linkReset}
              >
                <Button variant="primary" size="sm">
                  Manage members →
                </Button>
              </Link>
            }
          />
        }
      >
        <div style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
          {org.kind === "ready" ? (
            <>
              {org.data.summary.memberCount} member
              {org.data.summary.memberCount === 1 ? "" : "s"}
              {pendingCount !== null ? (
                <>
                  {" · "}
                  {pendingCount} pending invite
                  {pendingCount === 1 ? "" : "s"}
                </>
              ) : null}
              {roleTally ? <> · {roleTallyShort(roleTally)}</> : null}
            </>
          ) : (
            "Loading member summary…"
          )}
        </div>
      </Card>

      {/* ============================ WORKSPACES ============================= */}
      <Card
        variant="summary"
        data-section="org-workspaces"
        header={
          <SectionHeader
            title="Workspaces"
            subtitle="Operational evidence, cases, and reviewer queues live inside each workspace. Org-level membership does not grant workspace access — that is workspace-scoped."
            right={
              <Link
                href="/teams"
                data-action="workspaces-open-admin"
                style={linkReset}
              >
                <Button variant="secondary" size="sm">
                  Workspace admin →
                </Button>
              </Link>
            }
          />
        }
      >
        {workspaces.kind === "loading" && <RowLoading />}
        {workspaces.kind === "error" && (
          <RowError
            status={workspaces.status}
            forbiddenMessage="You don’t have access to the workspace list."
          />
        )}
        {workspaces.kind === "ready" && (
          <ul
            data-state="ready"
            data-total-workspaces={workspaces.data.summary.totalWorkspaces}
            style={listResetStyle}
          >
            {workspaces.data.workspaces.length === 0 && (
              <li style={{ listStyle: "none" }}>
                <EmptyState
                  compact
                  title="No workspaces bound to this organization."
                  purpose="Workspaces hold this organization’s evidence, cases, and reviewer queues. Bind one in Workspace administration to start capturing."
                  action={
                    <Link
                      href="/teams"
                      data-action="workspaces-empty-open-admin"
                      style={linkReset}
                    >
                      <Button variant="secondary" size="sm">
                        Open Workspace administration →
                      </Button>
                    </Link>
                  }
                />
              </li>
            )}
            {workspaces.data.workspaces.map((w) => (
              <li
                key={w.workspaceId}
                data-workspace-id={w.workspaceId}
                data-workspace-plan={w.billing?.plan ?? ""}
                data-workspace-billing-status={w.billing?.status ?? ""}
                data-workspace-over-seat={
                  w.billing?.overSeatLimit ? "true" : "false"
                }
                style={memberRowStyle}
              >
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{w.name}</span>
                    {w.isPersonal ? (
                      <Badge tone="neutral" subtle>
                        personal
                      </Badge>
                    ) : null}
                    {w.billing && (
                      <>
                        <span data-pill="workspace-plan">
                          <Badge tone="governance" subtle>
                            {w.billing.plan}
                          </Badge>
                        </span>
                        <span data-pill="workspace-billing-status">
                          <Badge
                            tone={
                              w.billing.status === "ACTIVE"
                                ? "verified"
                                : "pending"
                            }
                            subtle
                          >
                            {w.billing.status}
                          </Badge>
                        </span>
                        {w.billing.overSeatLimit && (
                          <span data-pill="workspace-over-seat">
                            <Badge tone="risk">OVER SEAT LIMIT</Badge>
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
                    Created {formatUserDate(w.createdAt)}
                    {w.billing
                      ? ` · ${w.billing.includedSeats} included seat${w.billing.includedSeats === 1 ? "" : "s"}`
                      : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <Link
                    href={`/teams/${w.workspaceId}`}
                    data-action="open-workspace"
                    data-workspace-id={w.workspaceId}
                    style={linkReset}
                  >
                    <Button variant="secondary" size="sm">
                      Open workspace
                    </Button>
                  </Link>
                  {/* Phase 4 §7.5 — reversible org-workspace suspension. */}
                  <OrgWorkspaceLifecycleControls
                    orgId={orgId}
                    workspaceId={w.workspaceId}
                    workspaceName={w.name}
                    isPersonal={w.isPersonal}
                    canManage={canMutate}
                    onChanged={fetchAll}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ===================== AUDIT (canonical deep-link) ================== */}
      {/*
        Phase 4 (Enterprise Administration) dedup — the filterable audit
        timeline (event-type / actor / date filters + CSV export) now lives
        ONLY on the canonical /organizations/:id/admin/audit tab. The
        overview "Audit" tile above still surfaces the event count + latest
        timestamp; the deep-link below is the one place to browse + export.
      */}
      <Card
        variant="summary"
        data-section="org-audit-deeplink"
        header={
          <SectionHeader
            title="Audit timeline"
            subtitle="Organization governance events moved to the Admin console, with event-type / actor / date filters and CSV export. Requires ORG_AUDITOR or higher."
            right={
              <Link
                href={`/organizations/${orgId}/admin/audit`}
                data-action="open-admin-audit"
                style={linkReset}
              >
                <Button variant="primary" size="sm">
                  Open audit timeline →
                </Button>
              </Link>
            }
          />
        }
      >
        <div style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
          {audit.kind === "ready" ? (
            <>
              {audit.data.summary.totalEvents} event
              {audit.data.summary.totalEvents === 1 ? "" : "s"}
              {lastAuditAt
                ? ` · latest ${formatUtcAuditDateTime(lastAuditAt)}`
                : ""}
            </>
          ) : audit.kind === "error" && audit.status === 403 ? (
            "Requires ORG_AUDITOR or higher."
          ) : (
            "Loading audit summary…"
          )}
        </div>
      </Card>

      {/* ========================= SCOPE / HIERARCHY ========================== */}
      <Card
        variant="admin"
        data-section="org-scope-hierarchy"
        title="Scope — what lives where"
        subtitle="The platform uses three tenancy scopes. Each one owns a specific category of operational data and a specific category of identity."
      >
        <div
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            fontSize: 13,
          }}
        >
          <div data-scope="personal" style={scopeCard}>
            <div style={scopeTitle}>Personal Space</div>
            <div style={{ color: "var(--ink-secondary, #475569)" }}>
              Private to you. Your own evidence, drafts, and integrations.
              Never shared. Lives outside any organization.
            </div>
          </div>
          <div data-scope="organization" style={scopeCard}>
            <div style={scopeTitle}>Organization (you are here)</div>
            <div style={{ color: "var(--ink-secondary, #475569)" }}>
              Governance + identity tenant. Members, roles, invites, audit
              timeline, legal metadata. Does NOT grant workspace data access
              on its own.
            </div>
          </div>
          <div data-scope="workspace" style={scopeCard}>
            <div style={scopeTitle}>Workspace (a.k.a. Team)</div>
            <div style={{ color: "var(--ink-secondary, #475569)" }}>
              Operational tenant. Evidence, cases, reviewer queues, retention
              policy, plan + seats. Each workspace is bound to exactly one
              organization. Workspace-level RBAC is independent of
              organization role.
            </div>
          </div>
        </div>
      </Card>

      {/* ============================ DANGER ZONE ============================ */}
      <Card
        variant="status"
        tone="risk"
        data-section="org-danger-zone"
        title="Organization lifecycle"
        subtitle="Owner-only, verified lifecycle actions. Non-owner members leave from the page header; owners must transfer ownership (or close the organization) first."
      >
        {callerRole === "ORG_OWNER" ? (
          <OrgLifecycleControls
            orgId={orgId}
            orgName={org.kind === "ready" ? org.data.name : ""}
            members={members.kind === "ready" ? members.data.members : []}
            onChanged={() => void fetchAll()}
          />
        ) : (
          <div
            data-control="lifecycle-owner-only-note"
            style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}
          >
            Ownership transfer and organization closure are available to the
            organization owner only. To leave this organization, use{" "}
            <strong>Leave organization</strong> in the page header.
          </div>
        )}
      </Card>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Organization lifecycle controls (lifecycle Phase 6, 2026-07-17).
//
// Owner-only: (1) atomic ownership transfer to an existing member,
// (2) organization closure — typed phrase validated server-side, step-up,
// preflight blockers with stable codes, 7-day cancellation window.
// Frontend visibility is NOT authorization: every action re-checks
// ORG_OWNER + step-up on the backend.
// ---------------------------------------------------------------------------

type OrgClosureBlocker = { code: string; message: string; count: number };

type OrgClosureRequestRow = {
  id: string;
  status: string;
  blockersJson: string | null;
  requestedAtUtc: string;
  coolingOffEndsAtUtc: string | null;
  failureCode: string | null;
};

type OrgClosureState = {
  request: OrgClosureRequestRow | null;
  blockers: OrgClosureBlocker[];
  confirmationPhrase: string;
  coolingOffDays: number;
};

const ORG_CLOSURE_STATUS_LABEL: Record<string, string> = {
  BLOCKED: "Blocked — action needed",
  COOLING_OFF: "Scheduled — cancellation window open",
  SCHEDULED: "Scheduled",
  PROCESSING: "Closing…",
  COMPLETED: "Closed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

function OrgLifecycleControls({
  orgId,
  orgName,
  members,
  onChanged,
}: {
  orgId: string;
  orgName: string;
  members: MembersResponse["members"];
  onChanged: () => void;
}) {
  const { confirm } = useConfirmAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- transfer ----
  const [targetUserId, setTargetUserId] = useState("");
  const eligibleTargets = members.filter((m) => m.role !== "ORG_OWNER");

  // ---- closure ----
  const [closure, setClosure] = useState<OrgClosureState | null>(null);
  const [phrase, setPhrase] = useState("");
  const [showClosureForm, setShowClosureForm] = useState(false);

  // ---- shared step-up prompt ----
  const [stepUpFor, setStepUpFor] = useState<null | "transfer" | "closure">(null);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");

  const reloadClosure = useCallback(async () => {
    try {
      const res = (await apiFetch(`/v1/orgs/${orgId}/closure`)) as OrgClosureState;
      setClosure(res);
    } catch {
      setClosure(null);
    }
  }, [orgId]);
  useEffect(() => {
    void reloadClosure();
  }, [reloadClosure]);

  const transferOwnership = useCallback(
    async (proof?: StepUpProof) => {
      if (!targetUserId) return;
      if (!proof) {
        const target = eligibleTargets.find((m) => m.userId === targetUserId);
        const ok = await confirm({
          title: `Transfer ownership of ${orgName}?`,
          description: `${
            target?.displayName ?? target?.email ?? "The selected member"
          } becomes the organization owner and you become an admin. Billing ownership follows the owner. This is atomic and audited.`,
          confirmLabel: "Transfer ownership",
          tone: "danger",
          testId: "org-transfer-confirm",
        });
        if (!ok) return;
      }
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await apiFetch(`/v1/orgs/${orgId}/transfer-ownership`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetUserId,
            ...(proof ? { stepUp: proof } : {}),
          }),
        });
        setStepUpFor(null);
        setNotice("Ownership transferred. You are now an organization admin.");
        onChanged();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpFor("transfer");
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        const e = err as { body?: { error?: { code?: string } } };
        const code = e.body?.error?.code;
        if (code === "target_not_member") {
          setError("The selected user is no longer a member of this organization.");
        } else if (code === "owner_required") {
          setError("Only the organization owner can transfer ownership.");
        } else {
          setError(
            toSafeUserError(err, { message: "Could not transfer ownership." }).message,
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [targetUserId, eligibleTargets, confirm, orgName, orgId, onChanged],
  );

  const requestClosure = useCallback(
    async (proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await apiFetch(`/v1/orgs/${orgId}/closure`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmation: phrase,
            ...(proof ? { stepUp: proof } : {}),
          }),
        });
        setStepUpFor(null);
        setShowClosureForm(false);
        setPhrase("");
        await reloadClosure();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpFor("closure");
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        const e = err as { body?: { error?: { code?: string; message?: string } } };
        const code = e.body?.error?.code;
        if (code === "closure_blocked") {
          setError("Closure is blocked — resolve the listed items and try again.");
          await reloadClosure();
        } else if (code === "confirmation_mismatch") {
          setError(e.body?.error?.message ?? "The confirmation phrase does not match.");
        } else if (code === "closure_request_active") {
          setError("A closure request for this organization is already open.");
          await reloadClosure();
        } else {
          setError(
            toSafeUserError(err, { message: "Could not request closure." }).message,
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [orgId, phrase, reloadClosure],
  );

  const cancelClosure = useCallback(
    async (requestId: string) => {
      setBusy(true);
      setError(null);
      try {
        await apiFetch(`/v1/orgs/${orgId}/closure/${requestId}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        await reloadClosure();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not cancel the request." }).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [orgId, reloadClosure],
  );

  const req = closure?.request ?? null;
  const openClosure =
    req !== null &&
    ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED", "PROCESSING"].includes(
      req.status,
    );
  const phraseExpected = closure?.confirmationPhrase ?? "close this organization";

  return (
    <div style={{ display: "grid", gap: 16, fontSize: 13 }}>
      {/* ------------------------- Transfer ownership ------------------------- */}
      <div data-control="transfer-ownership">
        <strong>Transfer ownership.</strong>{" "}
        <span style={{ color: "var(--ink-secondary, #475569)" }}>
          The new owner must already be a member. You become an admin; the
          organization is never left without an owner.
        </span>
        {eligibleTargets.length === 0 ? (
          <p style={{ margin: "6px 0 0", color: "var(--ink-secondary, #475569)" }}>
            No other members yet — invite a member before transferring
            ownership.
          </p>
        ) : (
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <select
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              aria-label="New owner"
              data-control="transfer-ownership-target"
              style={{
                fontSize: 13,
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid var(--border-default, rgba(15,23,42,0.15))",
                minWidth: 220,
              }}
            >
              <option value="">Select the new owner…</option>
              {eligibleTargets.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName ?? m.email ?? m.userId}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void transferOwnership()}
              loading={busy}
              disabled={busy || !targetUserId}
              data-action="transfer-ownership"
            >
              Transfer ownership
            </Button>
          </div>
        )}
      </div>

      {/* ------------------------- Close organization ------------------------- */}
      <div data-control="close-organization">
        <strong>Close organization.</strong>{" "}
        <span style={{ color: "var(--ink-secondary, #475569)" }}>
          Archives the organization after a {closure?.coolingOffDays ?? 7}-day
          cancellation window. Workspace access and machine credentials are
          revoked; evidence is never deleted by closure — it stays governed
          by retention and legal-hold rules.
        </span>

        {openClosure && req ? (
          <div className="mt-2" data-org-closure-status={req.status}>
            <p style={{ margin: "6px 0 0" }}>
              {ORG_CLOSURE_STATUS_LABEL[req.status] ?? req.status}
              {req.status === "COOLING_OFF" && req.coolingOffEndsAtUtc
                ? ` — closes after ${formatUserDate(req.coolingOffEndsAtUtc)} unless cancelled.`
                : ""}
            </p>
            {req.status === "BLOCKED" && req.blockersJson ? (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--ink-secondary, #475569)" }}>
                {(JSON.parse(req.blockersJson) as OrgClosureBlocker[]).map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            ) : null}
            {["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED"].includes(req.status) ? (
              <div style={{ marginTop: 8 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void cancelClosure(req.id)}
                  loading={busy}
                  disabled={busy}
                  data-action="cancel-organization-closure"
                >
                  Cancel closure request
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {(closure?.blockers.length ?? 0) > 0 ? (
              <ul
                data-org-closure-blockers
                style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--ink-secondary, #475569)" }}
              >
                {closure!.blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            ) : null}
            {!showClosureForm ? (
              <div style={{ marginTop: 8 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowClosureForm(true)}
                  disabled={busy}
                  data-action="open-organization-closure"
                >
                  Close this organization…
                </Button>
              </div>
            ) : (
              <div style={{ marginTop: 8 }} data-org-closure-form>
                <label
                  htmlFor="org-closure-confirm"
                  style={{ display: "block", marginBottom: 6, color: "var(--ink-secondary, #475569)" }}
                >
                  Type <strong>{phraseExpected}</strong> to confirm.
                </label>
                <input
                  id="org-closure-confirm"
                  type="text"
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  autoComplete="off"
                  style={{
                    fontSize: 13,
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--border-default, rgba(15,23,42,0.15))",
                    width: "100%",
                    maxWidth: 340,
                  }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void requestClosure()}
                    loading={busy}
                    disabled={
                      busy || phrase.trim().toLowerCase() !== phraseExpected
                    }
                    data-action="request-organization-closure"
                  >
                    Request closure
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowClosureForm(false);
                      setPhrase("");
                      setError(null);
                    }}
                    disabled={busy}
                  >
                    Keep the organization
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {stepUpFor ? (
        <StepUpVerify
          title={
            stepUpFor === "transfer"
              ? "Confirm transferring ownership of this organization."
              : "Confirm closing this organization."
          }
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) =>
            stepUpFor === "transfer"
              ? void transferOwnership(proof)
              : void requestClosure(proof)
          }
          onCancel={() => {
            setStepUpFor(null);
            setStepUpMsg("");
          }}
        />
      ) : null}

      {error ? (
        <div
          role="alert"
          style={{
            borderRadius: 8,
            border: "1px solid rgba(179,38,30,0.35)",
            background: "rgba(179,38,30,0.06)",
            color: "#8f1d16",
            padding: "8px 12px",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          style={{
            borderRadius: 8,
            border: "1px solid rgba(47,125,91,0.35)",
            background: "rgba(47,125,91,0.07)",
            color: "#215e44",
            padding: "8px 12px",
            fontSize: 12,
          }}
        >
          {notice}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentation helpers (inline; intentionally not extracted in A.1B).
// ---------------------------------------------------------------------------

function roleTallyShort(t: Record<OrgRole, number>): string {
  const parts: string[] = [];
  for (const r of ALL_ROLES) {
    if (t[r] > 0) parts.push(`${t[r]} ${ROLE_LABELS[r]}`);
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/**
 * Compact one-line plan summary for the overview Billing tile.
 * Tallies workspaces per plan and reports the dominant one (or
 * "Mixed plans" when more than one plan is in play).
 */
function billingTileSummary(
  workspaces: ReadonlyArray<{ billing?: WorkspaceBilling }>,
): string {
  const planCounts = new Map<string, number>();
  let overLimitCount = 0;
  for (const w of workspaces) {
    if (!w.billing) continue;
    planCounts.set(w.billing.plan, (planCounts.get(w.billing.plan) ?? 0) + 1);
    if (w.billing.overSeatLimit) overLimitCount += 1;
  }
  if (planCounts.size === 0) return "—";
  const overSuffix =
    overLimitCount > 0
      ? ` · ${overLimitCount} over seat limit`
      : "";
  if (planCounts.size === 1) {
    const [plan, count] = planCounts.entries().next().value as [string, number];
    return `${count}× ${plan}${overSuffix}`;
  }
  return `Mixed plans${overSuffix}`;
}

function OverviewTile({
  dataAttr,
  title,
  primary,
  secondary,
  footer,
}: {
  dataAttr: string;
  title: string;
  primary: React.ReactNode;
  secondary: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Card variant="summary" padding="compact" data-tile={dataAttr}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          minHeight: 108,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--ink-muted, #94a3b8)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 650,
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {primary}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-secondary, #475569)" }}>
          {secondary}
        </div>
        {footer && <div style={{ marginTop: "auto", paddingTop: 6 }}>{footer}</div>}
      </div>
    </Card>
  );
}

function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        marginBottom: "0.5rem",
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        {subtitle && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
            {subtitle}
          </div>
        )}
      </div>
      {right}
    </header>
  );
}

function SectionLoading({ dataSection }: { dataSection: string }) {
  return (
    <Card
      variant="summary"
      data-section={dataSection}
      data-state="loading"
      style={{ opacity: 0.75 }}
    >
      Loading…
    </Card>
  );
}

function SectionError({
  dataSection,
  status,
  message,
  forbiddenMessage,
}: {
  dataSection: string;
  status: number;
  message: string;
  forbiddenMessage: string;
}) {
  return (
    <Card
      variant="status"
      tone="risk"
      data-section={dataSection}
      data-state="error"
      role="alert"
    >
      <strong>Couldn’t load.</strong>
      <div style={{ fontSize: 13, marginTop: 4 }}>
        {status === 403
          ? forbiddenMessage
          : `${status ? `HTTP ${status}: ` : ""}${message}`}
      </div>
    </Card>
  );
}

function RowLoading() {
  return (
    <div data-state="loading" style={{ opacity: 0.7, fontSize: 13 }}>
      Loading…
    </div>
  );
}

function RowError({
  status,
  forbiddenMessage,
}: {
  status: number;
  forbiddenMessage: string;
}) {
  return (
    <div data-state="error" style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
      {status === 403 ? forbiddenMessage : "Couldn’t load."}
    </div>
  );
}

// Map an org role to a semantic Badge tone for the header context strip.
function roleBadgeTone(role: OrgRole): BadgeTone {
  switch (role) {
    case "ORG_OWNER":
    case "ORG_ADMIN":
      return "governance";
    case "ORG_SECURITY_ADMIN":
      return "risk";
    case "ORG_BILLING_ADMIN":
      return "pending";
    case "ORG_AUDITOR":
      return "verified";
    case "ORG_MEMBER":
    default:
      return "neutral";
  }
}

// ---- shared styles ----

const listResetStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const memberRowStyle: React.CSSProperties = {
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const settingsLabel: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

const modalInput: React.CSSProperties = {
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

const modalErrorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "0.5rem 0.65rem",
  border: "1px solid var(--status-risk-border, #fecaca)",
  borderRadius: 10,
  fontSize: 13,
  color: "var(--status-risk-fg, #991b1b)",
  background: "var(--status-risk-bg, #fef2f2)",
};

const linkReset: React.CSSProperties = {
  textDecoration: "none",
  flexShrink: 0,
};

const tileLink: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--enterprise-accent, #7C3AED)",
  textDecoration: "none",
};

const scopeCard: React.CSSProperties = {
  padding: "0.75rem 0.85rem",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-card, 14px)",
  background: "var(--surface-card, #ffffff)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const scopeTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--ink-primary, #0f172a)",
};
