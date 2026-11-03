/**
 * PROOVRA Phase 4B — Chain Transfer service.
 *
 * Workspace-anchored lifecycle for cross-organization chain-of-custody
 * transfers. State machine:
 *
 *   INITIATED → (ACCEPTED | REJECTED | EXPIRED | REVOKED)
 *   ACCEPTED  → COMPLETED
 *
 * Hard rules:
 *   * Every entry point is workspace-anchored (teamId).
 *   * (AUTHZ-007) A transfer names a real organization, and ACCEPTED or REJECTED
 *     is that organization's act: only a member of a workspace in it can record
 *     either, and to anyone else the transfer does not exist. These states reach
 *     the custody chain, which must never claim a counterparty did something it
 *     did not. The sender can initiate, revoke and complete.
 *   * The recipient label (`toOrganizationSlug`) is free text for display:
 *     organizations have no slug, so identity is `toOrganizationId`.
 *   * Webhook emission is forward-declared (best-effort) and MUST
 *     never break the operational write.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { appendCustodyEventTx, workspaceEvidenceWhere } from "@proovra/shared-runtime";
import { allOpen, hiddenRecordIdsInWorkspace } from "../access/record-reach.js";
import { evidenceVisibleThroughCasesWhere } from "../cases/case-visibility.js";
import {
  CHAIN_TRANSFER_STATES,
  type ChainTransferProjection,
  type ChainTransferState,
  type WebhookEventKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Forward-declared webhook emitter (implemented by the webhook-platform
// service in a sibling change set). Wrapped in try/catch so we degrade
// silently if the module is not yet present at runtime.
// ---------------------------------------------------------------------------

type WebhookEmitter = (input: {
  prisma?: PrismaClient;
  teamId: string;
  eventKind: WebhookEventKind;
  payload: Record<string, unknown>;
}) => Promise<unknown> | unknown;

async function tryEmitWebhookEvent(
  eventKind: WebhookEventKind,
  payload: Record<string, unknown>,
  ctx: { prisma?: PrismaClient; teamId: string },
): Promise<void> {
  try {
    const mod = (await import(
      "../packaging/webhooks/webhook-platform.service.js"
    ).catch(() => ({}))) as { emitWebhookEvent?: WebhookEmitter };
    if (typeof mod.emitWebhookEvent === "function") {
      await mod.emitWebhookEvent({
        prisma: ctx.prisma,
        teamId: ctx.teamId,
        eventKind,
        payload,
      });
    }
  } catch {
    // Audit / fan-out failure MUST never break the operational write.
  }
}

// ---------------------------------------------------------------------------
// Custody continuity on transfer (ET-CUS-02)
// ---------------------------------------------------------------------------

/**
 * Appends CHAIN_TRANSFER_CUSTODY_EXTENDED to every evidence record of the
 * transfer, INSIDE the transaction that changes the transfer's state. Until
 * 2026-09-29 this was a fire-and-forget append of an event type that did not
 * exist in the enum, with the failure swallowed: no hand-off between
 * organisations ever reached a custody chain.
 */
async function appendTransferCustodyTx(
  tx: Prisma.TransactionClient,
  evidenceIds: ReadonlyArray<string>,
  payload: {
    transferId: string;
    fromOrganizationId: string;
    toOrganizationId?: string | null;
    toOrganizationSlug: string;
    state: string;
    actorUserId: string | null;
    /** The organization whose member acted. */
    actorOrganizationId?: string | null;
    transitionedAt: Date;
  },
): Promise<void> {
  for (const evidenceId of evidenceIds) {
    await appendCustodyEventTx(tx, {
      evidenceId,
      eventType: prismaPkg.CustodyEventType.CHAIN_TRANSFER_CUSTODY_EXTENDED,
      atUtc: payload.transitionedAt,
      payload: {
        transferId: payload.transferId,
        fromOrganizationId: payload.fromOrganizationId,
        toOrganizationId: payload.toOrganizationId ?? null,
        toOrganizationSlug: payload.toOrganizationSlug,
        state: payload.state,
        actorUserId: payload.actorUserId,
        actorOrganizationId: payload.actorOrganizationId ?? null,
      },
    });
  }
}

/**
 * The transfer as its RECIPIENT sees it. Anyone but a workspace of the receiving
 * organization gets nothing, the same answer as an id that does not exist, and
 * that includes the sender: a transfer's own initiator cannot accept it.
 */
async function loadForRecipient(prisma: PrismaClient, transferId: string, teamId: string) {
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { organizationId: true } });
  if (!team?.organizationId) return null;
  const row = await prisma.chainTransfer.findUnique({
    where: { id: transferId },
    select: {
      id: true,
      teamId: true,
      state: true,
      fromOrganizationId: true,
      toOrganizationId: true,
      toOrganizationSlug: true,
      evidenceIds: true,
      expiresAtUtc: true,
    },
  });
  if (!row || row.toOrganizationId !== team.organizationId) return null;
  return { row, recipientOrganizationId: team.organizationId };
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

const TERMINAL_STATES: ReadonlyArray<ChainTransferState> = [
  "REJECTED",
  "EXPIRED",
  "REVOKED",
  "COMPLETED",
];

// ---------------------------------------------------------------------------
// initiateChainTransfer
// ---------------------------------------------------------------------------

export type InitiateChainTransferInput = {
  prisma?: PrismaClient;
  teamId: string;
  fromOrganizationId: string;
  /** The receiving organization. */
  toOrganizationId: string;
  /** Display label for the recipient. */
  toOrganizationSlug?: string | null;
  evidenceIds: ReadonlyArray<string>;
  caseId?: string | null;
  initiatedByUserId: string;
  reasonNote?: string | null;
  expiresAtUtc?: string | Date | null;
};

export type InitiateChainTransferResult =
  | { ok: true; transferId: string }
  | { ok: false; denial: "INVALID_EVIDENCE" | "INVALID_SLUG" | "INVALID_ORGANIZATION" };

export async function initiateChainTransfer(
  input: InitiateChainTransferInput,
): Promise<InitiateChainTransferResult> {
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
    return { ok: false, denial: "INVALID_EVIDENCE" };
  }
  const recipientLabel = input.toOrganizationSlug ?? input.toOrganizationId;
  if (input.toOrganizationSlug != null && !SLUG_PATTERN.test(input.toOrganizationSlug)) {
    return { ok: false, denial: "INVALID_SLUG" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const expiresAt =
    input.expiresAtUtc == null
      ? null
      : input.expiresAtUtc instanceof Date
        ? input.expiresAtUtc
        : new Date(input.expiresAtUtc);
  // ET-CUS-02: the request body names the evidence and the sending
  // organisation; both must be THIS workspace's. Otherwise a caller could
  // extend other tenants' custody chains.
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: { organizationId: true },
  });
  if (!team?.organizationId || team.organizationId !== input.fromOrganizationId) {
    return { ok: false, denial: "INVALID_ORGANIZATION" };
  }
  // AUTHZ-007 — a transfer to nobody, or to itself, could only ever be accepted by
  // the sender.
  if (input.toOrganizationId === input.fromOrganizationId) {
    return { ok: false, denial: "INVALID_ORGANIZATION" };
  }
  const recipient = await prisma.organization.findUnique({
    where: { id: input.toOrganizationId },
    select: { id: true },
  });
  if (!recipient) return { ok: false, denial: "INVALID_ORGANIZATION" };
  const evidenceIds = [...new Set(input.evidenceIds)];
  const scope = await workspaceEvidenceWhere(input.teamId, prisma);
  const owned = await prisma.evidence.count({
    where: {
      AND: [scope, evidenceVisibleThroughCasesWhere(input.initiatedByUserId)],
      id: { in: evidenceIds },
      deletedAt: null,
    },
  });
  if (owned !== evidenceIds.length) return { ok: false, denial: "INVALID_EVIDENCE" };

  const initiatedAt = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.chainTransfer.create({
      data: {
        teamId: input.teamId,
        fromOrganizationId: input.fromOrganizationId,
        toOrganizationId: input.toOrganizationId,
        toOrganizationSlug: recipientLabel.slice(0, 64),
        evidenceIds: evidenceIds as unknown as object,
        caseId: input.caseId ?? null,
        state: "INITIATED",
        reasonNote: input.reasonNote?.slice(0, 400) ?? null,
        expiresAtUtc: expiresAt,
        initiatedByUserId: input.initiatedByUserId,
      },
      select: { id: true },
    });
    await appendTransferCustodyTx(tx, evidenceIds, {
      transferId: created.id,
      fromOrganizationId: input.fromOrganizationId,
      toOrganizationId: input.toOrganizationId,
      toOrganizationSlug: recipientLabel,
      state: "INITIATED",
      actorUserId: input.initiatedByUserId,
      actorOrganizationId: input.fromOrganizationId,
      transitionedAt: initiatedAt,
    });
    return created;
  });
  void tryEmitWebhookEvent(
    "CHAIN_TRANSFER_INITIATED",
    {
      transferId: row.id,
      fromOrganizationId: input.fromOrganizationId,
      toOrganizationSlug: recipientLabel,
      evidenceCount: input.evidenceIds.length,
    },
    { prisma, teamId: input.teamId },
  );
  return { ok: true, transferId: row.id };
}

// ---------------------------------------------------------------------------
// acceptChainTransfer
// ---------------------------------------------------------------------------

export type AcceptChainTransferInput = {
  prisma?: PrismaClient;
  /** The accepting member's workspace, in the receiving organization. */
  teamId: string;
  transferId: string;
  acceptingUserId: string;
};

export type AcceptChainTransferResult =
  | { ok: true }
  | { ok: false; denial: "NOT_FOUND" | "INVALID_STATE" };

/** May this caller act on this transfer? False when it does not exist too. */
export async function chainTransferOpenTo(input: {
  prisma?: PrismaClient;
  teamId: string;
  transferId: string;
  userId: string;
}): Promise<boolean> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.chainTransfer.findUnique({
    where: { id: input.transferId },
    select: { teamId: true, evidenceIds: true },
  });
  if (!row) return false;
  // The case rule is the sending workspace's. A receiving workspace holds no
  // such case, and each service decides whether this workspace may act at all.
  if (row.teamId !== input.teamId) return true;
  const closed = await hiddenRecordIdsInWorkspace(input.teamId, input.userId, prisma);
  return allOpen(Array.isArray(row.evidenceIds) ? (row.evidenceIds as string[]) : [], closed.evidenceIds);
}

export async function acceptChainTransfer(
  input: AcceptChainTransferInput,
): Promise<AcceptChainTransferResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const found = await loadForRecipient(prisma, input.transferId, input.teamId);
  if (!found) return { ok: false, denial: "NOT_FOUND" };
  const { row, recipientOrganizationId } = found;
  if (row.state !== "INITIATED") return { ok: false, denial: "INVALID_STATE" };
  const at = new Date();
  if (row.expiresAtUtc && row.expiresAtUtc.getTime() <= at.getTime()) {
    return { ok: false, denial: "INVALID_STATE" };
  }
  const moved = await prisma.$transaction(async (tx) => {
    const claim = await tx.chainTransfer.updateMany({
      where: { id: row.id, state: "INITIATED" },
      data: {
        state: "ACCEPTED",
        acceptedByUserId: input.acceptingUserId,
        respondedAtUtc: at,
      },
    });
    if (claim.count !== 1) return false;
    await appendTransferCustodyTx(tx, idsOf(row.evidenceIds), {
      transferId: row.id,
      fromOrganizationId: row.fromOrganizationId,
      toOrganizationId: row.toOrganizationId,
      toOrganizationSlug: row.toOrganizationSlug,
      state: "ACCEPTED",
      actorUserId: input.acceptingUserId,
      actorOrganizationId: recipientOrganizationId,
      transitionedAt: at,
    });
    return true;
  });
  if (!moved) return { ok: false, denial: "INVALID_STATE" };
  void tryEmitWebhookEvent(
    "CHAIN_TRANSFER_ACCEPTED",
    {
      transferId: row.id,
      fromOrganizationId: row.fromOrganizationId,
      toOrganizationSlug: row.toOrganizationSlug,
      acceptingUserId: input.acceptingUserId,
    },
    // The sender's endpoints hear about it: the event belongs to their transfer.
    { prisma, teamId: row.teamId },
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// rejectChainTransfer
// ---------------------------------------------------------------------------

export type RejectChainTransferInput = {
  prisma?: PrismaClient;
  teamId: string;
  transferId: string;
  rejectingUserId: string;
  reason?: string | null;
};

export type RejectChainTransferResult =
  | { ok: true }
  | { ok: false; denial: "NOT_FOUND" | "INVALID_STATE" };

export async function rejectChainTransfer(
  input: RejectChainTransferInput,
): Promise<RejectChainTransferResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const found = await loadForRecipient(prisma, input.transferId, input.teamId);
  if (!found) return { ok: false, denial: "NOT_FOUND" };
  const { row, recipientOrganizationId } = found;
  if (row.state !== "INITIATED") return { ok: false, denial: "INVALID_STATE" };
  const at = new Date();
  const moved = await prisma.$transaction(async (tx) => {
    const claim = await tx.chainTransfer.updateMany({
      where: { id: row.id, state: "INITIATED" },
      data: {
        state: "REJECTED",
        rejectedByUserId: input.rejectingUserId,
        respondedAtUtc: at,
        ...(input.reason != null ? { reasonNote: input.reason.slice(0, 400) } : {}),
      },
    });
    if (claim.count !== 1) return false;
    await appendTransferCustodyTx(tx, idsOf(row.evidenceIds), {
      transferId: row.id,
      fromOrganizationId: row.fromOrganizationId,
      toOrganizationId: row.toOrganizationId,
      toOrganizationSlug: row.toOrganizationSlug,
      state: "REJECTED",
      actorUserId: input.rejectingUserId,
      actorOrganizationId: recipientOrganizationId,
      transitionedAt: at,
    });
    return true;
  });
  if (!moved) return { ok: false, denial: "INVALID_STATE" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// revokeChainTransfer
// ---------------------------------------------------------------------------

export type RevokeChainTransferInput = {
  prisma?: PrismaClient;
  teamId: string;
  transferId: string;
  actorUserId: string;
};

export type RevokeChainTransferResult =
  | { ok: true }
  | { ok: false; denial: "NOT_FOUND" | "INVALID_STATE" };

export async function revokeChainTransfer(
  input: RevokeChainTransferInput,
): Promise<RevokeChainTransferResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.chainTransfer.findFirst({
    where: { id: input.transferId, teamId: input.teamId },
    select: { id: true, state: true, evidenceIds: true, fromOrganizationId: true, toOrganizationSlug: true },
  });
  if (!row) return { ok: false, denial: "NOT_FOUND" };
  if (
    (TERMINAL_STATES as ReadonlyArray<string>).includes(row.state)
  ) {
    return { ok: false, denial: "INVALID_STATE" };
  }
  const at = new Date();
  const moved = await prisma.$transaction(async (tx) => {
    const claim = await tx.chainTransfer.updateMany({
      where: { id: row.id, state: { notIn: [...TERMINAL_STATES] } },
      data: { state: "REVOKED", respondedAtUtc: at },
    });
    if (claim.count !== 1) return false;
    await appendTransferCustodyTx(tx, idsOf(row.evidenceIds), {
      transferId: row.id,
      fromOrganizationId: row.fromOrganizationId,
      toOrganizationSlug: row.toOrganizationSlug,
      state: "REVOKED",
      actorUserId: input.actorUserId,
      transitionedAt: at,
    });
    return true;
  });
  if (!moved) return { ok: false, denial: "INVALID_STATE" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// completeChainTransfer
// ---------------------------------------------------------------------------

export type CompleteChainTransferInput = {
  prisma?: PrismaClient;
  teamId: string;
  transferId: string;
  packageId: string;
  actorUserId?: string | null;
};

export type CompleteChainTransferResult =
  | { ok: true }
  | { ok: false; denial: "NOT_FOUND" | "INVALID_STATE" };

export async function completeChainTransfer(
  input: CompleteChainTransferInput,
): Promise<CompleteChainTransferResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.chainTransfer.findFirst({
    where: { id: input.transferId, teamId: input.teamId },
    select: { id: true, state: true, evidenceIds: true, fromOrganizationId: true, toOrganizationSlug: true },
  });
  if (!row) return { ok: false, denial: "NOT_FOUND" };
  if (row.state !== "ACCEPTED") return { ok: false, denial: "INVALID_STATE" };
  // The package a transfer closes on is part of its custody record, so it must be
  // this workspace's own. It was stored as given.
  const ownPackage = await prisma.evidenceExchangePackage.count({
    where: { id: input.packageId, teamId: input.teamId },
  });
  if (ownPackage !== 1) return { ok: false, denial: "NOT_FOUND" };
  const at = new Date();
  const moved = await prisma.$transaction(async (tx) => {
    const claim = await tx.chainTransfer.updateMany({
      where: { id: row.id, state: "ACCEPTED" },
      data: { state: "COMPLETED", packageId: input.packageId, completedAtUtc: at },
    });
    if (claim.count !== 1) return false;
    await appendTransferCustodyTx(tx, idsOf(row.evidenceIds), {
      transferId: row.id,
      fromOrganizationId: row.fromOrganizationId,
      toOrganizationSlug: row.toOrganizationSlug,
      state: "COMPLETED",
      actorUserId: input.actorUserId ?? null,
      transitionedAt: at,
    });
    return true;
  });
  if (!moved) return { ok: false, denial: "INVALID_STATE" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// listChainTransfers
// ---------------------------------------------------------------------------

export type ListChainTransfersInput = {
  prisma?: PrismaClient;
  teamId: string;
  /** The reader: a transfer of a record closed to them is not listed. */
  viewerUserId: string;
  state?: ChainTransferState;
};

export async function listChainTransfers(
  input: ListChainTransfersInput,
): Promise<ReadonlyArray<ChainTransferProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  // A transfer is visible to the workspace that sent it and to any workspace of
  // the organization receiving it: the recipient had no read at all. The sending
  // workspace's own readers still lose a transfer of a record closed to them.
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: { organizationId: true },
  });
  const closed = await hiddenRecordIdsInWorkspace(input.teamId, input.viewerUserId, prisma);
  const rows = (
    await prisma.chainTransfer.findMany({
      where: {
        OR: [
          { teamId: input.teamId },
          ...(team?.organizationId ? [{ toOrganizationId: team.organizationId }] : []),
        ],
        ...(input.state ? { state: input.state } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
  ).filter((r) => allOpen(Array.isArray(r.evidenceIds) ? (r.evidenceIds as string[]) : [], closed.evidenceIds));
  return rows.map((r) => ({
    direction: r.teamId === input.teamId ? ("OUTGOING" as const) : ("INCOMING" as const),
    id: r.id,
    teamId: r.teamId,
    fromOrganizationId: r.fromOrganizationId,
    toOrganizationSlug: r.toOrganizationSlug,
    toOrganizationId: r.toOrganizationId,
    evidenceIds: Array.isArray(r.evidenceIds)
      ? (r.evidenceIds as ReadonlyArray<string>)
      : [],
    caseId: r.caseId,
    state: r.state as ChainTransferState,
    packageId: r.packageId,
    reasonNote: r.reasonNote,
    expiresAtUtc: r.expiresAtUtc?.toISOString() ?? null,
    initiatedByUserId: r.initiatedByUserId,
    acceptedByUserId: r.acceptedByUserId,
    rejectedByUserId: r.rejectedByUserId,
    createdAt: r.createdAt.toISOString(),
    respondedAtUtc: r.respondedAtUtc?.toISOString() ?? null,
    completedAtUtc: r.completedAtUtc?.toISOString() ?? null,
  }));
}

// Compile-time guard.
function _assertEnumsIntact(): void {
  const _s: ChainTransferState = "INITIATED";
  void _s;
  void CHAIN_TRANSFER_STATES;
}
void _assertEnumsIntact;
