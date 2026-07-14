"use client";

/**
 * ONE canonical UI-context resolver for the Operations Center and
 * Notification Preferences surfaces.
 *
 * A THIN projection of the existing platform-context envelope — no new
 * role system, no fetches, no label- or plan-name-derived permissions.
 * It controls UI RELEVANCE only; every data decision stays backend-
 * enforced (the aggregation derives recipients from membership/role
 * rows, the preference/policy routes 403 on their own).
 *
 * CANONICAL VISIBILITY MODEL (product decision, 2026-07-14 —
 * "Option A", capability-based):
 *
 *   Workspace-workflow surfaces (collaboration, mentions, reviews,
 *   case assignments, intake, integrity) are ALWAYS offered wherever a
 *   workspace exists — like every reference evidence-operations
 *   platform, navigation and controls are stable and permission-
 *   shaped, never data-driven. Participation-driven hiding was
 *   evaluated and REJECTED: it flaps with item counts, hides controls
 *   until after the first event they govern, and requires a
 *   participation-tracking subsystem with no operator value.
 *   Consequently there are NO predicates for those surfaces — absence
 *   of a flag here IS the rule.
 *
 *   Only classes a user can NEVER receive are gated:
 *
 *   - canViewAdminAttention — the Admin attention class (org-invite
 *     rollups, MFA approvals, communication failures) derives its
 *     recipients exclusively from OWNER/ADMIN memberships of
 *     ORGANIZATION workspaces.
 *   - canReceiveGovernance — governance is an ORGANIZATION surface in
 *     practice: the capability map grants GOVERNANCE_VIEW only in the
 *     isTeam branch (NO personal tier receives it — verified against
 *     capability-registry.ts), and every /governance/* route is
 *     ORGANIZATION_ONLY, so a personal user could neither open a
 *     governance deep link nor acknowledge an item. Deriving from the
 *     backend capability (rather than hardcoding "org-only") keeps
 *     this in lock-step with the registry if that ever changes.
 */

import { useCan } from "../platform-context";
import {
  useActiveSpace,
  useOrganizations,
  usePersonalSpace,
} from "../platform-context";

export type OperationsUiContext = {
  /** Active space id (personal team id or organization workspace id). */
  workspaceId: string | null;
  isPersonalWorkspace: boolean;
  /** True when the user belongs to ≥1 ACTIVE organization workspace. */
  hasOrganizations: boolean;
  canViewAdminAttention: boolean;
  canReceiveGovernance: boolean;
};

/** Envelope facts the pure derivation consumes. */
export type OperationsUiContextInput = {
  activeSpaceType: "PERSONAL" | "ORGANIZATION" | null;
  activeSpaceId: string | null;
  personalSpaceId: string | null;
  organizations: ReadonlyArray<{
    membershipStatus: "ACTIVE" | "PENDING" | "INACTIVE";
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  }>;
  /** Canonical capability-map verdict for GOVERNANCE_VIEW. */
  hasGovernanceCapability: boolean;
};

/**
 * Pure derivation — exported so behavior is unit-testable without a
 * rendered React tree.
 */
export function deriveOperationsUiContext(
  input: OperationsUiContextInput,
): OperationsUiContext {
  const activeOrgs = input.organizations.filter(
    (o) => o.membershipStatus === "ACTIVE",
  );
  const workspaceId = input.activeSpaceId ?? input.personalSpaceId ?? null;
  const isPersonalWorkspace = input.activeSpaceType
    ? input.activeSpaceType === "PERSONAL"
    : true;
  return {
    workspaceId,
    isPersonalWorkspace,
    hasOrganizations: activeOrgs.length > 0,
    canViewAdminAttention: activeOrgs.some(
      (o) => o.role === "OWNER" || o.role === "ADMIN",
    ),
    canReceiveGovernance: isPersonalWorkspace
      ? input.hasGovernanceCapability
      : workspaceId != null,
  };
}

export function useOperationsUiContext(): OperationsUiContext {
  const activeSpace = useActiveSpace();
  const personalSpace = usePersonalSpace();
  const organizations = useOrganizations();
  const hasGovernanceCapability = useCan("GOVERNANCE_VIEW");

  return deriveOperationsUiContext({
    activeSpaceType: activeSpace?.type ?? null,
    activeSpaceId: activeSpace?.id ?? null,
    personalSpaceId: personalSpace?.id ?? null,
    organizations,
    hasGovernanceCapability,
  });
}
