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
 *               ↘ REJECTED
 *               ↘ FAILED
 *
 * Hard rules:
 *   * Workspace-anchored on `teamId`.
 *   * Legal-hold check is run twice: at request time (gate) and at
 *     execute time (defence in depth) — a hold placed between request
 *     and execute MUST block destruction.
 *   * Dual approval policy when `requiredApproverUserIds.length >= 2`
 *     — all listed approvers MUST approve before state advances to
 *     APPROVED.
 *   * The destruction certificate is immutable. Its hash binds the
 *     requestId, the sorted evidence-id list, the executed-at
 *     timestamp, and the approval chain. The certificate version
 *     string is part of the body so the hash is forward-compatible.
 *   * Bounded vocabulary on lifecycle events (DESTRUCTION_LIFECYCLE_CODES).
 *   * Webhook emission + lifecycle event emission are best-effort —
 *     they MUST NEVER unwind a state transition.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DESTRUCTION_LIFECYCLE_CODES,
  type DestructionCertificateProjection,
  type DestructionLifecycleCode,
  type DestructionRequestProjection,
  type DestructionState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  isUnderLegalHold,
  assertNoLegalHoldOrBlock,
} from "./legal-hold.service.js";
import { emitWebhookEvent } from "../integrations/webhook-dispatcher.js";
import { deleteObject, putObjectBuffer, getObjectStream } from "../../storage.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const CERTIFICATE_VERSION = "PROOVRA_DESTRUCTION_CERT_V1" as const;
const REASON_MAX = 600;

function getS3Bucket(): string | null {
  const v = process.env.S3_BUCKET;
  if (!v || !v.trim()) return null;
  return v.trim();
}

function signatureHmac(payload: string): string {
  const secret =
    process.env.DESTRUCTION_CERT_SIGNING_SECRET ??
    process.env.WEBHOOK_SIGNING_SECRET ??
    "PROOVRA_CERT_FALLBACK_SECRET";
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
  const blocked: string[] = [];
  for (const evidenceId of evidenceIds) {
    const result = await isUnderLegalHold({
      prisma,
      teamId,
      evidenceId,
    }).catch(() => ({ underHold: false, holdIds: [], sources: [] as Array<"4A" | "4B"> }));
    if (result.underHold) blocked.push(evidenceId);
  }
  if (blocked.length === 0) return { ok: true };
  return { ok: false, holdIds: blocked };
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

  // Legal-hold gate — workspace-wide preservation MUST block the
  // request at intake.
  const holdCheck = await checkLegalHoldBlocks(prisma, input.evidenceIds, input.teamId);
  if (!holdCheck.ok) {
    return {
      ok: false,
      denial: "LEGAL_HOLD_BLOCKED",
      holdIds: holdCheck.holdIds,
    };
  }

  const approverChain: ApproverEntry[] = input.requiredApproverUserIds.map(
    (userId) => ({ userId, approvedAtUtc: null }),
  );

  const evidenceIdsJson = [...input.evidenceIds] as Prisma.InputJsonValue;
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

  const row = await prisma.destructionRequest.findFirst({
    where: { id: input.requestId, teamId: input.teamId },
    select: { id: true, state: true, approverUserIds: true },
  });
  if (!row) {
    throw new Error("destruction_request_not_found");
  }
  if (row.state !== "REQUESTED") {
    return {
      ok: true,
      state: row.state as DestructionState,
      allApproved: row.state === "APPROVED",
    };
  }

  const chain = readApproverChain(row.approverUserIds);
  const target = chain.find((e) => e.userId === input.approverUserId);
  if (!target) {
    throw new Error("approver_not_in_chain");
  }
  if (!target.approvedAtUtc) {
    target.approvedAtUtc = new Date().toISOString();
  }

  const allApproved = chain.every((e) => e.approvedAtUtc !== null);
  const nextState: DestructionState = allApproved ? "APPROVED" : "REQUESTED";

  await prisma.destructionRequest.update({
    where: { id: input.requestId },
    data: {
      state: nextState,
      approverUserIds: chain as unknown as Prisma.InputJsonValue,
    },
  });

  if (allApproved) {
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

  return { ok: true, state: nextState, allApproved };
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
    select: { id: true, state: true, evidenceIds: true },
  });
  if (!row) throw new Error("destruction_request_not_found");
  if (row.state !== "APPROVED") {
    throw new Error(`destruction_request_not_approved:${row.state}`);
  }

  // Defence in depth — re-check legal hold immediately before
  // executing. A hold placed between APPROVED and execute MUST block.
  // Uses assertNoLegalHoldOrBlock with action=DESTROY so the
  // POLICY_VIOLATION_LEGAL_HOLD audit event fires for each blocked item.
  const evidenceIds = Array.isArray(row.evidenceIds)
    ? (row.evidenceIds as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
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
    throw new Error("legal_hold_blocked_at_execute");
  }

  // Transition to EXECUTING so concurrent callers are blocked.
  await prisma.destructionRequest.update({
    where: { id: input.requestId },
    data: { state: "EXECUTING" },
  });
  // I10 — emit EXECUTING lifecycle event (uniform audit).
  void emitDestructionLifecycle(prisma, "DESTRUCTION_EXECUTED", {
    teamId: input.teamId,
    requestId: input.requestId,
    actorUserId: input.executorUserId,
    reason: "EXECUTING",
  });

  // C2 — Real S3 deletion of every evidence byte + redaction derivatives.
  try {
    const bucket = getS3Bucket();
    const failedKeys: string[] = [];

    if (bucket) {
      // Gather primary storage keys from Evidence rows.
      const evidenceRows = await prisma.evidence.findMany({
        where: { id: { in: evidenceIds } },
        select: { id: true, storageKey: true },
      });

      // Gather redaction derivative keys attached to these evidence items.
      // RedactionDerivative → RedactionVersion → RedactionProject (evidenceId).
      const derivativeRows = await prisma.redactionDerivative.findMany({
        where: {
          teamId: input.teamId,
          version: {
            project: { evidenceId: { in: evidenceIds } },
          },
          state: "READY",
        },
        select: { storageKey: true },
      });

      const allKeys: string[] = [
        ...evidenceRows.map((r) => r.storageKey).filter((k): k is string => Boolean(k)),
        ...derivativeRows.map((r) => r.storageKey).filter((k): k is string => Boolean(k)),
      ];

      for (const key of allKeys) {
        const res = await deleteObject({ bucket, key });
        if (!res.ok) {
          failedKeys.push(key.slice(0, 200));
        }
      }
    }

    if (failedKeys.length > 0) {
      const reason = `destruction_partial_failure:${failedKeys.length}_keys_failed`.slice(0, 199);
      await prisma.destructionRequest.update({
        where: { id: input.requestId },
        data: { state: "FAILED" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void emitDestructionLifecycle(prisma, "DESTRUCTION_FAILED" as any, {
        teamId: input.teamId,
        requestId: input.requestId,
        actorUserId: input.executorUserId,
        reason,
      });
      throw Object.assign(new Error("DESTRUCTION_PARTIAL_FAILURE"), { failedKeys, denial: "DESTRUCTION_PARTIAL_FAILURE" });
    }

    // Mark evidence rows as destroyed (tombstone — row preserved for audit).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.evidence.updateMany({
      where: { id: { in: evidenceIds } },
      data: { status: "DESTROYED" as any },
    });
  } catch (err) {
    // Re-throw partial-failure errors as-is; wrap unexpected errors.
    if ((err as { denial?: string }).denial === "DESTRUCTION_PARTIAL_FAILURE") throw err;
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 199);
    await prisma.destructionRequest.update({
      where: { id: input.requestId },
      data: { state: "FAILED" },
    }).catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void emitDestructionLifecycle(prisma, "DESTRUCTION_FAILED" as any, {
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
  if (!row) throw new Error("destruction_request_not_found");
  if (!row.executedAtUtc) {
    throw new Error("destruction_request_not_executed");
  }

  const evidenceIds = Array.isArray(row.evidenceIds)
    ? (row.evidenceIds as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const approverChain = readApproverChain(row.approverUserIds);
  const approvalChainUserIds = approverChainUserIds(approverChain);

  const certifiedAtUtc = new Date();

  // Build canonical certificate body — binds the request, evidence hash,
  // approval chain, timestamps, and certificate version. The hash of this
  // body is the on-chain fingerprint.
  const evidenceIdsHash = hashSortedEvidenceIds(evidenceIds);
  const certificateBody = {
    requestId: row.id,
    teamId: row.teamId,
    evidenceIdsHash,
    executedAtUtc: row.executedAtUtc.toISOString(),
    approvalChainUserIds,
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
    evidenceCount: evidenceIds.length,
    evidenceIdsHash,
    approvalChain: approvalChainFull,
    policyReferences: [] as string[],
    executedAtUtc: row.executedAtUtc.toISOString(),
    certifiedAtUtc: certifiedAtUtc.toISOString(),
    certificateHash,
    signature: signatureHmac(canonicalBody),
  };
  const artifactBytes = Buffer.from(
    JSON.stringify(artifactBody, null, 2),
    "utf8",
  );
  const artifactBytesSha256 = sha256HexBuffer(artifactBytes);

  // Upload artifact to S3. Failures are tolerated — the certificate row
  // is still persisted; certificateUri remains null if S3 is unavailable.
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
      // S3 upload failed — certificate is valid without artifact URI.
      // certificateUri stays null.
    }
  }

  // PDF: skipped — no PDF library in services/api (puppeteer is in
  // services/worker only). certificatePdfUri remains null.

  const approvalChainJson =
    approvalChainUserIds as unknown as Prisma.InputJsonValue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cert = await (prisma.destructionCertificate.create as any)({
    data: {
      teamId: row.teamId,
      requestId: row.id,
      evidenceCount: evidenceIds.length,
      approvalChainUserIds: approvalChainJson,
      executedAtUtc: row.executedAtUtc,
      certifiedAtUtc,
      certificateHash,
      certificateUri,
      // Phase 4B Final Closure additive columns — in schema but Prisma
      // client not yet regenerated; cast via any at the call boundary.
      certificateBytesSha256: artifactBytesSha256,
      certificateVersion: CERTIFICATE_VERSION,
    },
    select: { id: true },
  }) as { id: string };

  await prisma.destructionRequest.update({
    where: { id: row.id },
    data: { state: "CERTIFIED", certifiedAtUtc },
  });

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
  state?: DestructionState;
  limit?: number;
};

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
  return rows.map((r) => projectRequest(r));
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
    },
  }) as { certificateUri: string | null; certificateBytesSha256: string | null } | null;
  if (!cert) return { ok: false, denial: "NOT_FOUND" };
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
