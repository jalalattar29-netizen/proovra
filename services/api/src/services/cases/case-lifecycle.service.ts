/**
 * Phase 32.8D — Matter Workspace lifecycle actions.
 *
 * Permission-gated writes for the Matter Workspace mutations:
 *   - changeCaseStatus
 *   - addCaseAssignment
 *   - removeCaseAssignment
 *   - addCaseComment
 *   - resolveCaseComment
 *   - addEvidenceLink
 *   - removeEvidenceLink
 *
 * Hard rules:
 *   - Active legal hold blocks transitions to CLOSED or ARCHIVED.
 *   - Every action writes an audit log row via appendPlatformAuditLog
 *     AND a CaseStatusHistory row where applicable.
 *   - No bypass of underlying governance/report/package permissions.
 *   - Bounded operator-safe strings.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

export type CaseErrorCode =
  | "case_not_found"
  | "invalid_transition"
  | "active_legal_hold_blocks_closure"
  | "evidence_not_found"
  | "evidence_link_exists"
  | "assignment_exists"
  | "assignment_not_found"
  | "comment_not_found"
  // Phase CASES-PERSONAL-UX-CLEANUP — comment delete is allowed only
  // when the actor is the comment's author. Backend returns
  // `comment_forbidden` so the route can map it to 403.
  | "comment_forbidden"
  | "invalid_assignee";

export class CaseError extends Error {
  code: CaseErrorCode;
  constructor(code: CaseErrorCode) {
    super(code);
    this.code = code;
  }
}

export type CaseActorContext = {
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

// Phase CASES-STATUS-MANUAL — case status is now treated as plain
// organizational metadata for Personal / Small-Business users: a
// label for filtering, badges, and visual grouping. It is NOT a
// workflow state machine. The Settings tab exposes ONE dropdown
// that lets the user pick any status from any other status. The
// table below therefore allows every transition (any → any), with
// the single exception that a no-op self-transition still falls
// through to the existing equality guard in changeCaseStatus.
//
// What stays unchanged:
//   - `cases.status_changed` audit event still fires on every
//     transition (no parallel logging path).
//   - `cases.restored` audit event still fires on ARCHIVED → OPEN
//     for analytics back-compat (consumers count restores).
//   - `CLOSURE_STATUSES` legal-hold guard still rejects ANY
//     transition INTO CLOSED or ARCHIVED while an active legal hold
//     exists. Legal hold is a real constraint, not a workflow rule.
//   - The closure cascade body (deactivate ACTIVE assignments on
//     transition INTO CLOSED/ARCHIVED) still runs.
const STATUS_VALUES = [
  "OPEN",
  "INVESTIGATING",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
  "ARCHIVED",
] as const;

const ALLOWED_TRANSITIONS: Record<string, string[]> = Object.fromEntries(
  STATUS_VALUES.map((from) => [
    from,
    STATUS_VALUES.filter((to) => to !== from),
  ]),
);

function transitionAllowed(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

const CLOSURE_STATUSES = new Set(["CLOSED", "ARCHIVED"]);

export type ChangeCaseStatusInput = CaseActorContext & {
  caseId: string;
  toStatus: string;
  reason?: string | null;
};

export async function changeCaseStatus(
  input: ChangeCaseStatusInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.Case> {
  const existing = await client.case.findUnique({
    where: { id: input.caseId },
    select: {
      id: true,
      teamId: true,
      status: true,
    },
  });
  if (!existing) throw new CaseError("case_not_found");
  const from = String(existing.status);
  if (!transitionAllowed(from, input.toStatus)) {
    throw new CaseError("invalid_transition");
  }

  // Preservation invariant: active legal hold blocks CLOSED/ARCHIVED.
  if (CLOSURE_STATUSES.has(input.toStatus)) {
    const activeHold = await client.caseLegalHold.count({
      where: { caseId: existing.id, status: "ACTIVE" },
    });
    if (activeHold > 0) {
      throw new CaseError("active_legal_hold_blocks_closure");
    }
  }

  const closedAtUtc = input.toStatus === "CLOSED" ? new Date() : null;
  const closureReason = input.toStatus === "CLOSED" ? input.reason ?? null : null;

  const updated = await client.case.update({
    where: { id: existing.id },
    data: {
      status: input.toStatus as prismaPkg.CaseStatus,
      ...(closedAtUtc ? { closedAtUtc } : {}),
      ...(closureReason !== null && input.toStatus === "CLOSED"
        ? { closureReason: closureReason ? closureReason.slice(0, 400) : null }
        : {}),
    },
  });
  try {
    await client.caseStatusHistory.create({
      data: {
        teamId: existing.teamId,
        caseId: existing.id,
        fromStatus: from as prismaPkg.CaseStatus,
        toStatus: input.toStatus as prismaPkg.CaseStatus,
        changedByUserId: input.actorUserId,
        reason: input.reason ? input.reason.slice(0, 400) : null,
      },
    });
  } catch {
    /* best-effort */
  }

  // Phase 2.4 — Closure cascade.
  //
  // When a case transitions to CLOSED or ARCHIVED, all currently
  // ACTIVE assignments must be deactivated. Without this cascade a
  // closed case still appears in reviewers' personal queues and
  // permission gates that key off "assignment.status === ACTIVE"
  // misreport access. The pre-Phase-2.4 behavior left assignments
  // active indefinitely, which is the root cause of the
  // "I see this closed case in my queue" bug class.
  //
  // We DO NOT touch:
  //   - The Case row itself (already updated above).
  //   - Evidence links — closed cases keep their evidence association
  //     because the audit trail must remain intact.
  //   - Comments — historical comments stay readable. New comments
  //     are blocked at the route layer when the case is in a closure
  //     state, not here.
  //
  // The cascade is best-effort: if it fails (extremely unlikely; this
  // is a single updateMany), we log a critical audit row but do not
  // roll back the status change. The next read of the assignments
  // list still surfaces the inconsistency; an operator can manually
  // remove residual assignments.
  let cascadedAssignmentCount = 0;
  if (CLOSURE_STATUSES.has(input.toStatus)) {
    try {
      const cascade = await client.caseAssignment.updateMany({
        where: { caseId: existing.id, status: "ACTIVE" },
        data: {
          status: "REMOVED",
          removedAtUtc: new Date(),
          removedByUserId: input.actorUserId,
        },
      });
      cascadedAssignmentCount = cascade.count;
    } catch {
      /* best-effort — captured in the audit metadata below */
      cascadedAssignmentCount = -1;
    }
  }

  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.status_changed",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "case",
    resourceId: existing.id,
    metadata: {
      teamId: existing.teamId,
      fromStatus: from,
      toStatus: input.toStatus,
      // Phase 2.4 — surface the cascade for SOC + audit consumers.
      // `-1` indicates the cascade failed; `0` indicates no
      // assignments existed to cascade.
      cascadedAssignmentCount,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });

  // Phase CASE-ARCHIVE-RESTORE — dedicated `cases.restored` audit
  // event on the restore transition (ARCHIVED → OPEN). Emitted in
  // addition to the canonical `cases.status_changed` row so:
  //   - Audit consumers that count `cases.status_changed` for
  //     analytics keep working (back-compat).
  //   - A targeted query for `action: "cases.restored"` surfaces
  //     ONLY restorations without scanning every status mutation
  //     for the `fromStatus === "ARCHIVED"` predicate.
  // Same `appendPlatformAuditLog` infrastructure — no parallel
  // logging system, no schema change.
  // Phase CASES-PERSONAL-UX-CLEANUP — restore target is now OPEN
  // (was CLOSED). The trigger condition is updated accordingly.
  if (from === "ARCHIVED" && input.toStatus === "OPEN") {
    await appendPlatformAuditLog({
      userId: input.actorUserId,
      action: "cases.restored",
      category: "cases.lifecycle",
      severity: "info",
      source: "case_lifecycle_service",
      outcome: "success",
      resourceType: "case",
      resourceId: existing.id,
      metadata: {
        teamId: existing.teamId,
        caseId: existing.id,
        actorUserId: input.actorUserId,
        previousStatus: from,
        restoredStatus: input.toStatus,
        reason: input.reason ? input.reason.slice(0, 400) : null,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      db: client,
    });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export type AddCaseAssignmentInput = CaseActorContext & {
  caseId: string;
  assignedToUserId: string;
  role: "OWNER" | "INVESTIGATOR" | "REVIEWER" | "GOVERNANCE" | "OBSERVER";
  note?: string | null;
};

export async function addCaseAssignment(
  input: AddCaseAssignmentInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CaseAssignment> {
  const existing = await client.case.findUnique({
    where: { id: input.caseId },
    select: { id: true, teamId: true },
  });
  if (!existing) throw new CaseError("case_not_found");

  // Enforce workspace membership when on a team workspace.
  if (existing.teamId) {
    const member = await client.teamMember.findFirst({
      where: {
        teamId: existing.teamId,
        userId: input.assignedToUserId,
      },
      select: { id: true },
    });
    if (!member) throw new CaseError("invalid_assignee");
  }

  // Idempotent on (caseId, assignedToUserId, role). If a REMOVED row
  // exists, reactivate it; otherwise create.
  const existingAssignment = await client.caseAssignment.findFirst({
    where: {
      caseId: existing.id,
      assignedToUserId: input.assignedToUserId,
      role: input.role as prismaPkg.CaseAssignmentRole,
    },
  });
  let row: prismaPkg.CaseAssignment;
  if (existingAssignment) {
    if (existingAssignment.status === "ACTIVE") {
      throw new CaseError("assignment_exists");
    }
    row = await client.caseAssignment.update({
      where: { id: existingAssignment.id },
      data: {
        status: "ACTIVE",
        assignedAtUtc: new Date(),
        assignedByUserId: input.actorUserId,
        removedAtUtc: null,
        removedByUserId: null,
        note: input.note ? input.note.slice(0, 400) : null,
      },
    });
  } else {
    row = await client.caseAssignment.create({
      data: {
        teamId: existing.teamId,
        caseId: existing.id,
        assignedToUserId: input.assignedToUserId,
        assignedByUserId: input.actorUserId,
        role: input.role as prismaPkg.CaseAssignmentRole,
        status: "ACTIVE",
        note: input.note ? input.note.slice(0, 400) : null,
      },
    });
  }
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.assignment_added",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "case_assignment",
    resourceId: row.id,
    metadata: {
      teamId: existing.teamId,
      caseId: existing.id,
      assignedToUserId: input.assignedToUserId,
      role: input.role,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return row;
}

export async function removeCaseAssignment(
  input: CaseActorContext & { caseId: string; assignmentId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CaseAssignment> {
  const existing = await client.caseAssignment.findFirst({
    where: { id: input.assignmentId, caseId: input.caseId },
  });
  if (!existing) throw new CaseError("assignment_not_found");
  const row = await client.caseAssignment.update({
    where: { id: existing.id },
    data: {
      status: "REMOVED",
      removedAtUtc: new Date(),
      removedByUserId: input.actorUserId,
    },
  });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.assignment_removed",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "case_assignment",
    resourceId: row.id,
    metadata: {
      teamId: existing.teamId,
      caseId: input.caseId,
      assignedToUserId: existing.assignedToUserId,
      role: existing.role,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export type AddCaseCommentInput = CaseActorContext & {
  caseId: string;
  body: string;
  visibility?: "INTERNAL" | "REVIEWERS" | "ALL_MEMBERS";
};

export async function addCaseComment(
  input: AddCaseCommentInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CaseComment> {
  const existing = await client.case.findUnique({
    where: { id: input.caseId },
    select: { id: true, teamId: true },
  });
  if (!existing) throw new CaseError("case_not_found");
  const row = await client.caseComment.create({
    data: {
      teamId: existing.teamId ?? input.actorUserId, // teamId is required on schema
      caseId: existing.id,
      authorUserId: input.actorUserId,
      body: input.body.slice(0, 4000),
      visibility: (input.visibility ??
        "REVIEWERS") as prismaPkg.CaseCommentVisibility,
    },
  });

  // Phase SEARCH-REMEDIATION-2 — index this note immediately so it
  // becomes searchable (and contributes to its parent case's
  // searchable text via the case indexer's note-snippet block).
  // Best-effort: indexNote swallows its own errors. We also re-run
  // the case indexer so a "search Acme depot" query that should
  // match a comment body on the Acme case keeps working.
  if (existing.teamId) {
    void (async () => {
      try {
        const { indexNote } = await import(
          "../search/artifact-indexing.service.js"
        );
        await indexNote({ noteId: row.id }, client);
      } catch {
        /* best-effort */
      }
      try {
        const { indexCase } = await import("../search/case-indexing.service.js");
        await indexCase(
          { teamId: existing.teamId!, caseId: existing.id },
          client,
        );
      } catch {
        /* best-effort */
      }
    })();
  }
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.comment_added",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "case_comment",
    resourceId: row.id,
    metadata: {
      teamId: existing.teamId,
      caseId: existing.id,
      visibility: row.visibility,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return row;
}

/**
 * Phase CASES-PERSONAL-UX-CLEANUP — author-only delete of a case
 * comment ("note"). Personal / Small-Business users need to be
 * able to remove a note they themselves wrote; per the spec we do
 * NOT introduce enterprise moderation (no admin override, no
 * reviewer-resolve flow). The author predicate is enforced here
 * regardless of any workspace role the actor holds.
 *
 * The row is hard-deleted (no `deletedAt` column on
 * `CaseComment`) so there's no audit-tombstone to render. The
 * platform audit log carries the destructive action.
 *
 * Hard rules:
 *   - Only the comment author may delete; everyone else (including
 *     workspace OWNER/ADMIN) gets `comment_forbidden`.
 *   - Returns `comment_not_found` for unknown ids OR ids that
 *     belong to a different case (anti-enumeration).
 *   - Writes a `cases.comment_deleted` audit log row with the
 *     existing `appendPlatformAuditLog` infrastructure.
 *   - Touches NO evidence / report / package / custody / retention
 *     fields.
 */
export async function deleteCaseComment(
  input: CaseActorContext & { caseId: string; commentId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ removed: true; commentId: string }> {
  const existing = await client.caseComment.findFirst({
    where: { id: input.commentId, caseId: input.caseId },
  });
  if (!existing) throw new CaseError("comment_not_found");
  if (existing.authorUserId !== input.actorUserId) {
    throw new CaseError("comment_forbidden");
  }
  await client.caseComment.delete({ where: { id: existing.id } });

  // Phase SEARCH-REMEDIATION-2 — drop the NOTE projection and
  // re-index the parent case so its note-snippet block no longer
  // contains the deleted body.
  if (existing.teamId) {
    void (async () => {
      try {
        await client.evidenceSearchDocument.deleteMany({
          where: {
            teamId: existing.teamId!,
            documentType: "NOTE",
            sourceId: existing.id,
          },
        });
      } catch {
        /* best-effort */
      }
      try {
        const { indexCase } = await import("../search/case-indexing.service.js");
        await indexCase(
          { teamId: existing.teamId!, caseId: existing.caseId },
          client,
        );
      } catch {
        /* best-effort */
      }
    })();
  }

  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.comment_deleted",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "case_comment",
    resourceId: existing.id,
    metadata: {
      teamId: existing.teamId,
      caseId: input.caseId,
      authorUserId: existing.authorUserId,
      visibility: existing.visibility,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return { removed: true, commentId: existing.id };
}

export async function resolveCaseComment(
  input: CaseActorContext & { caseId: string; commentId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CaseComment> {
  const existing = await client.caseComment.findFirst({
    where: { id: input.commentId, caseId: input.caseId },
  });
  if (!existing) throw new CaseError("comment_not_found");
  const row = await client.caseComment.update({
    where: { id: existing.id },
    data: {
      resolvedAtUtc: new Date(),
      resolvedByUserId: input.actorUserId,
    },
  });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.comment_resolved",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "case_comment",
    resourceId: row.id,
    metadata: {
      teamId: existing.teamId,
      caseId: input.caseId,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Evidence links
// ---------------------------------------------------------------------------

export type AddEvidenceLinkInput = CaseActorContext & {
  caseId: string;
  evidenceId: string;
  role?: "PRIMARY" | "SUPPORTING" | "RELATED" | "DUPLICATE" | "DERIVED" | "CONTEXT";
  reason?: string | null;
};

export async function addEvidenceLink(
  input: AddEvidenceLinkInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CaseEvidenceLink> {
  const existing = await client.case.findUnique({
    where: { id: input.caseId },
    select: { id: true, teamId: true },
  });
  if (!existing) throw new CaseError("case_not_found");
  const evidence = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, teamId: true },
  });
  if (!evidence) throw new CaseError("evidence_not_found");
  // Cross-workspace check: evidence must be in the same team workspace.
  if (existing.teamId && evidence.teamId !== existing.teamId) {
    throw new CaseError("evidence_not_found");
  }

  const role = (input.role ?? "SUPPORTING") as prismaPkg.CaseEvidenceLinkRole;
  // Idempotent on the unique (caseId, evidenceId, role).
  const existingLink = await client.caseEvidenceLink.findUnique({
    where: {
      caseId_evidenceId_role: {
        caseId: existing.id,
        evidenceId: input.evidenceId,
        role,
      },
    },
  });
  if (existingLink) throw new CaseError("evidence_link_exists");
  const row = await client.caseEvidenceLink.create({
    data: {
      teamId: existing.teamId ?? "",
      caseId: existing.id,
      evidenceId: input.evidenceId,
      role,
      source: "USER",
      linkedByUserId: input.actorUserId,
      reason: input.reason ? input.reason.slice(0, 400) : null,
    },
  });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.evidence_linked",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "case_evidence_link",
    resourceId: row.id,
    metadata: {
      teamId: existing.teamId,
      caseId: existing.id,
      evidenceId: input.evidenceId,
      role,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return row;
}

export async function removeEvidenceLink(
  input: CaseActorContext & { caseId: string; linkId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ removed: true }> {
  const existing = await client.caseEvidenceLink.findFirst({
    where: { id: input.linkId, caseId: input.caseId },
  });
  if (!existing) throw new CaseError("evidence_not_found");
  await client.caseEvidenceLink.delete({ where: { id: existing.id } });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.evidence_unlinked",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "case_evidence_link",
    resourceId: existing.id,
    metadata: {
      teamId: existing.teamId,
      caseId: input.caseId,
      evidenceId: existing.evidenceId,
      role: existing.role,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return { removed: true };
}

/**
 * Phase 32.8D-frontend-closure-2 — Audited unlink of a legacy
 * `Evidence.caseId` attachment that has no `CaseEvidenceLink` row.
 *
 *   - Reads the Evidence row. If `evidence.caseId !== caseId`, throws
 *     `evidence_not_found` so callers receive a 404.
 *   - Sets `Evidence.caseId = null` without touching any other field.
 *     The evidence record (and its bytes / metadata) is preserved.
 *   - Writes a platform audit log with action
 *     `cases.legacy_evidence_unlinked` and explicit metadata.
 *   - Does NOT emit custody / download events.
 *   - Does NOT generate reports or packages.
 *   - Does NOT regenerate signed URLs.
 */
export async function removeLegacyEvidenceCaseId(
  input: CaseActorContext & { caseId: string; evidenceId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ unlinked: true; evidenceId: string }> {
  const evidence = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, caseId: true, teamId: true, ownerUserId: true },
  });
  if (!evidence || evidence.caseId !== input.caseId) {
    throw new CaseError("evidence_not_found");
  }
  // Also refuse if a canonical CaseEvidenceLink row exists — the
  // canonical unlink route handles that path. This route is strictly
  // for evidence attached only via the legacy caseId column.
  const canonical = await client.caseEvidenceLink.findFirst({
    where: { caseId: input.caseId, evidenceId: input.evidenceId },
    select: { id: true },
  });
  if (canonical) {
    throw new CaseError("evidence_link_exists");
  }
  await client.evidence.update({
    where: { id: evidence.id },
    data: { caseId: null },
  });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "cases.legacy_evidence_unlinked",
    category: "cases.lifecycle",
    severity: "info",
    source: "case_lifecycle_service",
    outcome: "success",
    resourceType: "evidence",
    resourceId: evidence.id,
    metadata: {
      teamId: evidence.teamId,
      caseId: input.caseId,
      evidenceId: evidence.id,
      attachmentKind: "legacy_case_id",
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return { unlinked: true, evidenceId: evidence.id };
}
