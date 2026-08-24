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

  // Phase 3A — Enterprise Redaction Platform. Nine bounded capabilities
  // that the redaction-routes layer + redaction services enforce:
  //   view              — read-only access to projects/versions/regions
  //   region.author     — create / edit / delete regions inside a version
  //   detection.run     — kick off an AI detection pass
  //   detection.review  — accept / reject detection candidates
  //   version.submit    — submit a draft version for approval
  //   version.approve   — approve a submitted version (requires senior tier)
  //   version.publish   — publish an approved version (sealed)
  //   derivative.download — download a published derivative artifact
  //   administer        — workspace-level redaction admin (config, providers)
  // REVIEWER canonical role MUST NOT receive approve / publish / download /
  // administer (split-of-duty enforcement). Authoring + reviewing detection
  // results is in-scope; publishing redacted derivatives is separation-of-duty.
  "redaction.view",
  "redaction.region.author",
  "redaction.detection.run",
  "redaction.detection.review",
  "redaction.version.submit",
  "redaction.version.approve",
  "redaction.version.publish",
  "redaction.derivative.download",
  "redaction.administer",

  // ==========================================================================
  // ATTENTION ARCHITECTURE PHASE 4B (2026-08-22) — TENANT OPERATIONS.
  //
  // THE DEFECT THESE REPLACE (D29)
  // ------------------------------
  // Generic Operations mutations — acknowledge, resolve, suppress, assign on
  // an OperationalIncident — were authorized by `identity.access_review.action`.
  // That permission governs a SECURITY decision: approving or rejecting
  // somebody's continued access to a workspace. Borrowing it to acknowledge a
  // failed report is wrong in both directions at once. It hands every operator
  // who may triage an incident the authority to adjudicate access reviews, and
  // it makes "who may run operations here?" unanswerable without knowing that
  // an unrelated identity permission is standing in for it.
  //
  // WHAT IS DELIBERATELY ABSENT
  // ---------------------------
  // There is no `operations.retry`. Retrying a report, re-anchoring a record
  // or re-sending a message is a DOMAIN action, authorized by that domain's
  // own permission (`evidence.generate_report`, `notification.delivery.resend`,
  // …). Operations may link to it; it does not acquire the right to perform
  // it. A generic retry permission would be Operations quietly becoming a
  // second authority over every domain it displays.
  // ==========================================================================
  "operations.view",
  "operations.acknowledge",
  "operations.assign",
  "operations.resolve",
  "operations.suppress",
  // ==========================================================================
  // SHARED SAVED VIEWS.
  //
  // A saved view scoped TEAM is workspace CONFIGURATION: it appears in every
  // authorized colleague's toolbar and names a slice of the queue on their
  // behalf. Creating and managing one is therefore an administrative act, and
  // it was previously gated on `operations.view` — a READ capability — so
  // anybody who could look at the queue could also publish configuration into
  // everybody else's workbench.
  //
  // A read capability must not implicitly grant authority over shared state.
  //
  // WHAT THIS DOES NOT COVER
  // ------------------------
  // PRIVATE views. Those are one person's own bookmarks, they appear to
  // nobody else, and requiring an administrative capability to keep a
  // bookmark would make the feature useless to the readers who most need it.
  // PRIVATE remains available to any authorized Operations reader and remains
  // strictly creator-owned — an administrator holding this capability still
  // cannot read, rename or delete somebody else's PRIVATE view.
  "operations.saved_views.manage",
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
    // Phase 3A — ADMIN canonical role gets the FULL redaction capability set.
    "redaction.view",
    "redaction.region.author",
    "redaction.detection.run",
    "redaction.detection.review",
    "redaction.version.submit",
    "redaction.version.approve",
    "redaction.version.publish",
    "redaction.derivative.download",
    "redaction.administer",
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
    // PHASE 4B — the full Operations set. Assignment and suppression are
    // admin-tier for the same reason CASE_ASSIGN and GOVERNANCE_ACT are:
    // one decides somebody else's workload, the other decides that a
    // workspace stops being told about unresolved work.
    "operations.view",
    "operations.acknowledge",
    "operations.assign",
    "operations.resolve",
    "operations.suppress",
    // Shared workspace configuration, alongside assignment and suppression:
    // all three decide something on a colleague's behalf.
    "operations.saved_views.manage",
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
    // Phase 3A — REVIEWER canonical gets the bounded redaction subset:
    // view, author regions, and review detections. The reviewer is the
    // operator who PROPOSES redactions, not the one who approves/publishes.
    "redaction.view",
    "redaction.region.author",
    "redaction.detection.review",
    "identity.member.read",
    "identity.org_policy.read",
    "identity.access_review.read",
    "identity.external_mapping.read",
    "billing.read",
    // PHASE 4B — a reviewer OPERATES: they may see shared work, say they
    // have it, and say it is done. They may not hand it to somebody else,
    // and they may not decide the workspace stops hearing about it.
    "operations.view",
    "operations.acknowledge",
    "operations.resolve",
    // NOT: operations.assign, operations.suppress
    // NOT: operations.saved_views.manage — publishing a view into every
    // colleague's toolbar is shared workspace configuration, which is the
    // same class of decision as assignment and suppression. A reviewer keeps
    // full authority over their own PRIVATE views.
    // NOT: delete, archive, governance.manage, legal_hold.manage,
    // retention.manage, audit.export, workflow.template.manage,
    // any identity.member.{invite,suspend,revoke,restore,role.change},
    // any identity.capability.*, any identity.delegated_admin.*,
    // any identity.service_account.*, identity.contributor_session.revoke,
    // identity.org_policy.manage, identity.access_review.action,
    // identity.external_mapping.manage, billing.manage,
    // publication.public_verify.gate, intelligence.policy.manage,
    // retention.configure, review.sla.configure,
    // redaction.detection.run, redaction.version.{submit,approve,publish},
    // redaction.derivative.download, redaction.administer
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
    // PHASE 4B — a contributor can SEE the workspace's unresolved work (it
    // explains why their upload has not produced a report yet) and acts on
    // none of it.
    "operations.view",
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
    // PHASE 4B — VIEWER may look and may not act. Every Operations mutation
    // is absent here, deliberately and by omission rather than by a runtime
    // role-name comparison somewhere else.
    "operations.view",
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
