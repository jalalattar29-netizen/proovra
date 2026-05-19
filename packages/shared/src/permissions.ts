/**
 * Phase 9 — canonical permission model.
 *
 * This module defines:
 *   1. The set of permission identifiers PROOVRA uses across the platform.
 *   2. A canonical role enum (OWNER/ADMIN/REVIEWER/CONTRIBUTOR/VIEWER).
 *   3. A mapping from the existing DB TeamRole (OWNER/ADMIN/MEMBER/VIEWER)
 *      to the canonical roles, so we don't have to migrate the DB.
 *   4. Pure helpers `roleHasPermission(role, perm)` and
 *      `mapTeamRoleToCanonical(teamRole)`.
 *
 * Why this lives in shared: API, worker, and web all need a single
 * authoritative answer to "is this role allowed to do X" without
 * shipping a server round-trip for every permission check.
 *
 * Privacy rule: permission IDs are workspace-internal. Public surfaces
 * (public verify, external intake) never receive a canonical role.
 * EXTERNAL_CONTRIBUTOR and PUBLIC_VERIFIER are listed only for
 * documentation; they are NOT mapped from any TeamRole and have an
 * empty permission set by design.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Permission identifiers
// -----------------------------------------------------------------------------

export const PERMISSIONS = [
  // Evidence
  "evidence.read",
  "evidence.create",
  "evidence.update_metadata",
  "evidence.delete",
  "evidence.archive",
  "evidence.generate_report",
  "evidence.generate_package",
  "evidence.publish_verify",
  "evidence.download_original",
  "evidence.download_report",
  "evidence.download_package",

  // Workflow / templates / intake links
  "workflow.template.manage",
  "workflow.intake_link.create",
  "workflow.intake_link.revoke",
  "workflow.external_submission.read",

  // Evidence requests
  "evidence_request.create",
  "evidence_request.assign",
  "evidence_request.review",
  "evidence_request.close",
  "evidence_request.cancel",

  // Notifications
  "notification.delivery.read",
  "notification.delivery.resend",

  // Governance / audit
  "governance.policy.read",
  "governance.policy.manage",
  "governance.legal_hold.manage",
  "governance.retention.manage",
  "audit.read",
  "audit.export",

  // Integration platform (admin-only canonical permissions; ALSO
  // valid as API-key scopes for the public enterprise API).
  "integration.api_key.manage",
  "integration.webhook.manage",
  "integration.evidence.read",
  "integration.evidence.create",
  // Phase 30.6 — resumable upload session scope. Granted independently
  // of `integration.evidence.create` so an ingestion key can be allowed
  // to drive uploads without being allowed to create evidence rows by
  // other means (and vice versa). Used by /v1/integrations/api/uploads/*.
  "integration.evidence.upload",
  "integration.intake_link.create",
  "integration.evidence_request.create",
  "integration.evidence_request.read",

  // Phase 13/13.5 — review operations.
  "review.queue.read",
  "review.assign",
  "review.decide",
  "review.escalate",
  "review.reopen",
  "review.sla.configure",

  // Phase 15 — intelligence operations.
  "intelligence.read",
  "intelligence.run",
  "intelligence.feedback.write",
  "intelligence.policy.manage",

  // Phase 16 — collaboration operations.
  "collaboration.thread.read",
  "collaboration.thread.create",
  "collaboration.message.post",
  "collaboration.thread.resolve",
  "collaboration.thread.reopen",
  "collaboration.thread.escalate",
  "collaboration.contributor.access.manage",

  // Phase 14 — publication / public verify gate.
  "publication.public_verify.gate",

  // Phase 17 — retention (split from governance.retention.manage for
  // delegated administration; governance.retention.manage stays the
  // legacy canonical and remains the source of truth — retention.*
  // entries add scoped read/configure granularity).
  "retention.read",
  "retention.configure",

  // Phase 17 — identity & access platform. Required for any operation
  // that mutates a TeamMember lifecycle, grants capabilities, manages
  // delegated admin scopes, or edits the org security policy. Failing
  // these checks ALWAYS fails closed.
  "identity.member.read",
  "identity.member.invite",
  "identity.member.role.change",
  "identity.member.suspend",
  "identity.member.revoke",
  "identity.member.restore",
  "identity.capability.grant",
  "identity.capability.revoke",
  "identity.delegated_admin.grant",
  "identity.delegated_admin.revoke",
  "identity.service_account.manage",
  "identity.service_account.disable",
  "identity.contributor_session.revoke",
  "identity.org_policy.read",
  "identity.org_policy.manage",
  "identity.access_review.read",
  "identity.access_review.action",
  "identity.external_mapping.read",
  "identity.external_mapping.manage",

  // Phase 17 — billing. Stub permissions for the billing/seat view in
  // the identity UI. No billing flows change in this phase; the perms
  // exist so the UI can gate the "billing seats" tile.
  "billing.read",
  "billing.manage",
] as const;

export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

// -----------------------------------------------------------------------------
// Canonical roles
//
// These are the conceptual roles PROOVRA reasons about. The DB stores a
// narrower 4-role enum (TeamRole: OWNER/ADMIN/MEMBER/VIEWER). The MEMBER
// canonical role splits into REVIEWER and CONTRIBUTOR by convention —
// today the DB cannot distinguish them, so MEMBER receives the union.
//
// EXTERNAL_CONTRIBUTOR and PUBLIC_VERIFIER are conceptual roles for the
// unauthenticated surfaces; they have empty permission sets here. They
// exist so route code can pass them through `roleHasPermission` and get
// a uniformly negative answer rather than special-casing the check.
// -----------------------------------------------------------------------------

export const CANONICAL_ROLES = [
  "OWNER",
  "ADMIN",
  "REVIEWER",
  "CONTRIBUTOR",
  "VIEWER",
  "EXTERNAL_CONTRIBUTOR",
  "PUBLIC_VERIFIER",
] as const;
export const CanonicalRoleSchema = z.enum(CANONICAL_ROLES);
export type CanonicalRole = z.infer<typeof CanonicalRoleSchema>;

// -----------------------------------------------------------------------------
// DB TeamRole values (mirror of @prisma/client TeamRole enum). Duplicated
// here so this module has no Prisma dependency and can be imported from
// the web bundle.
// -----------------------------------------------------------------------------

export const DB_TEAM_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
export type DbTeamRole = (typeof DB_TEAM_ROLES)[number];

/**
 * Map the DB role to the canonical role used for permission checks.
 *
 * OWNER → OWNER
 * ADMIN → ADMIN
 * MEMBER → REVIEWER (broader of the two member-tier roles; MEMBER can
 *          also act as CONTRIBUTOR for read/create permissions because
 *          REVIEWER's permission set is a superset of CONTRIBUTOR's.)
 * VIEWER → VIEWER
 */
export function mapTeamRoleToCanonical(role: DbTeamRole): CanonicalRole {
  switch (role) {
    case "OWNER":
      return "OWNER";
    case "ADMIN":
      return "ADMIN";
    case "MEMBER":
      return "REVIEWER";
    case "VIEWER":
      return "VIEWER";
  }
}

// -----------------------------------------------------------------------------
// Role → Permission matrix
//
// Conservative default. Adding a permission requires explicit decisions
// here. Removing one requires audit (might break route enforcement).
// -----------------------------------------------------------------------------

const ROLE_PERMISSIONS: Readonly<Record<CanonicalRole, ReadonlyArray<Permission>>> = {
  OWNER: [...PERMISSIONS],

  ADMIN: [
    "evidence.read",
    "evidence.create",
    "evidence.update_metadata",
    "evidence.delete",
    "evidence.archive",
    "evidence.generate_report",
    "evidence.generate_package",
    "evidence.publish_verify",
    "evidence.download_original",
    "evidence.download_report",
    "evidence.download_package",
    "workflow.template.manage",
    "workflow.intake_link.create",
    "workflow.intake_link.revoke",
    "workflow.external_submission.read",
    "evidence_request.create",
    "evidence_request.assign",
    "evidence_request.review",
    "evidence_request.close",
    "evidence_request.cancel",
    "notification.delivery.read",
    "notification.delivery.resend",
    "governance.policy.read",
    "governance.policy.manage",
    "governance.legal_hold.manage",
    "governance.retention.manage",
    "audit.read",
    "audit.export",
    "integration.api_key.manage",
    "integration.webhook.manage",
    "integration.evidence.read",
    "integration.evidence.create",
    "integration.evidence.upload",
    "integration.intake_link.create",
    "integration.evidence_request.create",
    "integration.evidence_request.read",
    "review.queue.read",
    "review.assign",
    "review.decide",
    "review.escalate",
    "review.reopen",
    "review.sla.configure",
    "intelligence.read",
    "intelligence.run",
    "intelligence.feedback.write",
    "intelligence.policy.manage",
    "collaboration.thread.read",
    "collaboration.thread.create",
    "collaboration.message.post",
    "collaboration.thread.resolve",
    "collaboration.thread.reopen",
    "collaboration.thread.escalate",
    "collaboration.contributor.access.manage",
    "publication.public_verify.gate",
    "retention.read",
    "retention.configure",
    "identity.member.read",
    "identity.member.invite",
    "identity.member.role.change",
    "identity.member.suspend",
    "identity.member.revoke",
    "identity.member.restore",
    "identity.capability.grant",
    "identity.capability.revoke",
    "identity.delegated_admin.grant",
    "identity.delegated_admin.revoke",
    "identity.service_account.manage",
    "identity.service_account.disable",
    "identity.contributor_session.revoke",
    "identity.org_policy.read",
    "identity.org_policy.manage",
    "identity.access_review.read",
    "identity.access_review.action",
    "identity.external_mapping.read",
    "identity.external_mapping.manage",
    "billing.read",
    // NOT: billing.manage — OWNER-only.
  ],

  REVIEWER: [
    "evidence.read",
    "evidence.create",
    "evidence.update_metadata",
    "evidence.generate_report",
    "evidence.generate_package",
    "evidence.publish_verify",
    "evidence.download_original",
    "evidence.download_report",
    "evidence.download_package",
    "workflow.intake_link.create",
    "workflow.intake_link.revoke",
    "workflow.external_submission.read",
    "evidence_request.create",
    "evidence_request.assign",
    "evidence_request.review",
    "evidence_request.close",
    "evidence_request.cancel",
    "notification.delivery.read",
    "notification.delivery.resend",
    "governance.policy.read",
    "audit.read",
    "review.queue.read",
    "review.assign",
    "review.decide",
    "review.escalate",
    "review.reopen",
    "intelligence.read",
    "intelligence.run",
    "intelligence.feedback.write",
    "collaboration.thread.read",
    "collaboration.thread.create",
    "collaboration.message.post",
    "collaboration.thread.resolve",
    "collaboration.thread.reopen",
    "collaboration.thread.escalate",
    "collaboration.contributor.access.manage",
    "retention.read",
    "identity.member.read",
    "identity.org_policy.read",
    "identity.access_review.read",
    "identity.external_mapping.read",
    "billing.read",
    // NOT: delete, archive, governance.manage, legal_hold.manage,
    // retention.manage, audit.export, workflow.template.manage,
    // any identity.member.{invite,suspend,revoke,restore,role.change},
    // any identity.capability.*, any identity.delegated_admin.*,
    // any identity.service_account.*, identity.contributor_session.revoke,
    // identity.org_policy.manage, identity.access_review.action,
    // identity.external_mapping.manage, billing.manage,
    // publication.public_verify.gate, intelligence.policy.manage,
    // retention.configure, review.sla.configure
  ],

  CONTRIBUTOR: [
    "evidence.read",
    "evidence.create",
    "evidence.update_metadata",
    "evidence.download_original",
    "evidence.download_report",
    "evidence.download_package",
    "workflow.external_submission.read",
    "evidence_request.create",
    "notification.delivery.read",
    "governance.policy.read",
    "intelligence.read",
    "collaboration.thread.read",
    "collaboration.message.post",
  ],

  VIEWER: [
    "evidence.read",
    "evidence.download_report",
    "evidence.download_package",
    "workflow.external_submission.read",
    "notification.delivery.read",
    "governance.policy.read",
    "collaboration.thread.read",
    "identity.member.read",
    "identity.org_policy.read",
  ],

  EXTERNAL_CONTRIBUTOR: [],
  PUBLIC_VERIFIER: [],
};

// Build the lookup sets once for O(1) checks.
const ROLE_PERMISSION_SETS: Record<CanonicalRole, ReadonlySet<Permission>> = {
  OWNER: new Set(ROLE_PERMISSIONS.OWNER),
  ADMIN: new Set(ROLE_PERMISSIONS.ADMIN),
  REVIEWER: new Set(ROLE_PERMISSIONS.REVIEWER),
  CONTRIBUTOR: new Set(ROLE_PERMISSIONS.CONTRIBUTOR),
  VIEWER: new Set(ROLE_PERMISSIONS.VIEWER),
  EXTERNAL_CONTRIBUTOR: new Set(ROLE_PERMISSIONS.EXTERNAL_CONTRIBUTOR),
  PUBLIC_VERIFIER: new Set(ROLE_PERMISSIONS.PUBLIC_VERIFIER),
};

// -----------------------------------------------------------------------------
// Pure predicate
// -----------------------------------------------------------------------------

export function roleHasPermission(
  role: CanonicalRole | DbTeamRole | null | undefined,
  permission: Permission,
): boolean {
  if (!role) return false;
  const canonical = DB_TEAM_ROLES.includes(role as DbTeamRole)
    ? mapTeamRoleToCanonical(role as DbTeamRole)
    : (role as CanonicalRole);
  return ROLE_PERMISSION_SETS[canonical]?.has(permission) ?? false;
}

export function listRolePermissions(
  role: CanonicalRole,
): ReadonlyArray<Permission> {
  return ROLE_PERMISSIONS[role];
}
