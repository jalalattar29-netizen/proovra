/**
 * Phase 2.7X Stage 4 — Organization audit event emitter.
 *
 * Thin writer for `organization_audit_events`. Stage 1 created the
 * table; Stage 4 activates it. Every org-domain mutation MUST call
 * `emitOrgAuditEvent` inside its own transaction so the audit row
 * commits atomically with the underlying change.
 *
 * Hard rules:
 *
 *   - Audit emission is INSIDE the same transaction as the
 *     mutation. If the mutation rolls back, the audit row does
 *     too. We never want an audit-without-effect or an
 *     effect-without-audit.
 *
 *   - `actorUserId` MUST be the calling user. The emitter never
 *     attempts to derive it; the route layer is the source of truth.
 *
 *   - `metadata` MUST NOT contain raw invite tokens, password
 *     hashes, or any secret value. The emitter does not enforce
 *     this — it relies on the route layer to scrub. This is
 *     documented per-event-type below.
 *
 *   - Failures inside the audit write propagate. This phase
 *     deliberately does NOT silently swallow audit failures: an
 *     org mutation without its audit row is unacceptable. Future
 *     phases may add a fallback queue, but Stage 4 fails loud.
 *
 *   - The event_type values are stable strings. Catalog below.
 */

import type { Prisma } from "@prisma/client";

/**
 * Stable catalog of org-domain audit event types. Adding a new
 * event REQUIRES adding it here AND to the route that emits it.
 *
 * The `targetType` convention:
 *   - "organization"            — change to the org row itself
 *   - "organization_membership" — membership-level change
 *   - "organization_invite"     — invite lifecycle event
 */
export const ORG_AUDIT_EVENT_TYPES = [
  "ORG_CREATED",
  "ORG_UPDATED",
  "ORG_MEMBER_INVITED",
  "ORG_MEMBER_ACCEPTED",
  "ORG_MEMBER_ROLE_CHANGED",
  "ORG_MEMBER_REMOVED",
  // Lifecycle Phase 1 (2026-07-16) — self-service leave. Distinct from
  // ORG_MEMBER_REMOVED (admin-initiated) so the governance timeline
  // separates voluntary departure from administrative removal.
  "ORG_MEMBER_LEFT",
  // Lifecycle Phase 6 (2026-07-17) — ownership transfer + organization
  // closure. Transfer is atomic (old owner → ORG_ADMIN, target →
  // ORG_OWNER, billing ownership follows); closure is the request-row
  // state machine (requested/blocked/cancelled/completed).
  "ORG_OWNERSHIP_TRANSFERRED",
  "ORG_CLOSURE_REQUESTED",
  "ORG_CLOSURE_BLOCKED",
  "ORG_CLOSURE_CANCELLED",
  "ORG_CLOSURE_COMPLETED",
  // PHASE 4 §7.6 (2026-07-22) — reversible org suspension lifecycle.
  //   ORG_SUSPENDED: platform operator suspended the org (metadata
  //     carries effect counts + pausedApiCredentialIds — the resume
  //     contract for precise credential re-enablement).
  //   ORG_RESUMED: platform operator resumed the org.
  "ORG_SUSPENDED",
  "ORG_RESUMED",
  // Phase 2.7X Stage 5 — invite lifecycle hardening.
  "ORG_INVITE_REVOKED",
  "ORG_INVITE_RESENT",
  // Phase 2.7X Stage 5 — record rejected accept attempts so the
  // governance timeline shows enumeration / hijack pressure.
  "ORG_INVITE_ACCEPT_REJECTED",
  // Phase B0 — Org governance policy publish events. Today only the
  // retention policy ships; the catalog reserves slots for future
  // governance policies so the audit feed has stable categories.
  "ORG_POLICY_RETENTION_PUBLISHED",
  // Phase 2 — Enterprise activation & provisioning (platform-admin only).
  //   ORG_PLAN_GRANTED: a platform admin granted a billing plan
  //     (ENTERPRISE) to every workspace of an org.
  //   ENTERPRISE_PROVISIONED: a platform admin provisioned a new
  //     enterprise customer (org + owner [+ workspace]).
  "ORG_PLAN_GRANTED",
  "ENTERPRISE_PROVISIONED",
  // Phase 3 — Enterprise Identity: DNS-verified domain ownership lifecycle.
  //   DOMAIN_ADDED:    an org admin registered a domain + received the DNS
  //                    challenge token.
  //   DOMAIN_VERIFIED: the DNS TXT challenge was observed and the domain
  //                    row was marked verified.
  //   DOMAIN_REMOVED:  an org admin removed a domain claim (verified or not).
  "DOMAIN_ADDED",
  "DOMAIN_VERIFIED",
  "DOMAIN_REMOVED",
  // Phase 8 (Enterprise Production Readiness) — SCOPE C. An org admin
  // exported an operational report (members / seats / audit / governance
  // / external-access / download-audit) as CSV. Metadata carries the
  // report name + the exported row count ONLY — never the report body,
  // never member/evidence identities.
  //   ORG_REPORT_EXPORTED:
  //     { report: string, rowCount: number, truncated?: boolean,
  //       eventType?: string | null }
  "ORG_REPORT_EXPORTED",
  // Phase 8 (Enterprise Production Readiness) — SCOPE A/B. Bulk org
  // invitation batches (paste, array, or CSV source).
  //   ORG_BULK_INVITATION_STARTED:
  //     { batchId: string, totalRows: number, eligibleRows: number,
  //       source?: "csv" }
  //   ORG_BULK_INVITATION_COMPLETED:
  //     { batchId: string, totalRows: number, source?: "csv",
  //       ...per-outcome counts (INVITED / DUPLICATE / ... / FAILED) }
  //   Individual invites still emit the canonical ORG_MEMBER_INVITED
  //   event, whose metadata carries `bulkBatchId` so the audit timeline
  //   groups a batch AND retains per-invite forensics. (Token NEVER in
  //   metadata.)
  "ORG_BULK_INVITATION_STARTED",
  "ORG_BULK_INVITATION_COMPLETED",
  // Macro-Wave A2 — durable invite delivery. Emitted whenever a delivery
  // retry/resend ROTATES the invite token hash (the previously emailed
  // accept link dies at that instant). Metadata carries ONLY
  // { inviteId, deliveryId, attempt, newExpiresAt } — never a token.
  "ORG_INVITE_DELIVERY_ROTATED",
] as const;

export type OrgAuditEventType = (typeof ORG_AUDIT_EVENT_TYPES)[number];

export type OrgAuditTargetType =
  | "organization"
  | "organization_membership"
  | "organization_invite"
  // Phase 3 — Enterprise Identity: domain-ownership target.
  | "organization_domain";

/**
 * Per-event metadata documentation. Routes building metadata MUST
 * keep these shapes in mind; the audit list endpoint surfaces
 * them to ORG_AUDITOR+ users.
 *
 *   ORG_CREATED:
 *     { name: string, billingOwnerUserId: string | null }
 *   ORG_UPDATED:
 *     { changes: Record<string, { from: unknown, to: unknown }> }
 *   ORG_MEMBER_INVITED:
 *     { inviteId: string, email: string, role: OrgRole,
 *       expiresAt: ISO8601, invitedByUserId: string }
 *     (Token is NEVER in metadata.)
 *   ORG_MEMBER_ACCEPTED:
 *     { inviteId: string, role: OrgRole, acceptedByUserId: string }
 *   ORG_MEMBER_ROLE_CHANGED:
 *     { membershipId: string, targetUserId: string,
 *       oldRole: OrgRole, newRole: OrgRole }
 *   ORG_MEMBER_REMOVED:
 *     { membershipId: string, targetUserId: string,
 *       formerRole: OrgRole }
 *   ORG_INVITE_REVOKED:
 *     { inviteId: string, email: string, role: OrgRole,
 *       revokedByUserId: string }
 *   ORG_INVITE_RESENT:
 *     { inviteId: string, email: string, role: OrgRole,
 *       newExpiresAt: ISO8601, resendCount: number }
 *   ORG_INVITE_ACCEPT_REJECTED:
 *     { reason: "email_mismatch" | "expired" | "revoked"
 *              | "already_accepted" | "not_found",
 *       attemptedByUserId: string | null,
 *       attemptedByEmail: string | null,
 *       inviteId: string | null }
 *     (Token is NEVER in metadata.)
 */

export type EmitOrgAuditEventInput = {
  organizationId: string;
  actorUserId: string | null;
  eventType: OrgAuditEventType;
  targetType: OrgAuditTargetType;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

/**
 * Write a single org audit row inside the caller's transaction.
 *
 * The `tx` parameter accepts both the global `PrismaClient` and
 * an interactive transaction client; we type it as the union so
 * mutation routes can call this from either context. In practice
 * mutation routes always use a transaction.
 */
export async function emitOrgAuditEvent(
  tx: Prisma.TransactionClient,
  input: EmitOrgAuditEventInput,
): Promise<void> {
  await tx.organizationAuditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? null,
      eventType: input.eventType,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      ...(input.metadata !== undefined && input.metadata !== null
        ? { metadata: input.metadata }
        : {}),
    },
  });
}
