/**
 * Phase 32.8E — Workspace Administration frontend types.
 *
 * Mirrors the envelope returned by `/v1/teams/workspace-admin`.
 */

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

/**
 * @deprecated PHASE 3 — Inline `"PERSONAL" | "TEAM"` declaration.
 *   Prefer the canonical `WorkspaceScope` from
 *   `apps/web/lib/platform-context/types.ts`, or — for new code that
 *   speaks in the Target Domain Blueprint vocabulary — the
 *   `TargetWorkspaceKind` re-exported from `@proovra/shared`. This
 *   alias is one of 9 parallel `WorkspaceScope` declarations spread
 *   across api/web/worker; Phase 3 retains them to avoid a cascading
 *   import refactor but new code MUST consume the canonical type.
 *   See docs/architecture/domain-debt-register.md (DBT-WS-04).
 */
export type WorkspaceScope = "PERSONAL" | "TEAM";

export type WorkspaceAdminEnvelope = {
  generatedAt: string;
  workspace: {
    id: string;
    name: string;
    scope: WorkspaceScope;
    role: string;
    memberCount: number;
    adminCount: number;
    pendingInviteCount: number;
    plan: string;
    billingStatus: string;
    createdAt: string;
  };
  sections: {
    overview: {
      status: SectionStatus;
      data: {
        ownerEmail: string | null;
        ownerUserId: string;
        caseCount: number;
        evidenceCount: number;
      } | null;
    };
    access: {
      status: SectionStatus;
      members: Array<{
        userId: string;
        email: string | null;
        displayName: string | null;
        role: string;
        status: string;
        joinedAt: string;
        lastSeenAtUtc: string | null;
      }>;
      invites: Array<{
        id: string;
        email: string;
        role: string;
        createdAt: string;
        expiresAt: string;
      }>;
    };
    governanceSnapshot: {
      status: SectionStatus;
      data: {
        policySource: "workspace_row" | "default";
        activeLegalHoldsCount: number;
        activeCaseLegalHoldsCount: number;
        retentionPoliciesCount: number;
        pendingDestructionCount: number;
        allowReportDownload: boolean;
        allowPackageDownload: boolean;
        allowPublicVerify: boolean;
      } | null;
    };
    integrationsPosture: {
      status: SectionStatus;
      data: {
        apiCredentialsCount: number;
        webhookEndpointsCount: number;
        recentFailedDeliveriesCount: number;
      } | null;
    };
    billing: {
      status: SectionStatus;
      data: {
        plan: string;
        status: string;
        includedSeats: number;
        activeMembers: number;
        overSeatLimit: boolean;
      } | null;
    };
    operationalAccountability: {
      status: SectionStatus;
      activities: Array<{
        id: string;
        eventType: string;
        actorUserId: string | null;
        targetType: string;
        targetId: string | null;
        createdAt: string;
      }>;
      reviewerWorkload: {
        queuedCount: number;
        assignedCount: number;
        overdueCount: number;
        openEscalationsCount: number;
      } | null;
    };
  };
};
