/**
 * THE CANONICAL EVIDENCE LIFECYCLE MUTATION SERVICE.
 *
 * One implementation of archive / unarchive / trash / restore-from-trash.
 * `POST /v1/evidence/:id/archive`, `/unarchive`, `DELETE /v1/evidence/:id`,
 * `POST /v1/evidence/:id/restore` and every branch of `POST /v1/evidence/bulk`
 * call THIS — single and bulk therefore agree by construction rather than by
 * two developers keeping four pairs of guards in step, which is what the
 * pre-convergence code asked of them and did not get:
 *
 *   * single trash ran `assertEvidenceDeletionAllowedByRetention`, bulk trash
 *     ran it too, but bulk RESTORE_ARCHIVED skipped the governance gate that
 *     bulk ARCHIVE ran;
 *   * single restore-from-trash authorized on `evidence.ownerUserId === actor`
 *     alone — no capability, no membership, no organization lifecycle — while
 *     bulk RESTORE_TRASH went through `evidence.delete`. The workspace member
 *     with the capability was refused and the creator who had lost every
 *     membership was allowed.
 *
 * DECISION AUTHORITY
 * ---------------------------------------------------------------------------
 * This service decides NOTHING about lifecycle state on its own. It gathers
 * facts (the persisted row, the effective legal-hold verdict) and hands them to
 * `computeEvidenceLifecycleCapabilities` in `@proovra/shared`. The capability
 * booleans it returns are the answer; this module's job is to authorize the
 * actor, apply the governance policy gate, write the state, and record custody.
 *
 * WHAT DELIBERATELY NO LONGER BLOCKS SOFT-TRASH
 * ---------------------------------------------------------------------------
 * Application retention (`retentionUntilUtc`) and S3 Object Lock
 * (`storageObjectLockRetainUntilUtc`, COMPLIANCE included) used to refuse the
 * trash action outright, in three separate places. That conflated a
 * RECOVERABLE soft-trash with an IRREVERSIBLE physical destruction and produced
 * the headline defect: a record retained until 2034 told the user it could not
 * be moved to trash for eight years, when moving it to trash deletes nothing
 * and restores intact.
 *
 * Both boundaries are still absolute — they are enforced where they actually
 * apply, in `computeEvidenceDestructionEligibility`, which the canonical
 * destruction executor re-runs immediately before it deletes a byte. Trashing a
 * retained record now yields TRASHED + RETAINED, and the reconciler refuses to
 * destroy it until the boundary passes. Nothing is weakened; the check moved to
 * the operation it actually describes.
 *
 * A LEGAL HOLD still blocks trash. See `trashBlockReason` in the shared
 * authority for why that one is different.
 */

import * as prismaPkg from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import {
  computeEvidenceLifecycleCapabilities,
  type EvidenceLifecycleBlockReason,
  type EvidenceProductState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEventTx } from "../custody-events.service.js";
import { evaluateEffectiveLegalHold } from "../governance/effective-legal-hold.js";
import { resolveEvidenceDestructiveAccess } from "./evidence-destructive-access.service.js";

/**
 * The trash recovery-grace window.
 *
 * ONE definition, and its name says what it is. The same 90 days used to be
 * written as `deleteScheduledForUtc` and read by the purge worker as "delete
 * the bytes at this instant", and the UI said so too. It never meant that: the
 * worker rescheduled itself past retention and Object Lock anyway, so the date
 * shown to users was a deletion promise the system did not keep and could not.
 * It is a RECOVERY boundary — before it passes the record is restorable from
 * trash by an ordinary user; after it passes the record becomes a destruction
 * CANDIDATE, which is a different thing from a destruction.
 */
export const TRASH_GRACE_DAYS = 90;

export type EvidenceLifecycleAction =
  | "ARCHIVE"
  | "UNARCHIVE"
  | "TRASH"
  | "RESTORE_FROM_TRASH";

export type EvidenceLifecycleMutationSource = "single" | "bulk";

export type EvidenceLifecycleMutationInput = {
  evidenceId: string;
  actorUserId: string;
  action: EvidenceLifecycleAction;
  source: EvidenceLifecycleMutationSource;
  /** Request context for custody IP/UA capture. Optional (worker callers). */
  req?: Pick<FastifyRequest, "ip" | "headers">;
  /** Injected clock so a test and a request handler agree. */
  now?: Date;
  client?: PrismaClient;
};

export type EvidenceLifecycleMutationResult =
  | {
      ok: true;
      /** False when the record was ALREADY in the target state (idempotent). */
      changed: boolean;
      productState: EvidenceProductState;
      teamId: string | null;
    }
  | {
      ok: false;
      statusCode: 404 | 409 | 403 | 503;
      code: string;
      message: string;
      /** Present when the refusal came from the canonical authority. */
      blockReason?: EvidenceLifecycleBlockReason;
    };

/**
 * Exactly the columns the authority reads, plus the tenancy needed to authorize
 * and audit. Narrow on purpose: a wide select here would invite a future reader
 * to decide something from a column the authority does not know about.
 */
const LIFECYCLE_SELECT = {
  id: true,
  teamId: true,
  organizationId: true,
  ownerUserId: true,
  lifecycleState: true,
  archivedAt: true,
  deletedAt: true,
  destroyedAtUtc: true,
  lockedAt: true,
  deleteScheduledForUtc: true,
  retentionUntilUtc: true,
  storageObjectLockMode: true,
  storageObjectLockRetainUntilUtc: true,
  caseLinks: { select: { caseId: true } },
} as const;

/** The capability each action needs, against the PERSISTED evidence row. */
const ACTION_PERMISSION = {
  ARCHIVE: "evidence.archive",
  UNARCHIVE: "evidence.archive",
  TRASH: "evidence.delete",
  RESTORE_FROM_TRASH: "evidence.delete",
} as const;

/**
 * Human-readable refusal copy, keyed by the canonical block reason.
 *
 * Deliberately says nothing about retention dates: under the corrected
 * semantics no retention deadline can produce a trash refusal, so copy that
 * mentioned one could only ever be wrong.
 */
const BLOCK_MESSAGE: Record<EvidenceLifecycleBlockReason, string> = {
  ALREADY_IN_STATE: "This record is already in that state.",
  EVIDENCE_LOCKED:
    "This record is permanently locked and its lifecycle cannot be changed.",
  TERMINAL_DESTROYED:
    "This record has been destroyed. Only its tombstone remains.",
  NOT_TRASHED: "This record is not in the trash.",
  TRASH_GRACE_ACTIVE: "The trash recovery period has not finished.",
  APP_RETENTION_ACTIVE: "Workspace retention is still active for this record.",
  OBJECT_LOCK_RETENTION_ACTIVE:
    "Storage retention is still active for this record.",
  LEGAL_HOLD_ACTIVE:
    "This record is under an active legal hold. Its lifecycle cannot be changed while the hold stands.",
  DESTRUCTION_APPROVAL_REQUIRED:
    "An approved destruction request is required for this record.",
};

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function userAgentOf(req: EvidenceLifecycleMutationInput["req"]): string | null {
  const raw = req?.headers?.["user-agent"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

/**
 * Apply ONE lifecycle action to ONE record.
 *
 * The caller is responsible only for mapping the result onto its transport: a
 * route replies with the status code, a bulk loop records the reason against the
 * record id. Neither re-decides anything.
 */
export async function applyEvidenceLifecycleAction(
  input: EvidenceLifecycleMutationInput,
): Promise<EvidenceLifecycleMutationResult> {
  const client = input.client ?? defaultPrisma;
  const now = input.now ?? new Date();

  // 1. AUTHORIZATION — the canonical destructive-access primitive against the
  //    PERSISTED tenancy. Every denial class collapses to one anti-enumeration
  //    404 so a cross-tenant probe cannot distinguish "not yours" from "gone".
  const access = await resolveEvidenceDestructiveAccess(
    {
      userId: input.actorUserId,
      evidenceId: input.evidenceId,
      permission: ACTION_PERMISSION[input.action],
    },
    client,
  );
  if (!access.allowed) {
    return {
      ok: false,
      statusCode: 404,
      code: "not_found",
      message: "Evidence not found",
    };
  }

  const evidence = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: LIFECYCLE_SELECT,
  });
  if (!evidence) {
    return {
      ok: false,
      statusCode: 404,
      code: "not_found",
      message: "Evidence not found",
    };
  }

  // 2. THE EFFECTIVE LEGAL-HOLD VERDICT — the union of the evidence, case and
  //    workspace hold stores, resolved by the ONE evaluator. It FAILS CLOSED:
  //    a transient database error reports "held", never "clear".
  let legalHold: boolean;
  try {
    const verdict = await evaluateEffectiveLegalHold(client, {
      teamId: evidence.teamId ?? null,
      evidenceId: evidence.id,
      caseIds: (evidence.caseLinks ?? []).map((l) => l.caseId),
    });
    legalHold = verdict.held;
  } catch {
    return {
      ok: false,
      statusCode: 503,
      code: "GOVERNANCE_CHECK_FAILED",
      message:
        "Legal-hold status could not be confirmed, so the lifecycle change was refused.",
    };
  }

  // 3. THE CANONICAL CAPABILITY PROJECTION. Nothing below re-derives it.
  const caps = computeEvidenceLifecycleCapabilities(
    {
      lifecycleState: evidence.lifecycleState,
      archivedAt: evidence.archivedAt,
      trashedAt: evidence.deletedAt,
      destroyedAt: evidence.destroyedAtUtc,
      lockedAt: evidence.lockedAt,
      trashGraceUntil: evidence.deleteScheduledForUtc,
      appRetentionUntil: evidence.retentionUntilUtc,
      objectLockRetainUntil: evidence.storageObjectLockRetainUntilUtc,
      objectLockMode: evidence.storageObjectLockMode,
      legalHold,
    },
    now,
  );

  // 4. IDEMPOTENCE, BEFORE the capability refusal.
  //
  //    Re-running an action over a mixed selection is ordinary bulk behaviour,
  //    and a record that is already where the caller wants it is a success with
  //    nothing to do — not a 409, and definitely not a second write that
  //    re-stamps the lifecycle time at which it ACTUALLY happened. The
  //    pre-convergence single routes returned 200 here while the bulk branches
  //    threw "ALREADY_ARCHIVED"; the disagreement is resolved in favour of the
  //    idempotent reading, reported honestly as `changed: false`.
  const already =
    (input.action === "ARCHIVE" && caps.productState === "ARCHIVED") ||
    (input.action === "UNARCHIVE" && caps.productState === "ACTIVE") ||
    (input.action === "TRASH" && caps.productState === "TRASHED") ||
    (input.action === "RESTORE_FROM_TRASH" && caps.productState === "ACTIVE");
  if (already) {
    return {
      ok: true,
      changed: false,
      productState: caps.productState,
      teamId: evidence.teamId ?? null,
    };
  }

  // 5. THE CAPABILITY GATE.
  const permitted =
    input.action === "ARCHIVE"
      ? caps.canArchive
      : input.action === "UNARCHIVE"
        ? caps.canUnarchive
        : input.action === "TRASH"
          ? caps.canTrash
          : caps.canRestoreFromTrash;

  if (!permitted) {
    const reason: EvidenceLifecycleBlockReason =
      caps.productState === "DESTROYED"
        ? "TERMINAL_DESTROYED"
        : input.action === "TRASH"
          ? (caps.trashBlockReason ?? "ALREADY_IN_STATE")
          : evidence.lockedAt
            ? "EVIDENCE_LOCKED"
            : input.action === "RESTORE_FROM_TRASH"
              ? "NOT_TRASHED"
              : "ALREADY_IN_STATE";
    return {
      ok: false,
      statusCode: 409,
      code: reason,
      message: BLOCK_MESSAGE[reason],
      blockReason: reason,
    };
  }

  // 6. WORKSPACE GOVERNANCE POLICY — the same gate the single routes ran, now
  //    also covering the bulk branches that never had it. Personal-scope
  //    records short-circuit inside the gate.
  if (input.action === "ARCHIVE" || input.action === "TRASH") {
    const { runDestructiveActionGate } = await import(
      "../governance/destructive-action-gate.service.js"
    );
    const gate = await runDestructiveActionGate(
      {
        action:
          input.action === "ARCHIVE" ? "archive_evidence" : "delete_evidence",
        actorUserId: input.actorUserId,
        evidence: {
          id: evidence.id,
          teamId: evidence.teamId,
          retentionUntilUtc: evidence.retentionUntilUtc ?? null,
        },
        routeLabel: input.action === "ARCHIVE" ? "archive" : "delete",
        req: input.req,
      },
      client,
    );
    if (gate.gated) {
      return {
        ok: false,
        statusCode: gate.statusCode,
        code: gate.body.code,
        message: gate.body.message,
      };
    }
  }

  // 7. THE WRITE. State pointer, event timestamps and custody event in ONE
  //    transaction — a lifecycle change that is half-recorded is worse than one
  //    that did not happen, because the custody chain is what a reviewer reads.
  const patch = buildLifecyclePatch(input.action, input.actorUserId, now);

  await client.$transaction(async (tx) => {
    await tx.evidence.update({
      where: { id: evidence.id },
      data: patch.data,
    });
    await appendCustodyEventTx(tx, {
      evidenceId: evidence.id,
      eventType: patch.custodyEventType,
      atUtc: now,
      payload: {
        ...patch.custodyPayload(input.actorUserId, now),
        source: input.source,
      } as prismaPkg.Prisma.InputJsonValue,
      ip: input.req?.ip ?? null,
      userAgent: userAgentOf(input.req),
    });
  });

  return {
    ok: true,
    changed: true,
    productState: patch.productState,
    teamId: evidence.teamId ?? null,
  };
}

type LifecyclePatch = {
  data: prismaPkg.Prisma.EvidenceUpdateInput;
  custodyEventType: prismaPkg.CustodyEventType;
  custodyPayload: (actorUserId: string, now: Date) => Record<string, unknown>;
  productState: EvidenceProductState;
};

/**
 * The state pointer and the event timestamps, written TOGETHER.
 *
 * `lifecycle_state` is the authority; `archived_at` / `deleted_at` are the
 * record of WHEN. Writing one without the other is exactly what let the two
 * disagree, so there is one place that produces the pair and no other.
 */
function buildLifecyclePatch(
  action: EvidenceLifecycleAction,
  actorUserId: string,
  now: Date,
): LifecyclePatch {
  switch (action) {
    case "ARCHIVE":
      return {
        data: { lifecycleState: "ARCHIVED", archivedAt: now },
        custodyEventType: prismaPkg.CustodyEventType.EVIDENCE_ARCHIVED,
        custodyPayload: (uid) => ({ archivedByUserId: uid }),
        productState: "ARCHIVED",
      };
    case "UNARCHIVE":
      return {
        data: { lifecycleState: "ACTIVE", archivedAt: null },
        custodyEventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
        custodyPayload: (uid) => ({
          restoredByUserId: uid,
          restoreSource: "archive",
        }),
        productState: "ACTIVE",
      };
    case "TRASH": {
      const trashGraceUntil = addDays(now, TRASH_GRACE_DAYS);
      return {
        data: {
          lifecycleState: "TRASHED",
          deletedAt: now,
          deletedAtUtc: now,
          deletedByUserId: actorUserId,
          // The 90-day value, under its true meaning. The column keeps its
          // legacy name — renaming it would touch every migration, index and
          // consumer for no behavioural gain — but nothing reads it as a
          // deletion instant any more.
          deleteScheduledForUtc: trashGraceUntil,
        },
        custodyEventType: prismaPkg.CustodyEventType.EVIDENCE_DELETE_SCHEDULED,
        custodyPayload: (uid, at) => ({
          deletedByUserId: uid,
          deletedAtUtc: at.toISOString(),
          trashGraceUntilUtc: trashGraceUntil.toISOString(),
        }),
        productState: "TRASHED",
      };
    }
    case "RESTORE_FROM_TRASH":
      return {
        data: {
          lifecycleState: "ACTIVE",
          deletedAt: null,
          deletedAtUtc: null,
          deletedByUserId: null,
          deleteScheduledForUtc: null,
        },
        custodyEventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
        custodyPayload: (uid) => ({
          restoredByUserId: uid,
          restoreSource: "trash",
        }),
        productState: "ACTIVE",
      };
  }
}
