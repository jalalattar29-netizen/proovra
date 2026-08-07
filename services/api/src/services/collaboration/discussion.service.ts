/**
 * Phase 16 — Enterprise discussion service.
 *
 * All thread / message / participant / mention lifecycle is funnelled
 * through this single module so the canonical status transitions +
 * audit + notification dispatch live in one place.
 *
 * Wording rule: collaboration NEVER claims authenticity, admissibility,
 * fakery, or truth. Threads are operational. Audit events flow into
 * the existing `EvidenceReviewerAuditEvent` chain so reviewers see
 * collaboration in the same timeline as comments / annotations /
 * legal notes (Phase 13.5 audit pattern).
 */

import type {
  DiscussionMention as DbMention,
  DiscussionMessage as DbMessage,
  DiscussionMessageAuthorKind as DbAuthorKind,
  DiscussionParticipant as DbParticipant,
  DiscussionParticipantRole as DbRole,
  DiscussionThread as DbThread,
  DiscussionThreadKind as DbThreadKind,
  DiscussionThreadStatus as DbThreadStatus,
  DiscussionThreadVisibility as DbVisibility,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  DISCUSSION_BODY_MAX_BYTES,
  isAllowedDiscussionThreadTransition,
  parseMentionTokens,
  sanitiseDiscussionBody,
  type DiscussionMessageAuthorKind,
  type DiscussionThreadKind,
  type DiscussionThreadStatus,
  type DiscussionThreadVisibility,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { appendReviewerAuditEvent } from "../evidence-review/reviewer-audit.service.js";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class DiscussionError extends Error {
  constructor(
    public readonly code:
      | "evidence_not_in_workspace"
      | "thread_not_found"
      | "thread_terminal"
      | "invalid_status_transition"
      | "body_empty"
      | "body_too_long"
      | "not_participant"
      | "contributor_revoked"
      | "internal_only"
      | "user_not_found"
      | "service_account_forbidden",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "DiscussionError";
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function emitAudit(
  client: PrismaClient,
  evidenceId: string,
  actorUserId: string | null,
  eventType: Parameters<typeof appendReviewerAuditEvent>[0]["eventType"],
  metadata: Prisma.InputJsonValue | null,
): void {
  // Best-effort; never fail the caller on audit-chain hiccups.
  appendReviewerAuditEvent({
    evidenceId,
    actorUserId,
    eventType,
    metadata,
  }).catch(() => null);
}

async function loadEvidenceWorkspace(
  client: PrismaClient,
  evidenceId: string,
  teamId: string,
): Promise<void> {
  const ev = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, teamId: true, deletedAt: true },
  });
  if (!ev || ev.deletedAt || ev.teamId !== teamId) {
    throw new DiscussionError("evidence_not_in_workspace");
  }
}

// -----------------------------------------------------------------------------
// Create / read thread
// -----------------------------------------------------------------------------

export type CreateThreadInput = {
  teamId: string;
  evidenceId: string;
  evidenceRequestId?: string | null;
  kind: DiscussionThreadKind;
  visibility: DiscussionThreadVisibility;
  title: string;
  createdByUserId: string;
  /** Optional initial body posted as the first message. */
  initialBody?: string | null;
};

export async function createDiscussionThread(
  input: CreateThreadInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbThread> {
  await loadEvidenceWorkspace(client, input.evidenceId, input.teamId);

  const title = input.title.trim().slice(0, 180);
  if (!title) {
    throw new DiscussionError("body_empty", { field: "title" });
  }

  const thread = await client.discussionThread.create({
    data: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      evidenceRequestId: input.evidenceRequestId ?? null,
      kind: input.kind as DbThreadKind,
      visibility: input.visibility as DbVisibility,
      title,
      createdByUserId: input.createdByUserId,
    },
  });

  // Creator is implicit RESOLVER participant.
  await client.discussionParticipant.create({
    data: {
      threadId: thread.id,
      teamId: input.teamId,
      userId: input.createdByUserId,
      role: "RESOLVER" as DbRole,
      addedByUserId: input.createdByUserId,
    },
  });

  emitAudit(client, input.evidenceId, input.createdByUserId, "DISCUSSION_THREAD_CREATED", {
    threadId: thread.id,
    kind: thread.kind,
    visibility: thread.visibility,
    titleLength: title.length,
  });

  if (input.initialBody && input.initialBody.trim()) {
    await postMessage(
      {
        threadId: thread.id,
        teamId: input.teamId,
        authorKind: "USER",
        authorUserId: input.createdByUserId,
        body: input.initialBody,
      },
      client,
    );
  }

  return thread;
}

export async function getDiscussionThread(
  threadId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbThread | null> {
  return client.discussionThread.findUnique({ where: { id: threadId } });
}

export type ListThreadsInput = {
  teamId: string;
  evidenceId?: string;
  status?: DiscussionThreadStatus;
  visibility?: DiscussionThreadVisibility;
  assignedToUserId?: string;
  limit?: number;
};

export async function listDiscussionThreads(
  input: ListThreadsInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbThread[]> {
  return client.discussionThread.findMany({
    where: {
      teamId: input.teamId,
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
      ...(input.status ? { status: input.status as DbThreadStatus } : {}),
      ...(input.visibility
        ? { visibility: input.visibility as DbVisibility }
        : {}),
      ...(input.assignedToUserId
        ? { assignedToUserId: input.assignedToUserId }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

// -----------------------------------------------------------------------------
// Status transitions
// -----------------------------------------------------------------------------

async function applyStatusTransition(
  client: PrismaClient,
  thread: DbThread,
  to: DiscussionThreadStatus,
  patch: Prisma.DiscussionThreadUncheckedUpdateManyInput,
): Promise<DbThread> {
  const from = thread.status as DiscussionThreadStatus;
  if (!isAllowedDiscussionThreadTransition(from, to)) {
    throw new DiscussionError("invalid_status_transition", { from, to });
  }
  const claim = await client.discussionThread.updateMany({
    where: { id: thread.id, status: thread.status },
    data: { status: to as DbThreadStatus, ...patch },
  });
  if (claim.count !== 1) {
    // Race lost — return canonical state.
    return await client.discussionThread.findUniqueOrThrow({
      where: { id: thread.id },
    });
  }
  return client.discussionThread.findUniqueOrThrow({ where: { id: thread.id } });
}

export type ResolveThreadInput = {
  threadId: string;
  actorUserId: string;
  resolutionNote?: string | null;
};

export async function resolveDiscussionThread(
  input: ResolveThreadInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbThread> {
  const thread = await client.discussionThread.findUnique({
    where: { id: input.threadId },
  });
  if (!thread) throw new DiscussionError("thread_not_found");
  const updated = await applyStatusTransition(client, thread, "RESOLVED", {
    resolvedAtUtc: new Date(),
    resolvedByUserId: input.actorUserId,
    resolutionNote: input.resolutionNote?.slice(0, 1000) ?? null,
  });
  emitAudit(client, thread.evidenceId, input.actorUserId, "DISCUSSION_RESOLVED", {
    threadId: thread.id,
    fromStatus: thread.status,
  });
  return updated;
}

export type ReopenThreadInput = {
  threadId: string;
  actorUserId: string;
  reason: string;
};

export async function reopenDiscussionThread(
  input: ReopenThreadInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbThread> {
  const reason = input.reason.trim();
  if (!reason) throw new DiscussionError("body_empty", { field: "reason" });
  const thread = await client.discussionThread.findUnique({
    where: { id: input.threadId },
  });
  if (!thread) throw new DiscussionError("thread_not_found");
  const updated = await applyStatusTransition(client, thread, "IN_PROGRESS", {
    reopenedAtUtc: new Date(),
    reopenedByUserId: input.actorUserId,
    reopenCount: thread.reopenCount + 1,
    resolvedAtUtc: null,
    resolvedByUserId: null,
    resolutionNote: null,
  });
  emitAudit(client, thread.evidenceId, input.actorUserId, "DISCUSSION_REOPENED", {
    threadId: thread.id,
    reasonInternal: reason.slice(0, 400),
  });
  return updated;
}

export type AssignThreadInput = {
  threadId: string;
  actorUserId: string;
  assignedToUserId: string;
};

export async function assignDiscussionThread(
  input: AssignThreadInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbThread> {
  const thread = await client.discussionThread.findUnique({
    where: { id: input.threadId },
  });
  if (!thread) throw new DiscussionError("thread_not_found");
  if (thread.assignedToUserId === input.assignedToUserId) return thread;
  const updated = await applyStatusTransition(
    client,
    thread,
    thread.status as DiscussionThreadStatus,
    {
      assignedToUserId: input.assignedToUserId,
      assignedAtUtc: new Date(),
    },
  );
  // Ensure assignee is a participant.
  await client.discussionParticipant.upsert({
    where: {
      threadId_userId: {
        threadId: thread.id,
        userId: input.assignedToUserId,
      },
    },
    create: {
      threadId: thread.id,
      teamId: thread.teamId,
      userId: input.assignedToUserId,
      role: "RESOLVER" as DbRole,
      addedByUserId: input.actorUserId,
    },
    update: { role: "RESOLVER" as DbRole, revokedAtUtc: null },
  });
  emitAudit(client, thread.evidenceId, input.actorUserId, "DISCUSSION_ASSIGNED", {
    threadId: thread.id,
    assignedToUserId: input.assignedToUserId,
  });
  return updated;
}

export type EscalateThreadInput = {
  threadId: string;
  actorUserId: string;
  reason: string;
};

export async function escalateDiscussionThread(
  input: EscalateThreadInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbThread> {
  const reason = input.reason.trim();
  if (!reason) throw new DiscussionError("body_empty", { field: "reason" });
  const thread = await client.discussionThread.findUnique({
    where: { id: input.threadId },
  });
  if (!thread) throw new DiscussionError("thread_not_found");
  const updated = await applyStatusTransition(
    client,
    thread,
    "IN_PROGRESS",
    {
      escalatedAtUtc: new Date(),
      escalatedByUserId: input.actorUserId,
      escalationReason: reason.slice(0, 400),
    },
  );
  emitAudit(client, thread.evidenceId, input.actorUserId, "DISCUSSION_ESCALATED", {
    threadId: thread.id,
    // Reason captured INTERNALLY in the audit chain only.
    reasonInternal: reason.slice(0, 400),
  });
  return updated;
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

export type PostMessageInput = {
  threadId: string;
  teamId: string;
  authorKind: DiscussionMessageAuthorKind;
  authorUserId?: string | null;
  contributorIntakeSessionId?: string | null;
  contributorLabel?: string | null;
  body: string;
};

export async function postMessage(
  input: PostMessageInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbMessage> {
  if (input.authorKind === "USER" && !input.authorUserId) {
    throw new DiscussionError("user_not_found");
  }
  if (
    input.authorKind === "CONTRIBUTOR" &&
    !input.contributorIntakeSessionId
  ) {
    throw new DiscussionError("not_participant");
  }
  const body = sanitiseDiscussionBody(input.body);
  if (!body) throw new DiscussionError("body_empty");
  if (body.length > DISCUSSION_BODY_MAX_BYTES) {
    throw new DiscussionError("body_too_long");
  }
  const thread = await client.discussionThread.findUnique({
    where: { id: input.threadId },
  });
  if (!thread) throw new DiscussionError("thread_not_found");
  if (thread.status === "CLOSED") {
    throw new DiscussionError("thread_terminal");
  }
  // Workspace + visibility checks.
  if (thread.teamId !== input.teamId) {
    throw new DiscussionError("evidence_not_in_workspace");
  }
  if (
    input.authorKind === "CONTRIBUTOR" &&
    thread.visibility !== "CONTRIBUTOR_SCOPED"
  ) {
    throw new DiscussionError("internal_only");
  }
  // Contributor must be an active (non-revoked) participant of this thread.
  if (input.authorKind === "CONTRIBUTOR") {
    const participant = await client.discussionParticipant.findFirst({
      where: {
        threadId: thread.id,
        intakeSessionId: input.contributorIntakeSessionId,
        revokedAtUtc: null,
      },
    });
    if (!participant) {
      throw new DiscussionError("not_participant");
    }
  }

  const message = await client.discussionMessage.create({
    data: {
      threadId: thread.id,
      teamId: thread.teamId,
      authorKind: input.authorKind as DbAuthorKind,
      authorUserId: input.authorUserId ?? null,
      contributorIntakeSessionId:
        input.contributorIntakeSessionId ?? null,
      contributorLabel: input.contributorLabel?.slice(0, 180) ?? null,
      body,
    },
  });

  // Bump the thread's updatedAt so list ordering reflects activity.
  await client.discussionThread.update({
    where: { id: thread.id },
    data: { updatedAt: new Date() },
  });

  emitAudit(
    client,
    thread.evidenceId,
    input.authorUserId ?? null,
    input.authorKind === "CONTRIBUTOR"
      ? "CONTRIBUTOR_REPLY_RECEIVED"
      : "DISCUSSION_MESSAGE_POSTED",
    {
      threadId: thread.id,
      messageId: message.id,
      authorKind: input.authorKind,
      bodyLength: body.length,
    },
  );

  // Mention resolution (INTERNAL threads only — contributors can't @-mention).
  if (
    input.authorKind === "USER" &&
    thread.visibility === "INTERNAL" &&
    input.authorUserId
  ) {
    await resolveMentionsForMessage(
      message,
      body,
      input.authorUserId,
      client,
    );
  }

  return message;
}

async function resolveMentionsForMessage(
  message: DbMessage,
  body: string,
  actorUserId: string,
  client: PrismaClient,
): Promise<DbMention[]> {
  const tokens = parseMentionTokens(body);
  if (tokens.length === 0) return [];
  // Look up workspace members whose displayName / email local-part
  // matches one of the tokens. We MUST scope to the same workspace
  // as the thread.
  const thread = await client.discussionThread.findUnique({
    where: { id: message.threadId },
    select: { teamId: true },
  });
  if (!thread || !thread.teamId) return [];
  // PHASE 12 REMEDIATION (2026-08-06) — an @mention must not resolve to a
  // member who no longer has access; that would notify a revoked user about
  // workspace content.
  const members = await client.teamMember.findMany({
    where: { teamId: thread.teamId, status: "ACTIVE" },
    select: {
      userId: true,
      user: { select: { id: true, email: true, displayName: true } },
    },
  });
  const userByToken = new Map<string, string>();
  for (const m of members) {
    if (!m.user) continue;
    if (m.user.displayName) {
      const token = m.user.displayName.toLowerCase().replace(/[^a-z0-9._-]/g, "");
      if (token) userByToken.set(token, m.user.id);
    }
    if (m.user.email) {
      const local = m.user.email.split("@")[0]?.toLowerCase() ?? "";
      if (local) userByToken.set(local, m.user.id);
    }
  }
  const out: DbMention[] = [];
  for (const tok of tokens) {
    const userId = userByToken.get(tok);
    if (!userId) continue;
    try {
      const row = await client.discussionMention.create({
        data: {
          messageId: message.id,
          threadId: message.threadId,
          teamId: message.teamId,
          mentionedUserId: userId,
        },
      });
      out.push(row);
      emitAudit(
        client,
        // We need evidence id for audit; cheaper to re-fetch than to
        // thread-query a sentinel.
        (await client.discussionThread.findUniqueOrThrow({
          where: { id: message.threadId },
          select: { evidenceId: true },
        })).evidenceId,
        actorUserId,
        "MENTION_CREATED",
        {
          threadId: message.threadId,
          messageId: message.id,
          mentionedUserId: userId,
          token: tok,
        },
      );
    } catch {
      /* unique constraint — already mentioned in this message */
    }
  }
  return out;
}

export async function listMessagesForThread(
  threadId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbMessage[]> {
  return client.discussionMessage.findMany({
    where: { threadId, deletedAtUtc: null },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
}

// -----------------------------------------------------------------------------
// Participants — contributor access lifecycle
// -----------------------------------------------------------------------------

export type GrantContributorAccessInput = {
  threadId: string;
  teamId: string;
  intakeSessionId: string;
  contributorLabel?: string | null;
  actorUserId: string;
};

export async function grantContributorAccess(
  input: GrantContributorAccessInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbParticipant> {
  const thread = await client.discussionThread.findUnique({
    where: { id: input.threadId },
  });
  if (!thread) throw new DiscussionError("thread_not_found");
  if (thread.teamId !== input.teamId) {
    throw new DiscussionError("evidence_not_in_workspace");
  }
  if (thread.visibility !== "CONTRIBUTOR_SCOPED") {
    throw new DiscussionError("internal_only");
  }
  const existing = await client.discussionParticipant.findFirst({
    where: { threadId: thread.id, intakeSessionId: input.intakeSessionId },
  });
  let row: DbParticipant;
  if (existing) {
    row = await client.discussionParticipant.update({
      where: { id: existing.id },
      data: { revokedAtUtc: null, revokedByUserId: null },
    });
  } else {
    row = await client.discussionParticipant.create({
      data: {
        threadId: thread.id,
        teamId: thread.teamId,
        intakeSessionId: input.intakeSessionId,
        role: "CONTRIBUTOR" as DbRole,
        addedByUserId: input.actorUserId,
      },
    });
  }
  emitAudit(
    client,
    thread.evidenceId,
    input.actorUserId,
    "CONTRIBUTOR_ACCESS_GRANTED",
    {
      threadId: thread.id,
      intakeSessionId: input.intakeSessionId,
      contributorLabel: input.contributorLabel?.slice(0, 180) ?? null,
    },
  );
  return row;
}

export async function revokeContributorAccess(
  input: {
    threadId: string;
    teamId: string;
    intakeSessionId: string;
    actorUserId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbParticipant | null> {
  const thread = await client.discussionThread.findUnique({
    where: { id: input.threadId },
  });
  if (!thread) throw new DiscussionError("thread_not_found");
  if (thread.teamId !== input.teamId) {
    throw new DiscussionError("evidence_not_in_workspace");
  }
  const row = await client.discussionParticipant.findFirst({
    where: {
      threadId: thread.id,
      intakeSessionId: input.intakeSessionId,
    },
  });
  if (!row) return null;
  const updated = await client.discussionParticipant.update({
    where: { id: row.id },
    data: {
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
    },
  });
  emitAudit(
    client,
    thread.evidenceId,
    input.actorUserId,
    "CONTRIBUTOR_ACCESS_REVOKED",
    {
      threadId: thread.id,
      intakeSessionId: input.intakeSessionId,
    },
  );
  return updated;
}

// -----------------------------------------------------------------------------
// Safe projection
// -----------------------------------------------------------------------------
//
// Phase 12 Point 4 (Pass E) — `DiscussionThreadCounts` +
// `countDiscussionThreads` were removed with `GET /v1/collaboration/threads/
// counts`. That endpoint served the workspace-wide thread counter on the
// standalone `/collaboration` console, which the IA-collapse decision
// retired behind a permanent redirect to /inbox; deleting the unreachable
// page left the route with zero product consumers. Per-thread reads and
// writes (the evidence-detail Discussion surface) are unaffected.
export function projectDiscussionThread(t: DbThread): {
  id: string;
  evidenceId: string;
  evidenceRequestId: string | null;
  kind: string;
  status: string;
  visibility: string;
  title: string;
  createdByUserId: string;
  assignedToUserId: string | null;
  resolvedAtUtc: string | null;
  reopenCount: number;
  escalatedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
  // Deliberately omitted: resolutionNote, escalationReason — internal
  // only. Detail route surfaces these to permitted readers separately.
} {
  return {
    id: t.id,
    evidenceId: t.evidenceId,
    evidenceRequestId: t.evidenceRequestId,
    kind: t.kind,
    status: t.status,
    visibility: t.visibility,
    title: t.title,
    createdByUserId: t.createdByUserId,
    assignedToUserId: t.assignedToUserId,
    resolvedAtUtc: t.resolvedAtUtc?.toISOString() ?? null,
    reopenCount: t.reopenCount,
    escalatedAtUtc: t.escalatedAtUtc?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function projectDiscussionMessage(m: DbMessage): {
  id: string;
  threadId: string;
  authorKind: string;
  authorUserId: string | null;
  contributorLabel: string | null;
  body: string;
  editedAtUtc: string | null;
  createdAt: string;
} {
  return {
    id: m.id,
    threadId: m.threadId,
    authorKind: m.authorKind,
    authorUserId: m.authorUserId,
    contributorLabel: m.contributorLabel,
    body: m.body,
    editedAtUtc: m.editedAtUtc?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

export function projectDiscussionParticipant(p: DbParticipant): {
  id: string;
  userId: string | null;
  intakeSessionId: string | null;
  role: string;
  addedAtUtc: string;
  revoked: boolean;
} {
  return {
    id: p.id,
    userId: p.userId,
    intakeSessionId: p.intakeSessionId,
    role: p.role,
    addedAtUtc: p.addedAtUtc.toISOString(),
    revoked: p.revokedAtUtc !== null,
  };
}

// -----------------------------------------------------------------------------
// Access guard — used by routes
// -----------------------------------------------------------------------------

/**
 * Determines whether the caller may READ a thread. For INTERNAL
 * threads: any workspace member can read. For CONTRIBUTOR_SCOPED
 * threads: a contributor whose intake session is a non-revoked
 * participant may read; workspace members always can.
 */
export async function canReadThread(
  thread: DbThread,
  ctx:
    | { kind: "user"; userId: string; isMember: boolean }
    | { kind: "contributor"; intakeSessionId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (ctx.kind === "user") {
    return ctx.isMember;
  }
  if (thread.visibility !== "CONTRIBUTOR_SCOPED") return false;
  const participant = await client.discussionParticipant.findFirst({
    where: {
      threadId: thread.id,
      intakeSessionId: ctx.intakeSessionId,
      revokedAtUtc: null,
    },
  });
  return !!participant;
}
