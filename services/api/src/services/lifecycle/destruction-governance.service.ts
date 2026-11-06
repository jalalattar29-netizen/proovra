/**
 * PROOVRA Phase 4B — Destruction Governance Workflow.
 *
 * Dual-approval governed destruction with cryptographically signed
 * certificates. Every transition is workspace-anchored, emits a
 * bounded lifecycle event, and is gated by the canonical legal-hold
 * preservation check.
 *
 * State machine:
 *   REQUESTED → APPROVED → EXECUTING → COMPLETED → CERTIFIED
 *               ↘ REJECTED      ↘ FAILED (resumable)
 *
 * Hard rules:
 *   * Workspace-anchored on `teamId`.
 *   * Legal-hold check is run twice: at request time (gate) and at
 *     execute time (defence in depth) — a hold placed between request
 *     and execute MUST block destruction.
 *   * Every record named by a request belongs to the request's workspace,
 *     checked at create, approve and execute (GOV-001). One that does not is
 *     the same concealed 404 as one that does not exist, and the executor
 *     re-decides it independently.
 *   * Two people (GOV-003): the requester is never an approver, every listed
 *     approver is checked to hold `governance.destruction.approve`, and with
 *     two or more listed, all of them must approve.
 *   * The destruction certificate is immutable: an append-only row holding the
 *     signed artifact. Its hash binds the requestId, the records whose deletion
 *     was verified, the exceptions, the executed-at timestamp and the approval
 *     chain. The version string is part of the body so the hash is
 *     forward-compatible.
 *   * Bounded vocabulary on lifecycle events (DESTRUCTION_LIFECYCLE_CODES).
 *   * Webhook emission + lifecycle event emission are best-effort —
 *     they MUST NEVER unwind a state transition.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

import {
  assertDestructionCertificateSignerReady,
  signDestructionCertificateHash,
} from "../../signing/destruction-certificate-signer.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DESTRUCTION_LIFECYCLE_CODES,
  type DestructionCertificateProjection,
  type DestructionLifecycleCode,
  type DestructionRequestProjection,
  type DestructionState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { conflictRefusal, DomainError, inputRefusal, notFoundRefusal } from "../../errors.js";
import {
  isUnderLegalHold,
  assertNoLegalHoldOrBlock,
} from "./legal-hold.service.js";
import { emitWebhookEvent } from "../integrations/webhook-dispatcher.js";
import { putObjectBuffer, getObjectStream } from "../../storage.js";
// EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — `deleteObject` is no longer
// imported here. This service does not delete storage objects; the ONE
// canonical executor does, and only after it can verify the deletion.
import {
  destructionExecutionEnabled,
  executeEvidenceDestruction,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";
import { apiEvidenceDestructionStorage } from "../evidence/destruction-storage-port.js";
import { evaluateEffectiveLegalHold, evidenceVisibleThroughCasesWhere } from "@proovra/shared-runtime";
import { evaluateMemberAccess } from "../identity/access-policy.service.js";
import { readDestructionBarriers } from "../governance-lifecycle/destruction-barriers.service.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// PHASE 6 §9.5 (2026-07-22) — V2 binds the policy decision-context
// snapshot into the hashed certificate body (retention policy versions +
// legal-hold-cleared-at-execute). V1 certificates remain valid under
// their own version; the version string discriminates the hashed shape.
//
// GOV-009 (2026-11-01) — V3 certifies what was VERIFIED, not what was asked for:
// the evidence hash and count cover verified records only, exceptions are listed,
// and the artifact carries the exact hashed body so the hash can be recomputed.
const CERTIFICATE_VERSION = "PROOVRA_DESTRUCTION_CERT_V3" as const;
const REASON_MAX = 600;
/** How long EXECUTING may stand before the request counts as abandoned. */
const EXECUTION_LEASE_MS = 30 * 60 * 1000;

function getS3Bucket(): string | null {
  const v = process.env.S3_BUCKET;
  if (!v || !v.trim()) return null;
  return v.trim();
}

function certificateSigningSecret(): string | null {
  return (
    process.env.DESTRUCTION_CERT_SIGNING_SECRET ?? process.env.WEBHOOK_SIGNING_SECRET ?? null
  );
}

/**
 * GOV-009 — signing must be possible BEFORE the first byte is deleted. This used
 * to be discovered inside `certifyDestruction`, after the objects were gone.
 */
function assertCertificateSigningAvailable(): void {
  if (certificateSigningSecret()) return;
  if ((process.env.NODE_ENV ?? "").toLowerCase() !== "production") return;
  throw conflictRefusal({
    code: "DESTRUCTION_CERTIFICATE_SIGNING_UNAVAILABLE",
    message:
      "Nothing was destroyed: the destruction certificate cannot be signed on this deployment.",
    developerMessage: "destruction_certificate_signing_secret_missing",
  });
}

async function assertEd25519CertificateSigningAvailable(): Promise<void> {
  try {
    await assertDestructionCertificateSignerReady();
  } catch {
    throw conflictRefusal({
      code: "DESTRUCTION_CERTIFICATE_SIGNING_UNAVAILABLE",
      message:
        "Nothing was destroyed: the destruction certificate cannot be signed on this deployment.",
      developerMessage: "destruction_certificate_ed25519_signer_unavailable",
    });
  }
}

function signatureHmac(payload: string): string {
  const secret = certificateSigningSecret();
  if (!secret) {
    // Fail closed in production: signing a certificate with a public constant
    // would make the certificate's HMAC forgeable. A misconfigured deployment
    // must refuse to sign rather than sign with a known key.
    if ((process.env.NODE_ENV ?? "").toLowerCase() === "production") {
      throw new Error(
        "DESTRUCTION_CERT_SIGNING_SECRET (or WEBHOOK_SIGNING_SECRET) must be configured to sign a destruction certificate.",
      );
    }
    // Non-production only, so local/test flows still run. The value is named so
    // it can never be mistaken for a real secret.
    return createHmac("sha256", "PROOVRA_DEV_ONLY_CERT_FALLBACK_NOT_FOR_PRODUCTION")
      .update(payload, "utf8")
      .digest("hex");
  }
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function sha256HexBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// -----------------------------------------------------------------------------
// Approver chain shape (stored as JSON in approver_user_ids)
// -----------------------------------------------------------------------------

type ApproverEntry = {
  userId: string;
  approvedAtUtc: string | null;
};

function isApproverEntryArray(value: unknown): value is ApproverEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "userId" in entry &&
        typeof (entry as { userId: unknown }).userId === "string",
    )
  );
}

function readApproverChain(value: unknown): ApproverEntry[] {
  if (!isApproverEntryArray(value)) return [];
  return value.map((e) => ({
    userId: e.userId,
    approvedAtUtc: e.approvedAtUtc ?? null,
  }));
}

function approverChainUserIds(chain: ReadonlyArray<ApproverEntry>): string[] {
  return chain.map((e) => e.userId);
}

// -----------------------------------------------------------------------------
// Canonical-JSON + SHA-256 helpers (local copy — keeps the service
// self-contained and matches the bounded certificate version above)
// -----------------------------------------------------------------------------

function canonicalJsonValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonical: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonValue(v)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonValue(obj[k])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical: unsupported type ${t}`);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function hashSortedEvidenceIds(evidenceIds: ReadonlyArray<string>): string {
  const sorted = [...evidenceIds].sort();
  return sha256Hex(canonicalJsonValue(sorted));
}

// -----------------------------------------------------------------------------
// Legal-hold gate (defence in depth wrapper)
// -----------------------------------------------------------------------------

async function checkLegalHoldBlocks(
  prisma: PrismaClient,
  evidenceIds: ReadonlyArray<string>,
  teamId: string,
): Promise<{ ok: true } | { ok: false; holdIds: string[] }> {
  // holdIds named the blocked RECORDS, so the refusal could not say which hold to
  // release. A hold state that cannot be read has no id and still blocks.
  let held = false;
  const holdIds = new Set<string>();
  for (const evidenceId of evidenceIds) {
    // An unreadable hold state blocks (GOV-013): this gate used to read a failed
    // lookup as "not held", the opposite of every other hold check.
    const result = await isUnderLegalHold({
      prisma,
      teamId,
      evidenceId,
    }).catch(() => ({ underHold: true, holdIds: [], sources: [] as Array<"4A" | "4B"> }));
    if (result.underHold) {
      held = true;
      for (const id of result.holdIds) holdIds.add(id);
    }
  }
  if (!held) return { ok: true };
  return { ok: false, holdIds: [...holdIds] };
}

// -----------------------------------------------------------------------------
// Lifecycle + webhook emitters (best-effort, never throw upward)
// -----------------------------------------------------------------------------

async function emitDestructionLifecycle(
  prisma: PrismaClient,
  code: DestructionLifecycleCode,
  payload: {
    teamId: string;
    requestId: string;
    actorUserId?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  if (!(DESTRUCTION_LIFECYCLE_CODES as ReadonlyArray<string>).includes(code)) {
    return;
  }
  // Bounded lifecycle audit. Schema mirrors intelligence-activity but is
  // optional — the calling state transition has already committed.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).intelligenceActivityEvent
      .create({
        data: {
          teamId: payload.teamId,
          category: "LIFECYCLE",
          code,
          actorUserId: payload.actorUserId ?? null,
          targetType: "DESTRUCTION_REQUEST",
          targetId: payload.requestId,
          reason: payload.reason?.slice(0, 200) ?? null,
          payload: null as never,
        },
      })
      .catch(() => null);
  } catch {
    /* swallow */
  }
}

async function emitDestructionWebhook(
  prisma: PrismaClient,
  code: DestructionLifecycleCode,
  body: {
    teamId: string;
    requestId: string;
    state: DestructionState;
  },
): Promise<void> {
  // Phase 4B webhook event kinds are not in the legacy
  // `WebhookEventType` union (which is the v1 set). Producers cast at
  // the boundary; the dispatcher is tolerant of unknown event types
  // (no endpoint subscribes to them by default and `emitWebhookEvent`
  // already swallows lookup misses).
  try {
    await emitWebhookEvent(
      {
        teamId: body.teamId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventType: code as any,
        payload: {
          requestId: body.requestId,
          state: body.state,
        },
      },
      prisma,
    ).catch(() => undefined);
  } catch {
    /* swallow */
  }
}

// -----------------------------------------------------------------------------
// Refusals shared by every step
// -----------------------------------------------------------------------------

/**
 * D63 — an id that answers to no request in the caller's workspace. The same
 * 404 whether it does not exist or belongs to another workspace.
 */
function destructionRequestNotFound() {
  return notFoundRefusal({
    code: "DESTRUCTION_REQUEST_NOT_FOUND",
    message: "No destruction request with that id exists in this workspace.",
    developerMessage: "destruction_request_not_found",
  });
}

/**
 * GOV-001 — one answer for "does not exist" and "belongs to someone else", so a
 * request can never be used to learn whether another workspace holds an id.
 */
function destructionEvidenceNotFound() {
  return notFoundRefusal({
    code: "DESTRUCTION_EVIDENCE_NOT_FOUND",
    message: "At least one record in this request does not exist in this workspace.",
    developerMessage: "destruction_evidence_not_in_workspace",
  });
}

function destructionForbidden(code: string, message: string) {
  return new DomainError(code, {
    httpStatus: 403,
    publicCode: code,
    publicMessage: message,
    reportability: "EXPECTED_DENIAL",
    severity: "info",
  });
}

function destructionExecutionDisabled() {
  return conflictRefusal({
    code: "DESTRUCTION_EXECUTION_DISABLED",
    message: "Destruction execution is switched off on this deployment. Nothing was destroyed.",
    developerMessage: "destruction_execution_disabled",
  });
}

function readEvidenceIds(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * GOV-001 — the ONE question: is every id a record of this workspace? Resolved
 * through the canonical workspace population so a Personal workspace's legacy
 * NULL-team records answer the same way as a team's.
 */
async function assertRecordsInWorkspace(
  prisma: PrismaClient,
  teamId: string,
  evidenceIds: ReadonlyArray<string>,
): Promise<void> {
  const unique = [...new Set(evidenceIds)];
  if (unique.length === 0) throw destructionEvidenceNotFound();
  const scope = await workspaceEvidenceWhere(teamId, prisma);
  const found = await prisma.evidence.count({
    where: { AND: [scope], id: { in: unique } },
  });
  if (found !== unique.length) throw destructionEvidenceNotFound();
}

/** Approval signed by every listed person, none of them the requester. */
function chainIsSigned(chain: ReadonlyArray<ApproverEntry>, requestedByUserId: string): boolean {
  return (
    chain.length > 0 &&
    chain.every((e) => e.approvedAtUtc !== null) &&
    !chain.some((e) => e.userId === requestedByUserId)
  );
}

// -----------------------------------------------------------------------------
// createDestructionRequest
// -----------------------------------------------------------------------------

export type CreateDestructionRequestInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceIds: ReadonlyArray<string>;
  reason: string;
  policyRef?: string | null;
  requestedByUserId: string;
  requiredApproverUserIds: ReadonlyArray<string>;
};

export type CreateDestructionRequestResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      denial: "LEGAL_HOLD_BLOCKED" | "POLICY_REJECTED";
      holdIds?: ReadonlyArray<string>;
    };

export async function createDestructionRequest(
  input: CreateDestructionRequestInput,
): Promise<CreateDestructionRequestResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // Policy: require at least one named approver. Dual approval is
  // implicit when the caller supplies >= 2 approver ids.
  if (input.requiredApproverUserIds.length < 1) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.evidenceIds.length < 1) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const evidenceIds = [...new Set(input.evidenceIds)];
  await assertRecordsInWorkspace(prisma, input.teamId, evidenceIds);

  // A request can only ever execute on a record already on its way out; anything
  // else goes through a destruction review. Refused here, not after two people
  // have signed for something that cannot happen.
  const records = await prisma.evidence.findMany({
    where: { id: { in: evidenceIds } },
    select: {
      lifecycleState: true,
      deletedAt: true,
      destroyedAtUtc: true,
    },
  });
  if (records.some((r) => r.lifecycleState === "DESTROYED" || r.destroyedAtUtc !== null)) {
    throw conflictRefusal({
      code: "DESTRUCTION_EVIDENCE_ALREADY_DESTROYED",
      message: "At least one record in this request has already been destroyed.",
      developerMessage: "destruction_evidence_already_destroyed",
    });
  }
  const notBound = records.filter(
    (r) =>
      r.deletedAt === null &&
      !["TRASHED", "RETENTION_ARCHIVED", "PENDING_DESTRUCTION"].includes(String(r.lifecycleState)),
  );
  if (notBound.length > 0) {
    throw conflictRefusal({
      code: "DESTRUCTION_EVIDENCE_NOT_ELIGIBLE",
      message:
        "Only records in the trash or the retention archive can be requested here. Open a destruction review for an active record.",
      developerMessage: "destruction_evidence_not_destruction_bound",
    });
  }

  // Legal-hold gate — workspace-wide preservation MUST block the
  // request at intake.
  const holdCheck = await checkLegalHoldBlocks(prisma, evidenceIds, input.teamId);
  if (!holdCheck.ok) {
    return {
      ok: false,
      denial: "LEGAL_HOLD_BLOCKED",
      holdIds: holdCheck.holdIds,
    };
  }

  // GOV-003 — the approver list is checked by the server. It used to be taken
  // as given: it could name only the requester, or an id that could never sign.
  const approverIds = [...new Set(input.requiredApproverUserIds)];
  if (approverIds.includes(input.requestedByUserId)) {
    throw destructionForbidden(
      "DESTRUCTION_REQUESTER_CANNOT_APPROVE",
      "The person requesting destruction cannot also approve it. Name a different approver.",
    );
  }
  for (const userId of approverIds) {
    const decision = await evaluateMemberAccess(
      { teamId: input.teamId, userId, permission: "governance.destruction.approve" },
      prisma,
    );
    if (!decision.allowed) {
      throw inputRefusal({
        code: "DESTRUCTION_APPROVER_NOT_ELIGIBLE",
        message: "Every approver must be an active member who can approve destruction.",
        developerMessage: "destruction_approver_not_eligible",
      });
    }
  }

  const approverChain: ApproverEntry[] = approverIds.map(
    (userId) => ({ userId, approvedAtUtc: null }),
  );

  const evidenceIdsJson = [...evidenceIds] as Prisma.InputJsonValue;
  const approverIdsJson = approverChain as unknown as Prisma.InputJsonValue;

  const row = await prisma.destructionRequest.create({
    data: {
      teamId: input.teamId,
      state: "REQUESTED",
      evidenceIds: evidenceIdsJson,
      reason: input.reason.slice(0, REASON_MAX),
      policyRef: input.policyRef ?? null,
      requestedByUserId: input.requestedByUserId,
      approverUserIds: approverIdsJson,
    },
    select: { id: true },
  });

  await emitDestructionLifecycle(prisma, "DESTRUCTION_REQUESTED", {
    teamId: input.teamId,
    requestId: row.id,
    actorUserId: input.requestedByUserId,
    reason: input.reason,
  });
  await emitDestructionWebhook(prisma, "DESTRUCTION_REQUESTED", {
    teamId: input.teamId,
    requestId: row.id,
    state: "REQUESTED",
  });

  return { ok: true, requestId: row.id };
}

// -----------------------------------------------------------------------------
// listEligibleDestructionApprovers
// -----------------------------------------------------------------------------

/**
 * The people a request can name, so a requester picks from who can actually sign
 * instead of pasting ids. Never includes the requester (GOV-003). Empty is a real
 * answer: the workspace has nobody else who can approve, and the page says so.
 */
export async function listEligibleDestructionApprovers(input: {
  prisma?: PrismaClient;
  teamId: string;
  requesterUserId: string;
}): Promise<Array<{ userId: string; label: string }>> {
  const prisma = input.prisma ?? defaultPrisma;
  const members = await prisma.teamMember.findMany({
    where: { teamId: input.teamId, userId: { not: input.requesterUserId } },
    select: { userId: true, user: { select: { displayName: true, email: true } } },
    take: 500,
  });
  const eligible: Array<{ userId: string; label: string }> = [];
  for (const member of members) {
    const decision = await evaluateMemberAccess(
      { teamId: input.teamId, userId: member.userId, permission: "governance.destruction.approve" },
      prisma,
    );
    if (decision.allowed) {
      eligible.push({
        userId: member.userId,
        label: member.user?.displayName || member.user?.email || "Workspace member",
      });
    }
  }
  return eligible;
}

// -----------------------------------------------------------------------------
// assertDestructionRequestActionable
// -----------------------------------------------------------------------------

/**
 * What a route checks BEFORE it spends a step-up challenge, so an unknown id, a
 * foreign record or a request in the wrong state is answered as what it is rather
 * than as "verify again". The commands repeat every check under their own guard.
 */
export async function assertDestructionRequestActionable(input: {
  prisma?: PrismaClient;
  teamId: string;
  requestId: string;
  action: "APPROVE" | "EXECUTE";
  actorUserId: string;
}): Promise<void> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.destructionRequest.findFirst({
    where: { id: input.requestId, teamId: input.teamId },
    select: { state: true, evidenceIds: true, approverUserIds: true, requestedByUserId: true },
  });
  if (!row) throw destructionRequestNotFound();
  if (input.action === "EXECUTE") {
    if (!destructionExecutionEnabled()) throw destructionExecutionDisabled();
    if (!["APPROVED", "FAILED", "EXECUTING", "COMPLETED", "CERTIFIED"].includes(row.state)) {
      throw conflictRefusal({
        code: "DESTRUCTION_REQUEST_NOT_APPROVED",
        message: "This destruction request has not been approved, so it cannot be executed.",
        developerMessage: `destruction_request_not_approved:${row.state}`,
      });
    }
  }
  await assertRecordsInWorkspace(prisma, input.teamId, readEvidenceIds(row.evidenceIds));
  if (input.action === "APPROVE" && row.state === "REQUESTED") {
    assertMayApprove(readApproverChain(row.approverUserIds), row.requestedByUserId, input.actorUserId);
  }
}

function assertMayApprove(
  chain: ReadonlyArray<ApproverEntry>,
  requestedByUserId: string,
  approverUserId: string,
): void {
  if (approverUserId === requestedByUserId) {
    throw destructionForbidden(
      "DESTRUCTION_REQUESTER_CANNOT_APPROVE",
      "The person who requested this destruction cannot approve it.",
    );
  }
  if (!chain.some((e) => e.userId === approverUserId)) {
    throw destructionForbidden(
      "DESTRUCTION_APPROVER_NOT_IN_CHAIN",
      "You are not one of the approvers named on this request.",
    );
  }
}

// -----------------------------------------------------------------------------
// recordApproval
// -----------------------------------------------------------------------------

export type RecordApprovalInput = {
  prisma?: PrismaClient;
  teamId: string;
  requestId: string;
  approverUserId: string;
};

export type RecordApprovalResult = {
  ok: true;
  state: DestructionState;
  allApproved: boolean;
};

export async function recordApproval(
  input: RecordApprovalInput,
): Promise<RecordApprovalResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // Read-modify-write on a JSON chain, serialised on the request so two approvers
  // signing at once both land (GOV-003: one approval used to be lost).
  const outcome = await prisma.$transaction(async (txClient) => {
    const tx = txClient as unknown as PrismaClient;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.requestId}))`;
    const row = await tx.destructionRequest.findFirst({
      where: { id: input.requestId, teamId: input.teamId },
      select: { id: true, state: true, approverUserIds: true, evidenceIds: true, requestedByUserId: true },
    });
    if (!row) throw destructionRequestNotFound();
    if (row.state !== "REQUESTED") {
      return {
        state: row.state as DestructionState,
        allApproved: row.state === "APPROVED",
        advanced: false,
      };
    }
    await assertRecordsInWorkspace(tx, input.teamId, readEvidenceIds(row.evidenceIds));

    const chain = readApproverChain(row.approverUserIds);
    assertMayApprove(chain, row.requestedByUserId, input.approverUserId);
    const target = chain.find((e) => e.userId === input.approverUserId)!;
    if (!target.approvedAtUtc) {
      target.approvedAtUtc = new Date().toISOString();
    }

    const allApproved = chain.every((e) => e.approvedAtUtc !== null);
    const nextState: DestructionState = allApproved ? "APPROVED" : "REQUESTED";

    await tx.destructionRequest.update({
      where: { id: input.requestId },
      data: {
        state: nextState,
        approverUserIds: chain as unknown as Prisma.InputJsonValue,
      },
    });
    return { state: nextState, allApproved, advanced: allApproved };
  });

  if (outcome.advanced) {
    await emitDestructionLifecycle(prisma, "DESTRUCTION_APPROVED", {
      teamId: input.teamId,
      requestId: input.requestId,
      actorUserId: input.approverUserId,
    });
    await emitDestructionWebhook(prisma, "DESTRUCTION_APPROVED", {
      teamId: input.teamId,
      requestId: input.requestId,
      state: "APPROVED",
    });
  }

  return { ok: true, state: outcome.state, allApproved: outcome.allApproved };
}

// -----------------------------------------------------------------------------
// rejectDestructionRequest
// -----------------------------------------------------------------------------

export type RejectDestructionRequestInput = {
  prisma?: PrismaClient;
  teamId: string;
  requestId: string;
  rejectorUserId: string;
  reason: string;
};

export async function rejectDestructionRequest(
  input: RejectDestructionRequestInput,
): Promise<{ ok: boolean }> {
  const prisma = input.prisma ?? defaultPrisma;

  const row = await prisma.destructionRequest.findFirst({
    where: { id: input.requestId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!row) return { ok: false };
  if (row.state !== "REQUESTED") return { ok: false };

  await prisma.destructionRequest.update({
    where: { id: input.requestId },
    data: { state: "REJECTED" },
  });

  await emitDestructionLifecycle(prisma, "DESTRUCTION_REJECTED", {
    teamId: input.teamId,
    requestId: input.requestId,
    actorUserId: input.rejectorUserId,
    reason: input.reason,
  });
  await emitDestructionWebhook(prisma, "DESTRUCTION_REJECTED", {
    teamId: input.teamId,
    requestId: input.requestId,
    state: "REJECTED",
  });

  return { ok: true };
}

// -----------------------------------------------------------------------------
// executeDestruction
// -----------------------------------------------------------------------------

export type ExecuteDestructionInput = {
  prisma?: PrismaClient;
  teamId: string;
  requestId: string;
  executorUserId: string;
};

export async function executeDestruction(
  input: ExecuteDestructionInput,
): Promise<{ ok: true; certificateId: string }> {
  const prisma = input.prisma ?? defaultPrisma;

  const row = await prisma.destructionRequest.findFirst({
    where: { id: input.requestId, teamId: input.teamId },
    select: {
      id: true,
      state: true,
      evidenceIds: true,
      approverUserIds: true,
      requestedByUserId: true,
      executionStartedAtUtc: true,
    },
  });
  if (!row) throw destructionRequestNotFound();

  // GOV-019 — idempotent. A repeat of a finished request answers with its
  // certificate; a crash between deletion and certification is finished here.
  if (row.state === "CERTIFIED") {
    const existing = await prisma.destructionCertificate.findUnique({
      where: { requestId: row.id },
      select: { id: true },
    });
    if (existing) return { ok: true, certificateId: existing.id };
  }
  if (row.state === "COMPLETED" || row.state === "CERTIFIED") {
    assertCertificateSigningAvailable();
    const cert = await certifyDestruction({ prisma, teamId: input.teamId, requestId: row.id });
    return { ok: true, certificateId: cert.certificateId };
  }

  if (!destructionExecutionEnabled()) throw destructionExecutionDisabled();

  const leaseLive =
    row.state === "EXECUTING" &&
    row.executionStartedAtUtc !== null &&
    Date.now() - row.executionStartedAtUtc.getTime() < EXECUTION_LEASE_MS;
  if (leaseLive) {
    throw conflictRefusal({
      code: "DESTRUCTION_REQUEST_EXECUTING",
      message: "This destruction request is already being executed.",
      developerMessage: "destruction_request_execution_lease_live",
    });
  }
  // FAILED is resumable and an abandoned EXECUTING is resumed: a partial failure
  // can leave some records destroyed, and those must still reach a certificate.
  if (!["APPROVED", "FAILED", "EXECUTING"].includes(row.state)) {
    throw conflictRefusal({
      code: "DESTRUCTION_REQUEST_NOT_APPROVED",
      message: "This destruction request has not been approved, so it cannot be executed.",
      developerMessage: `destruction_request_not_approved:${row.state}`,
    });
  }

  const evidenceIds = readEvidenceIds(row.evidenceIds);
  await assertRecordsInWorkspace(prisma, input.teamId, evidenceIds);

  // A row written before the approver checks existed may carry the requester as
  // its only approver. That is not an approval, so it is not executed.
  if (!chainIsSigned(readApproverChain(row.approverUserIds), row.requestedByUserId)) {
    throw conflictRefusal({
      code: "DESTRUCTION_REQUEST_NOT_APPROVED",
      message: "This destruction request has not been approved by someone other than its requester.",
      developerMessage: "destruction_request_chain_not_signed",
    });
  }

  // GOV-009 — settled before the first delete, not discovered after the last one:
  // the HMAC secret, and the Ed25519 signer whose public key a customer verifies
  // the certificate with.
  assertCertificateSigningAvailable();
  await assertEd25519CertificateSigningAvailable();

  // Defence in depth — re-check legal hold immediately before
  // executing. A hold placed between APPROVED and execute MUST block.
  // Uses assertNoLegalHoldOrBlock with action=DESTROY so the
  // POLICY_VIOLATION_LEGAL_HOLD audit event fires for each blocked item.
  const blockedAtExecute: string[] = [];
  for (const evidenceId of evidenceIds) {
    const assertResult = await assertNoLegalHoldOrBlock({
      prisma,
      teamId: input.teamId,
      evidenceId,
      action: "DESTROY",
    }).catch(() => ({ ok: false as const, denial: "LEGAL_HOLD_BLOCKED" as const, holdIds: [] }));
    if (!assertResult.ok) blockedAtExecute.push(evidenceId);
  }
  if (blockedAtExecute.length > 0) {
    await prisma.destructionRequest.update({
      where: { id: input.requestId },
      data: { state: "FAILED" },
    });
    throw conflictRefusal({
      code: "DESTRUCTION_BLOCKED_BY_LEGAL_HOLD",
      message: "A legal hold now covers at least one record in this request, so it was not executed.",
      developerMessage: "legal_hold_blocked_at_execute",
    });
  }

  // GOV-007 — a dated barrier refuses the whole request up front with its date,
  // and leaves it approved. Deleting the records that happen to be free first
  // would leave the request half done for years.
  const readings = await Promise.all(evidenceIds.map((id) => readDestructionBarriers(prisma, id)));
  const standing = readings.filter((r) => !r.alreadyDestroyed && !r.eligible);
  if (standing.length > 0) {
    const eligibleAtMs = standing.flatMap((r) => (r.eligibleAt ? [r.eligibleAt.getTime()] : []));
    const eligibleAtUtc = eligibleAtMs.length ? new Date(Math.max(...eligibleAtMs)).toISOString() : null;
    throw conflictRefusal({
      code: "DESTRUCTION_NOT_YET_ELIGIBLE",
      message: eligibleAtUtc
        ? `At least one record cannot be destroyed before ${eligibleAtUtc}. Nothing was destroyed.`
        : "At least one record cannot be destroyed yet. Nothing was destroyed.",
      developerMessage: `destruction_not_yet_eligible:${standing[0]?.blockReason ?? "UNKNOWN"}`,
      metadata: { eligibleAtUtc, blockReason: standing[0]?.blockReason ?? null },
    });
  }

  // Transition to EXECUTING, compare-and-set (GOV-019): two callers produce one
  // winner, and the loser never reaches the executor or the certificate.
  const claimed = await prisma.destructionRequest.updateMany({
    where: {
      id: input.requestId,
      state: row.state,
      ...(row.state === "EXECUTING" ? { executionStartedAtUtc: row.executionStartedAtUtc } : {}),
    },
    data: { state: "EXECUTING", executionStartedAtUtc: new Date() },
  });
  if (claimed.count !== 1) {
    throw conflictRefusal({
      code: "DESTRUCTION_REQUEST_EXECUTING",
      message: "This destruction request is already being executed.",
      developerMessage: "destruction_request_execution_claim_lost",
    });
  }
  // I10 — emit EXECUTING lifecycle event (uniform audit).
  void emitDestructionLifecycle(prisma, "DESTRUCTION_EXECUTED", {
    teamId: input.teamId,
    requestId: input.requestId,
    actorUserId: input.executorUserId,
    reason: "EXECUTING",
  });

  // EXECUTE — through the ONE canonical destruction executor, per record.
  //
  // WHAT THIS REPLACES: an inline storage loop that gathered `storageKey` from
  // the Evidence rows plus READY redaction derivatives, deleted each key, and
  // then wrote `lifecycleState: "DESTROYED"` across the whole batch. Three
  // things were wrong with it beyond the duplication:
  //
  //   * it never re-read the record and never re-evaluated eligibility, so
  //     application retention, Object Lock retain-until and the trash grace
  //     window were simply not consulted at execution time — approval plus an
  //     absent legal hold was the whole test;
  //   * it never verified that the deletes had taken effect. Against a bucket
  //     with a COMPLIANCE lock, `DeleteObject` succeeds by writing a delete
  //     marker while the object version remains fully retrievable, and this
  //     code read that success as destruction;
  //   * it missed `EvidencePart`, `Report` and `VerificationPackage` objects
  //     entirely — for a multipart record, only the primary key was deleted and
  //     every part survived.
  //
  // The executor holds a durable lease, re-reads, re-computes the canonical
  // eligibility, deletes everything the record owns, and VERIFIES absence
  // before it will tombstone or certify.
  try {
    const failures: Array<{ evidenceId: string; outcome: string }> = [];
    const scope = await workspaceEvidenceWhere(input.teamId, prisma);

    for (const evidenceId of evidenceIds) {
      const row = await prisma.evidence.findFirst({
        where: { AND: [scope], id: evidenceId },
        select: { id: true, teamId: true, caseLinks: { select: { caseId: true } } },
      });
      if (!row) {
        failures.push({ evidenceId, outcome: "NOT_FOUND" });
        continue;
      }

      const hold = await evaluateEffectiveLegalHold(prisma, {
        teamId: row.teamId ?? null,
        evidenceId: row.id,
        caseIds: (row.caseLinks ?? []).map((l) => l.caseId),
      });

      // No approval is passed: the executor reads this request itself and
      // refuses unless it is this record's, EXECUTING and signed (GOV-001).
      const result = await executeEvidenceDestruction(
        prisma,
        {
          evidenceId: row.id,
          trigger: "destruction_request",
          actorUserId: input.executorUserId,
          destructionRequestId: input.requestId,
          legalHold: hold.held,
          objectLockExpected: String(process.env.S3_OBJECT_LOCK_ENABLED ?? "").trim().toLowerCase() === "true",
        },
        apiEvidenceDestructionStorage,
      );

      if (result.ok) {
        // Either verified now, or already destroyed and accounted for at
        // certification, where the custody chain says which of those it is.
        continue;
      }
      failures.push({
        evidenceId: row.id,
        outcome:
          result.outcome === "BLOCKED" ? `BLOCKED_${result.reason}` : result.outcome,
      });
    }

    if (failures.length > 0) {
      const reason =
        `destruction_partial_failure:${failures.length}_records_failed`.slice(0, 199);
      await prisma.destructionRequest.update({
        where: { id: input.requestId },
        data: { state: "FAILED" },
      });
      void emitDestructionLifecycle(prisma, "DESTRUCTION_FAILED", {
        teamId: input.teamId,
        requestId: input.requestId,
        actorUserId: input.executorUserId,
        reason,
      });
      throw conflictRefusal({
        code: "DESTRUCTION_PARTIAL_FAILURE",
        message:
          "At least one record could not be destroyed. Records already destroyed stay destroyed; execute the request again to finish it.",
        developerMessage: reason,
        metadata: { failedCount: failures.length },
      });
    }
  } catch (err) {
    if ((err as { code?: string }).code === "DESTRUCTION_PARTIAL_FAILURE") throw err;
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 199);
    await prisma.destructionRequest
      .update({
        where: { id: input.requestId },
        data: { state: "FAILED" },
      })
      .catch(() => null);
    void emitDestructionLifecycle(prisma, "DESTRUCTION_FAILED", {
      teamId: input.teamId,
      requestId: input.requestId,
      actorUserId: input.executorUserId,
      reason,
    });
    throw err;
  }

  const executedAtUtc = new Date();
  await prisma.destructionRequest.update({
    where: { id: input.requestId },
    data: { state: "COMPLETED", executedAtUtc },
  });

  void emitDestructionLifecycle(prisma, "DESTRUCTION_EXECUTED", {
    teamId: input.teamId,
    requestId: input.requestId,
    actorUserId: input.executorUserId,
  });

  const cert = await certifyDestruction({
    prisma,
    teamId: input.teamId,
    requestId: input.requestId,
  });
  return { ok: true, certificateId: cert.certificateId };
}

// -----------------------------------------------------------------------------
// certifyDestruction
// -----------------------------------------------------------------------------

export type CertifyDestructionInput = {
  prisma?: PrismaClient;
  teamId: string;
  requestId: string;
};

/**
 * What this request actually destroyed, from the custody chain: the executor
 * writes one EVIDENCE_PURGED event per verified deletion, naming the request that
 * asked for it and the hash of that record's own certificate. Read from there and
 * not from the request's list, so a batch certificate can never say more than was
 * verified, and a resumed request still counts what its first attempt finished.
 */
async function readVerifiedDeletions(
  prisma: PrismaClient,
  requestId: string,
  evidenceIds: ReadonlyArray<string>,
): Promise<{
  verifiedEvidenceIds: string[];
  verifiedEvidenceCertificateHashes: string[];
  exceptions: Array<{ evidenceId: string; reason: string }>;
}> {
  const events = await prisma.custodyEvent.findMany({
    where: { evidenceId: { in: [...evidenceIds] }, eventType: "EVIDENCE_PURGED" },
    select: { evidenceId: true, payload: true },
  });
  const byEvidence = new Map(
    events.map((e) => [
      e.evidenceId,
      (e.payload ?? {}) as { certificateHash?: unknown; destructionRequestId?: unknown },
    ]),
  );
  const records = await prisma.evidence.findMany({
    where: { id: { in: [...evidenceIds] } },
    select: {
      id: true,
      destroyedAtUtc: true,
    },
  });
  const destroyed = new Set(records.filter((r) => r.destroyedAtUtc !== null).map((r) => r.id));
  const verifiedEvidenceIds: string[] = [];
  const verifiedEvidenceCertificateHashes: string[] = [];
  const exceptions: Array<{ evidenceId: string; reason: string }> = [];
  for (const evidenceId of [...evidenceIds].sort()) {
    const payload = byEvidence.get(evidenceId);
    if (!payload) {
      exceptions.push({
        evidenceId,
        reason: destroyed.has(evidenceId) ? "ALREADY_DESTROYED_BEFORE_THIS_REQUEST" : "NOT_DESTROYED",
      });
    } else if (payload.destructionRequestId === requestId && typeof payload.certificateHash === "string") {
      verifiedEvidenceIds.push(evidenceId);
      verifiedEvidenceCertificateHashes.push(payload.certificateHash);
    } else {
      exceptions.push({ evidenceId, reason: "ALREADY_DESTROYED_BEFORE_THIS_REQUEST" });
    }
  }
  return { verifiedEvidenceIds, verifiedEvidenceCertificateHashes, exceptions };
}

export async function certifyDestruction(
  input: CertifyDestructionInput,
): Promise<{ ok: true; certificateId: string; certificateHash: string }> {
  const prisma = input.prisma ?? defaultPrisma;

  const row = await prisma.destructionRequest.findFirst({
    where: { id: input.requestId, teamId: input.teamId },
    select: {
      id: true,
      teamId: true,
      state: true,
      evidenceIds: true,
      executedAtUtc: true,
      approverUserIds: true,
    },
  });
  if (!row) throw destructionRequestNotFound();
  if (!row.executedAtUtc) {
    throw conflictRefusal({
      code: "DESTRUCTION_REQUEST_NOT_EXECUTED",
      message: "This destruction request has not been executed, so it cannot be certified.",
      developerMessage: "destruction_request_not_executed",
    });
  }

  // GOV-019 — one certificate per request, however many callers arrive.
  const finishCertified = async (certificateId: string, certificateHash: string) => {
    const certifiedAtUtc = new Date();
    const moved = await prisma.destructionRequest.updateMany({
      where: { id: row.id, state: { not: "CERTIFIED" } },
      data: { state: "CERTIFIED", certifiedAtUtc },
    });
    return { ok: true as const, certificateId, certificateHash, firstCertification: moved.count === 1 };
  };
  const already = await prisma.destructionCertificate.findUnique({
    where: { requestId: row.id },
    select: { id: true, certificateHash: true },
  });
  if (already) return finishCertified(already.id, already.certificateHash);

  const evidenceIds = readEvidenceIds(row.evidenceIds);
  const approverChain = readApproverChain(row.approverUserIds);
  const approvalChainUserIds = approverChainUserIds(approverChain);
  const verified = await readVerifiedDeletions(prisma, row.id, evidenceIds);

  const certifiedAtUtc = new Date();

  // PHASE 6 §9.5 (2026-07-22) — snapshot the policy decision context that
  // governed this destruction. The tombstoned evidence rows still carry
  // their `retentionPolicyVersionId`; execution already re-asserted that
  // no legal hold blocked (executeDestruction), so the certificate records
  // BOTH the retention policy versions in force AND the hold-cleared fact.
  // Binding it into the hashed body means a later policy edit can never
  // rewrite what actually authorized the destruction (§9.5 invariant).
  const evidenceRows = await prisma.evidence.findMany({
    where: { id: { in: verified.verifiedEvidenceIds } },
    select: { retentionPolicyVersionId: true },
  });
  const retentionPolicyVersionIds = Array.from(
    new Set(
      evidenceRows
        .map((e) => e.retentionPolicyVersionId)
        .filter((v): v is string => Boolean(v)),
    ),
  ).sort();
  const policySnapshot = {
    retentionPolicyVersionIds,
    // True of the verified records only; an exception is listed, not vouched for.
    legalHoldClearedAtExecute: verified.verifiedEvidenceIds.length > 0,
    snapshotVersion: CERTIFICATE_VERSION,
    // The per-record attestations this batch is built on, sorted so the hash is
    // order-independent. Empty means no record's deletion was verified — which
    // the certificate then says plainly instead of implying otherwise.
    verifiedEvidenceCertificateHashes: [...verified.verifiedEvidenceCertificateHashes].sort(),
  };

  // Build canonical certificate body — binds the request, evidence hash,
  // approval chain, timestamps, policy snapshot, and certificate version.
  // The hash of this body is the on-chain fingerprint.
  const evidenceIdsHash = hashSortedEvidenceIds(verified.verifiedEvidenceIds);
  const certificateBody = {
    requestId: row.id,
    teamId: row.teamId,
    evidenceIdsHash,
    verifiedEvidenceCount: verified.verifiedEvidenceIds.length,
    requestedEvidenceCount: evidenceIds.length,
    exceptions: verified.exceptions,
    executedAtUtc: row.executedAtUtc.toISOString(),
    approvalChainUserIds,
    policySnapshot,
    certifiedAtUtc: certifiedAtUtc.toISOString(),
    certificateVersion: CERTIFICATE_VERSION,
  };
  const canonicalBody = canonicalJsonValue(certificateBody);
  const certificateHash = sha256Hex(canonicalBody);

  // C3 — Build the real certificate artifact JSON.
  const certId = randomUUID();
  const approvalChainFull = approverChain
    .filter((e) => e.approvedAtUtc !== null)
    .map((e) => ({ userId: e.userId, approvedAtUtc: e.approvedAtUtc! }));

  const artifactBody = {
    certificateVersion: CERTIFICATE_VERSION,
    certificateId: certId,
    requestId: row.id,
    teamId: row.teamId,
    evidenceCount: verified.verifiedEvidenceIds.length,
    requestedEvidenceCount: evidenceIds.length,
    verifiedEvidenceIds: verified.verifiedEvidenceIds,
    exceptions: verified.exceptions,
    evidenceIdsHash,
    approvalChain: approvalChainFull,
    // PHASE 6 §9.5 — the retention policy versions that governed the
    // destroyed evidence (was a permanent empty placeholder).
    policyReferences: retentionPolicyVersionIds,
    policySnapshot,
    executedAtUtc: row.executedAtUtc.toISOString(),
    certifiedAtUtc: certifiedAtUtc.toISOString(),
    // GOV-009 — the exact body the hash covers, so it can be recomputed.
    certificateBody,
    certificateHash,
    signature: signatureHmac(canonicalBody),
    // GOV-009 — verifiable by anyone with the published key: Ed25519 over the
    // bytes of certificateHash, by the platform signer, self-verified against
    // signing_keys(keyId, keyVersion, DESTRUCTION_CERTIFICATE).
    signatureEd25519: await signDestructionCertificateHash(certificateHash),
  };
  const artifactText = JSON.stringify(artifactBody, null, 2);
  const artifactBytes = Buffer.from(artifactText, "utf8");
  const artifactBytesSha256 = sha256HexBuffer(artifactBytes);

  // The row below holds the artifact, so an object-storage failure can no longer
  // lose it; the object is a convenience copy and certificateUri stays null.
  let certificateUri: string | null = null;
  const bucket = getS3Bucket();
  if (bucket) {
    const certKey = `destruction-certificates/${row.teamId}/${row.id}.json`;
    try {
      await putObjectBuffer({
        bucket,
        key: certKey,
        body: artifactBytes,
        contentType: "application/json",
        metadata: {
          "x-proovra-certificate-version": CERTIFICATE_VERSION,
          "x-proovra-certificate-hash": certificateHash,
        },
      });
      certificateUri = certKey;
    } catch {
      // The database row is the record; only the object copy is missing.
    }
  }

  // PDF: skipped — no PDF library in services/api (puppeteer is in
  // services/worker only). certificatePdfUri remains null.

  const approvalChainJson =
    approvalChainUserIds as unknown as Prisma.InputJsonValue;
  let cert: { id: string };
  try {
    cert = await prisma.destructionCertificate.create({
      data: {
        id: certId,
        teamId: row.teamId,
        requestId: row.id,
        evidenceCount: verified.verifiedEvidenceIds.length,
        approvalChainUserIds: approvalChainJson,
        executedAtUtc: row.executedAtUtc,
        certifiedAtUtc,
        certificateHash,
        certificateUri,
        certificateBytesSha256: artifactBytesSha256,
        certificateVersion: CERTIFICATE_VERSION,
        certificateBody: artifactText,
      },
      select: { id: true },
    });
  } catch (err) {
    // A concurrent certifier won the unique requestId. Its certificate stands.
    if ((err as { code?: string }).code !== "P2002") throw err;
    const winner = await prisma.destructionCertificate.findUniqueOrThrow({
      where: { requestId: row.id },
      select: { id: true, certificateHash: true },
    });
    return finishCertified(winner.id, winner.certificateHash);
  }

  await finishCertified(cert.id, certificateHash);

  await emitDestructionLifecycle(prisma, "DESTRUCTION_CERTIFIED", {
    teamId: row.teamId,
    requestId: row.id,
  });
  await emitDestructionWebhook(prisma, "DESTRUCTION_CERTIFIED", {
    teamId: row.teamId,
    requestId: row.id,
    state: "CERTIFIED",
  });
  // DESTRUCTION_COMPLETED is a webhook signal for downstream consumers
  // who only care that the full workflow terminated successfully.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await emitDestructionWebhook(prisma, "DESTRUCTION_COMPLETED" as any, {
    teamId: row.teamId,
    requestId: row.id,
    state: "CERTIFIED",
  });

  return { ok: true, certificateId: cert.id, certificateHash };
}

// -----------------------------------------------------------------------------
// Read projections
// -----------------------------------------------------------------------------

function projectRequest(row: {
  id: string;
  teamId: string;
  state: string;
  evidenceIds: unknown;
  reason: string;
  policyRef: string | null;
  requestedByUserId: string;
  approverUserIds: unknown;
  executedAtUtc: Date | null;
  certifiedAtUtc: Date | null;
  createdAt: Date;
  certificate?: {
    id: string;
    requestId: string;
    evidenceCount: number;
    executedAtUtc: Date;
    certifiedAtUtc: Date;
    approvalChainUserIds: unknown;
    certificateHash: string;
    certificateUri: string | null;
  } | null;
}): DestructionRequestProjection {
  const evidenceIds = Array.isArray(row.evidenceIds)
    ? (row.evidenceIds as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const chain = approverChainUserIds(readApproverChain(row.approverUserIds));
  const cert = row.certificate
    ? projectCertificate(row.certificate)
    : null;
  return {
    id: row.id,
    teamId: row.teamId,
    state: row.state as DestructionState,
    evidenceIds,
    reason: row.reason,
    policyRef: row.policyRef,
    requestedByUserId: row.requestedByUserId,
    approverUserIds: chain,
    executedAtUtc: row.executedAtUtc?.toISOString() ?? null,
    certifiedAtUtc: row.certifiedAtUtc?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    certificate: cert,
  };
}

function projectCertificate(row: {
  id: string;
  requestId: string;
  evidenceCount: number;
  executedAtUtc: Date;
  certifiedAtUtc: Date;
  approvalChainUserIds: unknown;
  certificateHash: string;
  certificateUri: string | null;
}): DestructionCertificateProjection {
  const chain = Array.isArray(row.approvalChainUserIds)
    ? (row.approvalChainUserIds as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  return {
    id: row.id,
    requestId: row.requestId,
    evidenceCount: row.evidenceCount,
    executedAtUtc: row.executedAtUtc.toISOString(),
    certifiedAtUtc: row.certifiedAtUtc.toISOString(),
    approvalChainUserIds: chain,
    certificateHash: row.certificateHash,
    certificateUri: row.certificateUri,
  };
}

export type ListDestructionRequestsInput = {
  prisma?: PrismaClient;
  teamId: string;
  /** Records closed to the viewer: a request naming one is left out (GOV-017). */
  closedEvidenceIds?: readonly string[];
  state?: DestructionState;
  limit?: number;
};

/**
 * GOV-017 — a destruction request names records. One that names a record closed to
 * the caller is, to them, not there: they neither read it nor decide it.
 */
export async function destructionRequestClosedTo(
  requestId: string,
  teamId: string,
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const row = await client.destructionRequest.findFirst({
    where: { id: requestId, teamId },
    select: { evidenceIds: true },
  });
  const ids = Array.isArray(row?.evidenceIds) ? (row.evidenceIds as string[]) : [];
  if (ids.length === 0) return false;
  const closed = await client.evidence.count({
    where: { id: { in: ids }, NOT: evidenceVisibleThroughCasesWhere(userId) },
  });
  return closed > 0;
}

export async function listDestructionRequests(
  input: ListDestructionRequestsInput,
): Promise<DestructionRequestProjection[]> {
  const prisma = input.prisma ?? defaultPrisma;
  const take = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await prisma.destructionRequest.findMany({
    where: {
      teamId: input.teamId,
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    include: { certificate: true },
  });
  const closed = new Set(input.closedEvidenceIds ?? []);
  return rows
    .filter((r) => !(Array.isArray(r.evidenceIds) && (r.evidenceIds as string[]).some((id) => closed.has(id))))
    .map((r) => projectRequest(r));
}

export type GetDestructionCertificateInput = {
  prisma?: PrismaClient;
  teamId: string;
  requestId: string;
};

export async function getDestructionCertificate(
  input: GetDestructionCertificateInput,
): Promise<DestructionCertificateProjection | null> {
  const prisma = input.prisma ?? defaultPrisma;
  const cert = await prisma.destructionCertificate.findFirst({
    where: { teamId: input.teamId, requestId: input.requestId },
  });
  if (!cert) return null;
  return projectCertificate(cert);
}

// -----------------------------------------------------------------------------
// getDestructionCertificateArtifact — streams the JSON artifact from S3
// -----------------------------------------------------------------------------

export type GetDestructionCertificateArtifactInput = {
  prisma?: PrismaClient;
  teamId: string;
  requestId: string;
};

export type GetDestructionCertificateArtifactResult =
  | {
      ok: true;
      bytes: Buffer;
      contentType: string;
      sha256: string | null;
      etag: string | null;
    }
  | { ok: false; denial: "NOT_FOUND" | "ARTIFACT_UNAVAILABLE" };

export async function getDestructionCertificateArtifact(
  input: GetDestructionCertificateArtifactInput,
): Promise<GetDestructionCertificateArtifactResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cert = await (prisma.destructionCertificate.findFirst as any)({
    where: { teamId: input.teamId, requestId: input.requestId },
    select: {
      certificateUri: true,
      // Phase 4B additive column — Prisma client not yet regenerated.
      certificateBytesSha256: true,
      certificateBody: true,
    },
  }) as {
    certificateUri: string | null;
    certificateBytesSha256: string | null;
    certificateBody: string | null;
  } | null;
  if (!cert) return { ok: false, denial: "NOT_FOUND" };
  // GOV-009 — the row is the record. Certificates minted before it held the body
  // still answer from object storage.
  if (cert.certificateBody) {
    return {
      ok: true,
      bytes: Buffer.from(cert.certificateBody, "utf8"),
      contentType: "application/json",
      sha256: cert.certificateBytesSha256 ?? null,
      etag: null,
    };
  }
  if (!cert.certificateUri) return { ok: false, denial: "ARTIFACT_UNAVAILABLE" };

  const bucket = getS3Bucket();
  if (!bucket) return { ok: false, denial: "ARTIFACT_UNAVAILABLE" };

  try {
    const stream = await getObjectStream({ bucket, key: cert.certificateUri });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const bytes = Buffer.concat(chunks);
    return {
      ok: true,
      bytes,
      contentType: "application/json",
      sha256: cert.certificateBytesSha256 ?? null,
      etag: null,
    };
  } catch {
    return { ok: false, denial: "ARTIFACT_UNAVAILABLE" };
  }
}
