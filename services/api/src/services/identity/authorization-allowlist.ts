/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
 * exception registry + migration ledger.
 *
 * This is NOT an allow-by-default list. Its purpose is to make the set of
 * routes/services that authorize WITHOUT ordinary ACTIVE Workspace
 * membership explicit and machine-checkable, so a new direct membership /
 * role gate cannot be introduced silently.
 *
 * Three classes:
 *
 *   CANONICAL  — the route composes the canonical primitive
 *                (`authorizeOrFail` / `requireAuthorize` / a wrapper that
 *                calls `evaluateMemberAccess`) OR performs an explicit
 *                ACTIVE-status membership check. Detected automatically by
 *                the static-enforcement test; not listed here.
 *
 *   EXCEPTION  — a legitimate non-membership flow (token / worker / system
 *                / account-wide). Every entry documents its own
 *                authorization mechanism, tenant binding, and revocation.
 *
 *   PENDING    — a KNOWN status-blind / capability-blind gate that Phase 1
 *                has not yet migrated. This is tracked tech debt, ranked by
 *                severity, with the planned canonical permission. The
 *                static test asserts the live set of unclassified gates is
 *                a subset of EXCEPTION ∪ PENDING, so removing a gate from
 *                PENDING requires actually migrating it (or the test fails).
 *
 * Definition of done for the phase: PENDING is empty.
 */

export type AuthorizationExceptionCategory =
  | "PUBLIC_VERIFICATION_TOKEN"
  | "EXTERNAL_REVIEW_TOKEN"
  | "INTAKE_SUBMISSION_TOKEN"
  | "SIGNED_SHARE_LINK"
  | "TRUSTED_WORKER_JOB"
  | "SIGNED_WEBHOOK"
  | "SYSTEM_BOOTSTRAP"
  | "ACCOUNT_WIDE_SELF_SERVICE"
  | "ENTERPRISE_IDENTITY_PROVISIONING"
  | "PLATFORM_ADMIN_CONSOLE"
  /**
   * NON_ACTOR_MEMBERSHIP_CHECK — the file contains a `teamMember.find*`
   * call, but it is NOT an actor-authorization gate. It validates that a
   * TARGET/SUBJECT user (an assignee, a reviewer being assigned, an SSO
   * mapping subject) belongs to the workspace, seeds a system actor, or
   * reads a member's role for policy display. The ACTOR is authorized
   * upstream at the route boundary. Tightening these target checks to
   * ACTIVE-only is an assignment-validity concern, tracked separately
   * from Phase-1 actor-authorization closure.
   */
  | "NON_ACTOR_MEMBERSHIP_CHECK"
  /** Trusted worker / cron execution context (system actor, not a member). */
  | "TRUSTED_WORKER_JOB"
  /** System bootstrap / seed — not an authorization decision. */
  | "SYSTEM_BOOTSTRAP";

export type AuthorizationException = {
  id: string;
  /** Route/service file (basename) this exception applies to. */
  file: string;
  domain: string;
  category: AuthorizationExceptionCategory;
  /** How the flow authorizes instead of ACTIVE Workspace membership. */
  mechanism: string;
  /** Why ordinary Workspace membership does not apply. */
  reason: string;
  /** Where tenant scope is bound. */
  tenantBinding: string;
  /** Expiry / revocation behavior of the alternative credential. */
  revocation: string;
};

export const AUTHORIZATION_EXCEPTIONS: ReadonlyArray<AuthorizationException> = [
  {
    id: "PUBLIC_VERIFICATION",
    file: "evidence.routes.ts",
    domain: "public verification",
    category: "PUBLIC_VERIFICATION_TOKEN",
    mechanism:
      "Unauthenticated GET /public/verify/:id — no membership; returns only the bounded public projection (submitter email always null; workspace/org name null unless env opt-in). IP + per-evidence rate limited.",
    reason:
      "Public verifiability is a product requirement; verification must work for anyone holding the evidence id.",
    tenantBinding: "record id; response projection strips tenant identifiers",
    revocation: "publication gate (publication.public_verify.gate) controls exposure",
  },
  {
    id: "EXTERNAL_REVIEW_PORTAL",
    file: "external-portal.routes.ts",
    domain: "external reviewer",
    category: "EXTERNAL_REVIEW_TOKEN",
    mechanism:
      "Scoped external-review grant token bound to a specific evidence/review; expiry + revocation on the grant row.",
    reason:
      "External reviewers are not Workspace members; access is grant-scoped, not membership-scoped.",
    tenantBinding: "ExternalReviewerRoleAssignment / grant → evidence/review",
    revocation: "grant revoke + expiry",
  },
  {
    id: "SAML_OIDC_LOGIN",
    file: "saml-auth.routes.ts",
    domain: "enterprise SSO login",
    category: "ENTERPRISE_IDENTITY_PROVISIONING",
    mechanism:
      "Signed SAML assertion / validated OIDC id_token; membership is the RESULT of JIT, not a precondition of the login callback.",
    reason:
      "Login establishes identity before any Workspace membership can be evaluated.",
    tenantBinding: "SsoConnection.teamId; JIT writes TeamMember for that team",
    revocation: "connection status + session revocation",
  },
  {
    id: "SCIM_PROVISIONING",
    file: "scim.service.ts",
    domain: "enterprise directory provisioning",
    category: "ENTERPRISE_IDENTITY_PROVISIONING",
    mechanism:
      "Hashed SCIM bearer token (scim_pat_) bound to a team; the directory, not a Workspace member, is the actor.",
    reason:
      "SCIM provisions membership; it cannot itself be gated on membership.",
    tenantBinding: "ScimProvisioningToken.teamId",
    revocation: "token revoke + expiry",
  },
  {
    id: "INTAKE_SUBMISSION_TOKEN",
    file: "workflow-intake-token.service.ts",
    domain: "external intake submission",
    category: "INTAKE_SUBMISSION_TOKEN",
    mechanism:
      "Unguessable intake link token; destination Workspace is fixed by the persisted WorkflowIntakeLink.teamId, not chosen by the submitter.",
    reason: "External submitters are not Workspace members.",
    tenantBinding: "WorkflowIntakeLink.teamId (persisted, server-fixed)",
    revocation: "link revoke + expiry",
  },
  // ---- Non-actor membership checks (target/subject validation, system
  //      seed, informational role read). Flagged by the static scanner
  //      because they call teamMember.find*, but they are NOT actor
  //      authorization gates — the actor is authorized upstream. ----
  {
    id: "CRON_FALLBACK_AUTH",
    file: "cron-secret.ts",
    domain: "scheduled-job auth",
    category: "TRUSTED_WORKER_JOB",
    mechanism:
      "Primary path is a constant-time CRON_SECRET header compare. The teamMember lookup is only a NON-PRODUCTION fallback (secret unset) that requires an OWNER/ADMIN membership; it never runs when CRON_SECRET is configured.",
    reason:
      "Scheduled jobs run as a system actor, not a Workspace member; the fallback is a dev-only convenience.",
    tenantBinding: "cron secret is global; fallback membership is role-scoped",
    revocation: "rotate/unset CRON_SECRET; fallback disabled in production",
  },
  {
    id: "OPERATIONAL_SEED_ACTOR",
    file: "operational-seed.service.ts",
    domain: "operational seed / reconcile",
    category: "SYSTEM_BOOTSTRAP",
    mechanism:
      "Selects the earliest team member purely to annotate seeded workflow rows for visibility (runReconcile does not validate reviewer permission). Not an authorization decision.",
    reason: "System seed/reconcile executes as the platform, not as a member.",
    tenantBinding: "teamId scope on the seed operation",
    revocation: "n/a (system operation)",
  },
  {
    id: "AUTOMATION_TARGET_MEMBERSHIP",
    file: "automation-actions.service.ts",
    domain: "automation action target",
    category: "NON_ACTOR_MEMBERSHIP_CHECK",
    mechanism:
      "Validates that the NOTIFY_USER recipient / ASSIGN_REVIEWER assignee is a member of the team before the automation acts on them. Defence-in-depth on the action TARGET; the automation actor is the rules engine (system).",
    reason:
      "Not an actor gate — the automation trigger is authorized where the rule is created; this validates the target user.",
    tenantBinding: "teamId_userId on the target lookup",
    revocation: "n/a (target-existence check)",
  },
  {
    id: "BULK_ACTION_ASSIGNEE",
    file: "bulk-actions.service.ts",
    domain: "bulk assign target",
    category: "NON_ACTOR_MEMBERSHIP_CHECK",
    mechanism:
      "Validates that the bulk-assign assignee is a member of the team (invalid_assignee otherwise). The ACTOR performing the bulk action is authorized upstream at the dashboard route.",
    reason: "Validates the assignment TARGET, not the actor.",
    tenantBinding: "teamId + assigneeUserId",
    revocation: "n/a (target-existence check)",
  },
  {
    id: "WORKFLOW_REVIEWER_TARGET",
    file: "evidence-workflow-engine.service.ts",
    domain: "workflow reviewer assignment target",
    category: "NON_ACTOR_MEMBERSHIP_CHECK",
    mechanism:
      "Validates that the reviewer being ASSIGNED to a workflow instance is a current team member (WORKFLOW_ACTOR_NOT_PERMITTED otherwise). Validates the assignment target, not the caller.",
    reason: "Validates the assignment TARGET, not the actor.",
    tenantBinding: "teamId + reviewerUserId",
    revocation: "n/a (target-existence check)",
  },
  {
    id: "EXTERNAL_IDENTITY_SUBJECT",
    file: "external-identity.service.ts",
    domain: "SSO mapping subject",
    category: "NON_ACTOR_MEMBERSHIP_CHECK",
    mechanism:
      "Verifies the SUBJECT userId of a new SSO/external-identity mapping actually belongs to the workspace, so an operator cannot map an arbitrary userId. The operator (actor) is authorized upstream.",
    reason: "Validates the mapping SUBJECT, not the actor.",
    tenantBinding: "teamId + subject userId",
    revocation: "n/a (subject-existence check)",
  },
  {
    id: "SESSION_TIMEOUT_ROLE_READ",
    file: "session-timeout-policy.service.ts",
    domain: "session-timeout policy derivation",
    category: "NON_ACTOR_MEMBERSHIP_CHECK",
    mechanism:
      "Reads the member's role only to DERIVE which session-timeout policy field applies to that user. Informational; makes no allow/deny decision of its own.",
    reason: "Informational role read for policy computation, not a gate.",
    tenantBinding: "teamId_userId",
    revocation: "n/a (informational)",
  },
];

export type AuthorizationMigrationSeverity =
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW";

export type PendingAuthorizationMigration = {
  file: string;
  domain: string;
  severity: AuthorizationMigrationSeverity;
  /** The current insufficient gate (for the ledger). */
  currentGate: string;
  /** The canonical permission the migration should require. */
  plannedPermission: string;
};

/**
 * KNOWN status-blind / capability-blind gates not yet migrated by Phase 1.
 * Each is tracked so the static test's "unclassified gate" set stays empty
 * and removing an entry forces a real migration. CRITICAL entries are
 * migrated first (see CRITICAL-domain work).
 *
 * NOTE: entries are removed as their files are migrated to the canonical
 * primitive (which the static test then detects automatically).
 */
export const PENDING_AUTHORIZATION_MIGRATIONS: ReadonlyArray<PendingAuthorizationMigration> =
  [
    // ---- CRITICAL (migrated first; each entry is removed once its file
    //      routes through the canonical primitive) ----
    //
    // MIGRATED (removed from PENDING; now canonical, detected by the static
    // test): governance-lifecycle.routes.ts, destructive-action-gate.service.ts.
    // MIGRATED (removed from PENDING; now canonical): review-operations.routes.ts
    // (requireReviewerMember/requireAdminMember → authorizeOrFail).
    // MIGRATED (removed from PENDING; now canonical/status-aware):
    // redaction-rbac.service.ts (resolveRedactionRoles is now ACTIVE-only).
    // MIGRATED (removed from PENDING; now canonical, detected by the static
    // test): ai-evidence.routes.ts, ai-case.routes.ts, ai-reviewer.routes.ts,
    // ai-search.routes.ts, ai-operations.routes.ts — all route through
    // authorizeOrFail against the RESOURCE's team (evidence/case/review/run)
    // or the claimed workspace, enforcing ACTIVE membership + org lifecycle +
    // intelligence.read/run capability + anti-enumeration. ai-operations keeps
    // its stricter OWNER/ADMIN role constraint on top of intelligence.run.
    // MIGRATED (removed from PENDING; now canonical): evidence-requests.routes.ts
    // (requireMember → authorizeOrFail; capability-precise per operation).
    //
    // ---- HIGH: ALL MIGRATED (removed from PENDING; now canonical) ----
    //   workflow-intake-links.routes.ts (create/revoke caps + OWNER/ADMIN),
    //   workspace-ai-policy.routes.ts   (intelligence.read / .policy.manage),
    //   automation.routes.ts            (integration.webhook.manage; platform-admin bypass removed),
    //   automation-webhooks.routes.ts   (integration.webhook.manage; platform-admin bypass removed),
    //   integrations.routes.ts          (integration.api_key.manage),
    //   workflow.routes.ts              (evidence.read / workflow.template.manage),
    //   governance.routes.ts + governance-operations.routes.ts (governance.*),
    //   security.routes.ts              (identity.org_policy.read + OWNER/ADMIN).
    // ---- MEDIUM: ALL MIGRATED (removed from PENDING; now canonical) ----
    //   evidence.saved-views.routes.ts (evidence.read; list findMany + role
    //     resolver now ACTIVE-only; team-scoped create → authorizeOrFail),
    //   analytics-operations.routes.ts (intelligence.read; platform-admin bypass removed),
    //   notifications.routes.ts        (notification.delivery.read + org-only + OWNER/ADMIN),
    //   notification-preferences.routes.ts (notification.delivery.read; workspace-scoped, not account-wide),
    //   reliability.routes.ts          (identity.org_policy.read + OWNER/ADMIN),
    //   reviewer-criteria.routes.ts    (review.queue.read + OWNER/ADMIN on mutations).
    // ---- LOW: ALL MIGRATED (removed from PENDING; now canonical) ----
    //   presence.routes.ts             (collaboration.thread.read).
  ];
