"use client";

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
 *   7. Audit    → GET  /v1/orgs/:id/audit-events?cursor=&take=&type=
 *                 (auditor+)
 *
 * Operational rules:
 *
 *   - All CTAs are wired. Where a backend endpoint does NOT yet exist
 *     (e.g. Leave Organization, Transfer Ownership), the surface
 *     surfaces an honest explanation rather than a fake button.
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
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

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

const ROLE_TONE: Record<OrgRole, string> = {
  ORG_OWNER: "rgba(99, 102, 241, 0.22)",
  ORG_ADMIN: "rgba(99, 102, 241, 0.16)",
  ORG_SECURITY_ADMIN: "rgba(239, 68, 68, 0.16)",
  ORG_BILLING_ADMIN: "rgba(245, 158, 11, 0.16)",
  ORG_AUDITOR: "rgba(34, 197, 94, 0.14)",
  ORG_MEMBER: "rgba(148, 163, 184, 0.18)",
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

  // ---- per-row busy / errors ----
  const [memberBusy, setMemberBusy] = useState<Record<string, boolean>>({});
  const [memberError, setMemberError] = useState<Record<string, string>>({});
  const [inviteBusyMap, setInviteBusyMap] = useState<Record<string, boolean>>({});
  const [inviteRowError, setInviteRowError] = useState<Record<string, string>>({});

  // ---- invite modal ----
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("ORG_MEMBER");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [lastInviteToken, setLastInviteToken] = useState<string | null>(null);

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

  // ---- audit filter ----
  const [auditTypeFilter, setAuditTypeFilter] = useState<string>("");

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
        const message = err instanceof Error ? err.message : "Failed to load.";
        const status =
          typeof (err as { statusCode?: number }).statusCode === "number"
            ? ((err as { statusCode: number }).statusCode)
            : 0;
        return { kind: "error", message, status };
      }
    },
    [],
  );

  const fetchAll = useCallback(async () => {
    if (!orgId) return;
    setOrg({ kind: "loading" });
    setMembers({ kind: "loading" });
    setWorkspaces({ kind: "loading" });
    setAudit({ kind: "loading" });
    setPendingInvites({ kind: "loading" });

    const auditPath = auditTypeFilter
      ? `/v1/orgs/${orgId}/audit-events?eventType=${encodeURIComponent(auditTypeFilter)}`
      : `/v1/orgs/${orgId}/audit-events`;

    const [o, m, w, a, p] = await Promise.all([
      safeFetch<OrgResponse>(`/v1/orgs/${orgId}`),
      safeFetch<MembersResponse>(`/v1/orgs/${orgId}/members`),
      safeFetch<WorkspacesResponse>(`/v1/orgs/${orgId}/workspaces`),
      safeFetch<AuditResponse>(auditPath),
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
  }, [orgId, safeFetch, auditTypeFilter]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const callerRole: OrgRole | null = org.kind === "ready" ? org.data.callerRole : null;
  const canMutate = callerRole !== null && ROLE_RANK[callerRole] >= ROLE_RANK.ORG_ADMIN;
  const canAudit = callerRole !== null && ROLE_RANK[callerRole] >= ROLE_RANK.ORG_AUDITOR;

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
  // Mutations.
  // ---------------------------------------------------------------------------
  const submitInvite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) {
      setInviteError("Email is required.");
      return;
    }
    setInviteBusy(true);
    setInviteError(null);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const data = (await apiFetch(`/v1/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      })) as { token: string };
      setLastInviteToken(data.token);
      setInviteEmail("");
      await fetchAll();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to send invite.";
      setInviteError(message);
    } finally {
      setInviteBusy(false);
    }
  }, [inviteEmail, inviteRole, orgId, fetchAll]);

  const changeRole = useCallback(
    async (membershipId: string, newRole: OrgRole) => {
      setMemberBusy((s) => ({ ...s, [membershipId]: true }));
      setMemberError((s) => ({ ...s, [membershipId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/members/${membershipId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: newRole }),
        });
        await fetchAll();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to change role.";
        setMemberError((s) => ({ ...s, [membershipId]: message }));
      } finally {
        setMemberBusy((s) => ({ ...s, [membershipId]: false }));
      }
    },
    [orgId, fetchAll],
  );

  const removeMember = useCallback(
    async (membershipId: string) => {
      setMemberBusy((s) => ({ ...s, [membershipId]: true }));
      setMemberError((s) => ({ ...s, [membershipId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/members/${membershipId}`, {
          method: "DELETE",
        });
        await fetchAll();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to remove member.";
        setMemberError((s) => ({ ...s, [membershipId]: message }));
      } finally {
        setMemberBusy((s) => ({ ...s, [membershipId]: false }));
      }
    },
    [orgId, fetchAll],
  );

  const revokeInvite = useCallback(
    async (inviteId: string) => {
      setInviteBusyMap((s) => ({ ...s, [inviteId]: true }));
      setInviteRowError((s) => ({ ...s, [inviteId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/invites/${inviteId}`, {
          method: "DELETE",
        });
        await fetchAll();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to revoke invite.";
        setInviteRowError((s) => ({ ...s, [inviteId]: message }));
      } finally {
        setInviteBusyMap((s) => ({ ...s, [inviteId]: false }));
      }
    },
    [orgId, fetchAll],
  );

  const resendInvite = useCallback(
    async (inviteId: string) => {
      setInviteBusyMap((s) => ({ ...s, [inviteId]: true }));
      setInviteRowError((s) => ({ ...s, [inviteId]: "" }));
      try {
        await apiFetch(`/v1/orgs/${orgId}/invites/${inviteId}/resend`, {
          method: "POST",
        });
        await fetchAll();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to resend invite.";
        setInviteRowError((s) => ({ ...s, [inviteId]: message }));
      } finally {
        setInviteBusyMap((s) => ({ ...s, [inviteId]: false }));
      }
    },
    [orgId, fetchAll],
  );

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
        err instanceof Error ? err.message : "Failed to save settings.";
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
  // Render.
  // ---------------------------------------------------------------------------
  return (
    <main
      style={{ padding: "1.5rem", maxWidth: 1000, margin: "0 auto" }}
      data-phase-a-1b-organization-detail
      data-org-id={orgId}
      data-caller-role={callerRole ?? ""}
    >
      {/* Breadcrumb */}
      <div style={{ marginBottom: "0.75rem", fontSize: 13 }}>
        <Link href="/organizations" data-action="breadcrumb-organizations">
          ← All organizations
        </Link>
      </div>

      {/* ============================== HEADER ============================== */}
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
        <header
          data-section="org-meta"
          data-state="ready"
          style={{
            padding: "1rem 1.1rem",
            border: "1px solid rgba(127,127,127,0.3)",
            borderRadius: 8,
            marginBottom: "1rem",
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0, flex: "1 1 auto" }}>
            <div
              style={{
                fontSize: 11,
                opacity: 0.7,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              Organization · Governance
            </div>
            <h1 style={{ margin: "0.25rem 0 0.35rem", fontSize: 22 }}>
              {org.data.name}
            </h1>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                fontSize: 12.5,
              }}
            >
              <Pill tone={ROLE_TONE[org.data.callerRole]}>
                Your role · {ROLE_LABELS[org.data.callerRole]}
              </Pill>
              <Pill tone="rgba(34, 197, 94, 0.18)" data-pill="status">
                {org.data.status}
              </Pill>
              <span style={{ opacity: 0.75 }}>
                {org.data.summary.memberCount} member
                {org.data.summary.memberCount === 1 ? "" : "s"} ·{" "}
                {org.data.summary.workspaceCount} workspace
                {org.data.summary.workspaceCount === 1 ? "" : "s"}
              </span>
            </div>
            {(org.data.legalName || org.data.legalEmail) && (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
                {org.data.legalName ? `Legal: ${org.data.legalName}` : null}
                {org.data.legalName && org.data.legalEmail ? " · " : ""}
                {org.data.legalEmail ?? null}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Link
              href={`/teams?org=${org.data.organizationId}`}
              data-action="cross-link-workspace-admin"
              style={cardLinkBtn(false)}
            >
              Workspace admin →
            </Link>
            {canMutate && (
              <button
                type="button"
                data-action="open-invite"
                onClick={() => {
                  setInviteError(null);
                  setLastInviteToken(null);
                  setInviteOpen(true);
                }}
                style={cardLinkBtn(true)}
              >
                + Invite member
              </button>
            )}
          </div>
        </header>
      )}

      {/* ====================== ONBOARDING NEXT STEPS ====================== */}
      {org.kind === "ready" &&
        org.data.callerRole === "ORG_OWNER" &&
        org.data.summary.memberCount === 1 && (
          <section
            data-section="org-onboarding-next-steps"
            style={{
              ...sectionStyle,
              borderColor: "rgba(99,102,241,0.45)",
              background: "rgba(99,102,241,0.05)",
              marginBottom: "1rem",
            }}
          >
            <SectionHeader
              title="You just created this organization — next steps"
              subtitle="Three governance steps that turn a single-owner org into a real collaborative tenant. Each one is wired to a real audited endpoint."
            />
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
                <strong>Invite the first member.</strong> Use the “+ Invite
                member” button in the header. Pick a role; share the invite
                token URL. Audited as <code>ORG_INVITE_CREATED</code>.
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
                  href={`/teams?org=${orgId}`}
                  data-action="onboarding-open-workspace-admin"
                >
                  Workspace administration
                </Link>
                ; the binding shows up in this org’s Workspaces panel below.
              </li>
            </ol>
          </section>
        )}

      {/* ============================ OVERVIEW =============================== */}
      <section
        data-section="org-overview"
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          marginBottom: "1.25rem",
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
              href={`/teams?org=${orgId}`}
              data-action="overview-open-workspace-admin"
              style={{ fontSize: 12 }}
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
              style={{ fontSize: 12 }}
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
              ? `Latest ${new Date(lastAuditAt).toLocaleString()}`
              : audit.kind === "ready"
                ? "No events recorded yet."
                : audit.kind === "error" && audit.status === 403
                  ? "Requires ORG_AUDITOR or higher."
                  : "Loading…"
          }
        />
      </section>

      {/* ============================ SETTINGS =============================== */}
      <section
        data-section="org-settings"
        style={sectionStyle}
      >
        <SectionHeader title="Settings" subtitle="Identity metadata. ORG_ADMIN+ required." />
        {!canMutate && (
          <div data-state="forbidden" style={{ fontSize: 13, opacity: 0.8 }}>
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
                  padding: "0.4rem 0.6rem",
                  border: "1px solid #4a4",
                  borderRadius: 4,
                  fontSize: 12,
                  background: "rgba(76,170,76,0.06)",
                }}
              >
                Saved at {new Date(settingsSavedAt).toLocaleTimeString()}.
              </div>
            )}
            <div>
              <button
                type="submit"
                disabled={settingsBusy || !settingsName.trim()}
                data-action="submit-settings"
                style={toolbarBtn(true)}
              >
                {settingsBusy ? "Saving…" : "Save settings"}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* ============================ MEMBERS ================================ */}
      <section data-section="org-members" style={sectionStyle}>
        <SectionHeader
          title="Members"
          subtitle="Org-level governance roles. Workspace-level access remains workspace-scoped."
          right={
            canMutate ? (
              <button
                type="button"
                data-action="header-open-invite"
                onClick={() => {
                  setInviteError(null);
                  setLastInviteToken(null);
                  setInviteOpen(true);
                }}
                style={toolbarBtn(false)}
              >
                + Invite member
              </button>
            ) : null
          }
        />
        {members.kind === "loading" && <RowLoading />}
        {members.kind === "error" && (
          <RowError
            status={members.status}
            forbiddenMessage="You don’t have access to the member list."
          />
        )}
        {members.kind === "ready" && (
          <ul
            data-state="ready"
            data-total-members={members.data.summary.totalMembers}
            style={listResetStyle}
          >
            {members.data.members.length === 0 && (
              <li style={emptyRowStyle}>No members.</li>
            )}
            {members.data.members.map((m) => {
              const busy = !!memberBusy[m.membershipId];
              const err = memberError[m.membershipId];
              return (
                <li
                  key={m.membershipId}
                  data-membership-id={m.membershipId}
                  data-member-role={m.role}
                  style={memberRowStyle}
                >
                  <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <div style={{ fontWeight: 500 }}>
                      {m.displayName || m.email || "(unnamed user)"}
                    </div>
                    {m.email && (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{m.email}</div>
                    )}
                    {err && (
                      <div role="alert" data-state="error" style={inlineErrorStyle}>
                        {err}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {canMutate ? (
                      <select
                        data-action="change-role"
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          void changeRole(m.membershipId, e.target.value as OrgRole)
                        }
                        style={{ fontSize: 12 }}
                      >
                        {ALL_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Pill tone={ROLE_TONE[m.role]} data-role-label>
                        {ROLE_LABELS[m.role]}
                      </Pill>
                    )}
                    <span style={{ fontSize: 12, opacity: 0.7 }}>
                      since {new Date(m.memberSince).toLocaleDateString()}
                    </span>
                    {canMutate && (
                      <button
                        type="button"
                        data-action="remove-member"
                        disabled={busy}
                        onClick={() => void removeMember(m.membershipId)}
                        style={dangerBtn}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ========================= PENDING INVITES =========================== */}
      <section data-section="org-pending-invites" style={sectionStyle}>
        <SectionHeader
          title="Pending invites"
          subtitle="Invites sent but not yet accepted, revoked, or expired."
        />
        {pendingInvites.kind === "loading" && <RowLoading />}
        {pendingInvites.kind === "error" && (
          <RowError
            status={pendingInvites.status}
            forbiddenMessage="Pending-invite visibility requires admin access."
          />
        )}
        {pendingInvites.kind === "ready" && (
          <ul
            data-state="ready"
            data-total-pending={pendingInvites.data.summary.totalPending}
            style={listResetStyle}
          >
            {pendingInvites.data.invites.length === 0 && (
              <li style={emptyRowStyle}>No pending invites.</li>
            )}
            {pendingInvites.data.invites.map((i) => {
              const busy = !!inviteBusyMap[i.inviteId];
              const err = inviteRowError[i.inviteId];
              return (
                <li
                  key={i.inviteId}
                  data-invite-id={i.inviteId}
                  data-invite-role={i.role}
                  style={memberRowStyle}
                >
                  <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    <div style={{ fontWeight: 500 }}>{i.email}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      {ROLE_LABELS[i.role]} · expires{" "}
                      {new Date(i.expiresAt).toLocaleString()}
                      {i.resendCount > 0 ? ` · resent ${i.resendCount}×` : ""}
                    </div>
                    {err && (
                      <div role="alert" data-state="error" style={inlineErrorStyle}>
                        {err}
                      </div>
                    )}
                  </div>
                  {canMutate && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        data-action="resend-invite"
                        disabled={busy}
                        onClick={() => void resendInvite(i.inviteId)}
                        style={toolbarBtn(false)}
                      >
                        Resend
                      </button>
                      <button
                        type="button"
                        data-action="revoke-invite"
                        disabled={busy}
                        onClick={() => void revokeInvite(i.inviteId)}
                        style={dangerBtn}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ============================ WORKSPACES ============================= */}
      <section data-section="org-workspaces" style={sectionStyle}>
        <SectionHeader
          title="Workspaces"
          subtitle="Operational evidence, cases, and reviewer queues live inside each workspace. Org-level membership does not grant workspace access — that is workspace-scoped."
          right={
            <Link
              href={`/teams?org=${orgId}`}
              data-action="workspaces-open-admin"
              style={cardLinkBtn(false)}
            >
              Workspace admin →
            </Link>
          }
        />
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
              <li style={emptyRowStyle}>
                No workspaces bound to this organization.
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
                    <span style={{ fontWeight: 500 }}>{w.name}</span>
                    {w.isPersonal ? <span style={miniChip}>personal</span> : null}
                    {w.billing && (
                      <>
                        <Pill
                          tone="rgba(99,102,241,0.18)"
                          data-pill="workspace-plan"
                        >
                          {w.billing.plan}
                        </Pill>
                        <Pill
                          tone={
                            w.billing.status === "ACTIVE"
                              ? "rgba(34,197,94,0.18)"
                              : "rgba(245,158,11,0.18)"
                          }
                          data-pill="workspace-billing-status"
                        >
                          {w.billing.status}
                        </Pill>
                        {w.billing.overSeatLimit && (
                          <Pill
                            tone="rgba(239,68,68,0.22)"
                            data-pill="workspace-over-seat"
                          >
                            OVER SEAT LIMIT
                          </Pill>
                        )}
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    Created {new Date(w.createdAt).toLocaleDateString()}
                    {w.billing
                      ? ` · ${w.billing.includedSeats} included seat${w.billing.includedSeats === 1 ? "" : "s"}`
                      : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Link
                    href={`/teams/${w.workspaceId}`}
                    data-action="open-workspace"
                    data-workspace-id={w.workspaceId}
                    style={cardLinkBtn(false)}
                  >
                    Open workspace
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ============================ AUDIT ================================== */}
      <section data-section="org-audit" style={sectionStyle}>
        <SectionHeader
          title="Audit timeline"
          subtitle="Organization governance events. Requires ORG_AUDITOR or higher."
          right={
            canAudit ? (
              <select
                data-action="audit-type-filter"
                value={auditTypeFilter}
                onChange={(e) => setAuditTypeFilter(e.target.value)}
                style={{ fontSize: 12 }}
              >
                <option value="">All event types</option>
                <option value="ORG_CREATED">ORG_CREATED</option>
                <option value="ORG_UPDATED">ORG_UPDATED</option>
                <option value="ORG_INVITE_CREATED">ORG_INVITE_CREATED</option>
                <option value="ORG_INVITE_ACCEPTED">ORG_INVITE_ACCEPTED</option>
                <option value="ORG_INVITE_REVOKED">ORG_INVITE_REVOKED</option>
                <option value="ORG_INVITE_RESENT">ORG_INVITE_RESENT</option>
                <option value="ORG_MEMBER_ROLE_CHANGED">ORG_MEMBER_ROLE_CHANGED</option>
                <option value="ORG_MEMBER_REMOVED">ORG_MEMBER_REMOVED</option>
              </select>
            ) : null
          }
        />
        {audit.kind === "loading" && <RowLoading />}
        {audit.kind === "error" && (
          <RowError
            status={audit.status}
            forbiddenMessage="You don’t have access to the audit timeline."
          />
        )}
        {audit.kind === "ready" && (
          <ul
            data-state="ready"
            data-total-events={audit.data.summary.totalEvents}
            style={listResetStyle}
          >
            {audit.data.events.length === 0 && (
              <li style={emptyRowStyle}>
                {auditTypeFilter
                  ? `No events matching ${auditTypeFilter}.`
                  : "No audit events yet."}
              </li>
            )}
            {audit.data.events.map((e) => (
              <li
                key={e.id}
                data-audit-event-type={e.eventType}
                style={{
                  padding: "0.45rem 0.6rem",
                  borderBottom: "1px solid rgba(127,127,127,0.18)",
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <strong>{e.eventType}</strong>{" "}
                    <span style={{ opacity: 0.7 }}>
                      ({e.targetType}
                      {e.targetId ? ` ${e.targetId.slice(0, 8)}…` : ""})
                    </span>
                  </div>
                  <div style={{ opacity: 0.75, fontSize: 12 }}>
                    {new Date(e.createdAt).toLocaleString()}
                  </div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  by{" "}
                  {e.actorDisplayName ||
                    e.actorEmail ||
                    e.actorUserId ||
                    "(unknown)"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ========================= SCOPE / HIERARCHY ========================== */}
      <section
        data-section="org-scope-hierarchy"
        style={{
          ...sectionStyle,
          background: "rgba(127,127,127,0.04)",
        }}
      >
        <SectionHeader
          title="Scope — what lives where"
          subtitle="The platform uses three tenancy scopes. Each one owns a specific category of operational data and a specific category of identity."
        />
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
            <div style={{ opacity: 0.85 }}>
              Private to you. Your own evidence, drafts, and integrations.
              Never shared. Lives outside any organization.
            </div>
          </div>
          <div data-scope="organization" style={scopeCard}>
            <div style={scopeTitle}>Organization (you are here)</div>
            <div style={{ opacity: 0.85 }}>
              Governance + identity tenant. Members, roles, invites, audit
              timeline, legal metadata. Does NOT grant workspace data access
              on its own.
            </div>
          </div>
          <div data-scope="workspace" style={scopeCard}>
            <div style={scopeTitle}>Workspace (a.k.a. Team)</div>
            <div style={{ opacity: 0.85 }}>
              Operational tenant. Evidence, cases, reviewer queues, retention
              policy, plan + seats. Each workspace is bound to exactly one
              organization. Workspace-level RBAC is independent of
              organization role.
            </div>
          </div>
        </div>
      </section>

      {/* ============================ DANGER ZONE ============================ */}
      <section
        data-section="org-danger-zone"
        style={{
          ...sectionStyle,
          borderColor: "rgba(220, 68, 68, 0.45)",
        }}
      >
        <SectionHeader
          title="Membership controls"
          subtitle="Lifecycle changes that affect your account or the organization. Items below are intentionally NOT self-service in Phase 2.7X — each one is documented with the operational path."
        />
        <div style={{ fontSize: 13, opacity: 0.9, display: "grid", gap: 10 }}>
          <div data-control="leave-organization-note">
            <strong>Leave organization:</strong> not yet a self-service
            action. Ask an organization admin to remove your membership from
            the Members list above. The DELETE on{" "}
            <code>/v1/orgs/:id/members/:membershipId</code> exists today
            but is intentionally limited to ORG_ADMIN+ acting on someone
            else; self-remove is blocked by the API to prevent accidental
            orphan-owner orgs.
          </div>
          <div data-control="transfer-ownership-note">
            <strong>Transfer ownership:</strong> not yet a one-step
            action. The current ORG_OWNER can promote a second member to{" "}
            <code>ORG_OWNER</code> from the Members list above; once two
            owners exist, either can be demoted. The audit timeline
            records both <code>ORG_MEMBER_ROLE_CHANGED</code> events so
            the transfer is fully traceable.
          </div>
          <div data-control="archive-organization-note">
            <strong>Archive / suspend organization:</strong> not
            self-service in Phase 2.7X. The org <code>status</code>
            column accepts <code>SUSPENDED</code>/<code>ARCHIVED</code>
            but those transitions are not yet wired to a write surface.
            Contact{" "}
            <Link href="/support" data-action="contact-support">
              support
            </Link>{" "}
            to suspend or archive.
          </div>
        </div>
      </section>

      {/* ============================ INVITE MODAL =========================== */}
      {inviteOpen && (
        <ModalShell
          onClose={() => !inviteBusy && setInviteOpen(false)}
          dataAttr="invite-member"
        >
          <form
            data-form="invite-member"
            onSubmit={(e) => {
              e.preventDefault();
              void submitInvite();
            }}
            style={modalForm}
          >
            <h2 style={{ margin: "0 0 0.5rem" }}>Invite member</h2>
            <p style={{ fontSize: 13, opacity: 0.85, marginTop: 0 }}>
              The invitee accepts via the returned token. Stage 4 does
              not send email automatically — share the token URL with
              them.
            </p>
            <label style={settingsLabel}>
              Email
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
                disabled={inviteBusy}
                data-input="invite-email"
                style={modalInput}
              />
            </label>
            <label style={settingsLabel}>
              Role
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                disabled={inviteBusy}
                data-input="invite-role"
                style={{
                  display: "block",
                  marginTop: 4,
                  padding: "0.35rem 0.45rem",
                }}
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            {inviteError && (
              <div role="alert" data-state="error" style={modalErrorBox}>
                {inviteError}
              </div>
            )}
            {lastInviteToken && (
              <div
                data-state="invite-token-issued"
                style={{
                  padding: "0.45rem 0.6rem",
                  border: "1px dashed currentColor",
                  borderRadius: 4,
                  fontSize: 12,
                  marginTop: 8,
                  wordBreak: "break-all",
                }}
              >
                <strong>Invite token</strong> — share this URL with the
                invitee:
                <div style={{ marginTop: 4 }}>
                  <code>/org-invites/{lastInviteToken}/accept</code>
                </div>
              </div>
            )}
            <div style={modalActions}>
              <button
                type="button"
                onClick={() => setInviteOpen(false)}
                disabled={inviteBusy}
                data-action="cancel-invite"
                style={toolbarBtn(false)}
              >
                Close
              </button>
              <button
                type="submit"
                disabled={inviteBusy || !inviteEmail.trim()}
                data-action="submit-invite"
                style={toolbarBtn(true)}
              >
                {inviteBusy ? "Sending…" : "Send invite"}
              </button>
            </div>
          </form>
        </ModalShell>
      )}
    </main>
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
    <div
      data-tile={dataAttr}
      style={{
        padding: "0.75rem 0.9rem",
        border: "1px solid rgba(127,127,127,0.3)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 110,
      }}
    >
      <div
        style={{
          fontSize: 11,
          opacity: 0.7,
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{primary}</div>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{secondary}</div>
      {footer && <div style={{ marginTop: "auto" }}>{footer}</div>}
    </div>
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
    <div
      data-section={dataSection}
      data-state="loading"
      style={{
        ...sectionStyle,
        opacity: 0.75,
      }}
    >
      Loading…
    </div>
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
    <div
      data-section={dataSection}
      data-state="error"
      role="alert"
      style={{
        ...sectionStyle,
        borderColor: "#d44",
        background: "rgba(220,68,68,0.06)",
      }}
    >
      <strong>Couldn’t load.</strong>
      <div style={{ fontSize: 13, marginTop: 4 }}>
        {status === 403
          ? forbiddenMessage
          : `${status ? `HTTP ${status}: ` : ""}${message}`}
      </div>
    </div>
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
    <div data-state="error" style={{ fontSize: 13, opacity: 0.85 }}>
      {status === 403 ? forbiddenMessage : "Couldn’t load."}
    </div>
  );
}

function ModalShell({
  onClose,
  children,
  dataAttr,
}: {
  onClose: () => void;
  children: React.ReactNode;
  dataAttr: string;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-modal={dataAttr}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

function Pill({
  tone,
  children,
  ...rest
}: {
  tone: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        padding: "1px 8px",
        borderRadius: 999,
        background: tone,
        border: "1px solid rgba(127,127,127,0.25)",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

// ---- shared styles ----

const sectionStyle: React.CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid rgba(127,127,127,0.3)",
  borderRadius: 8,
  marginBottom: "1rem",
};

const listResetStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const memberRowStyle: React.CSSProperties = {
  padding: "0.5rem 0.65rem",
  borderBottom: "1px solid rgba(127,127,127,0.18)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const emptyRowStyle: React.CSSProperties = {
  padding: "0.5rem 0.65rem",
  fontSize: 13,
  opacity: 0.75,
};

const inlineErrorStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: "#d44",
};

const miniChip: React.CSSProperties = {
  marginLeft: 6,
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: 11,
  background: "rgba(127,127,127,0.18)",
};

const settingsLabel: React.CSSProperties = {
  display: "block",
  fontSize: 13,
};

const modalForm: React.CSSProperties = {
  background: "var(--bg, #fff)",
  color: "var(--fg, #000)",
  padding: "1.25rem",
  borderRadius: 8,
  minWidth: 380,
  maxWidth: 520,
  boxShadow: "0 10px 32px rgba(0,0,0,0.42)",
};

const modalInput: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "0.45rem 0.55rem",
  border: "1px solid currentColor",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  fontSize: 13,
};

const modalErrorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "0.45rem 0.6rem",
  border: "1px solid #d44",
  borderRadius: 4,
  fontSize: 13,
  background: "rgba(220,68,68,0.06)",
};

const modalActions: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 12,
};

function toolbarBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "0.4rem 0.8rem",
    border: "1px solid currentColor",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: primary ? 600 : 500,
    background: primary ? "rgba(99,102,241,0.12)" : "transparent",
    color: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function cardLinkBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "0.35rem 0.7rem",
    border: "1px solid currentColor",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: primary ? 600 : 500,
    background: primary ? "rgba(99,102,241,0.12)" : "transparent",
    color: "inherit",
    textDecoration: "none",
    whiteSpace: "nowrap",
  };
}

const dangerBtn: React.CSSProperties = {
  border: "1px solid #d44",
  borderRadius: 4,
  padding: "0.2rem 0.55rem",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 12,
};

const scopeCard: React.CSSProperties = {
  padding: "0.7rem 0.85rem",
  border: "1px solid rgba(127,127,127,0.3)",
  borderRadius: 6,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  background: "transparent",
};

const scopeTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
};
