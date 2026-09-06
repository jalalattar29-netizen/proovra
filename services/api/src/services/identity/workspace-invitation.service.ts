/**
 * THE canonical Workspace invitation lifecycle.
 *
 * =============================================================================
 * WHY IT IS ONE SERVICE
 * =============================================================================
 * PROOVRA had three invitation implementations and they agreed on nothing:
 *
 *   `OrganizationInvite`      hashed, revocable, resendable, atomic accept
 *   `TeamInvite`              PLAINTEXT token, returned in API responses,
 *                             "revoked" by deleting the row, no resend record
 *   `CollaborationTeamInvite` hashed, but unbound to the invited address, with
 *                             a non-atomic claim and a broken accept path
 *
 * The third is retired (a Collaboration Team is built from people who are
 * already in the workspace — it has nothing to invite). The other two both
 * grant tenancy, so they get one implementation of the parts that decide
 * whether an invitation is safe: token generation, storage, expiry, revocation,
 * resend, and the atomic single-use claim.
 *
 * This module owns that for the WORKSPACE. Organization invitations keep their
 * own service because their governance genuinely differs — they also carry
 * organization membership and workspace assignments — but they share the same
 * shape, the same column names and the same guarantees, so a reader moving
 * between them is reading one design rather than two.
 *
 * =============================================================================
 * WHAT IT GUARANTEES
 * =============================================================================
 *   - The raw token exists for exactly as long as it takes to put it in an
 *     email. It is NEVER persisted, NEVER returned by a list endpoint, and
 *     NEVER logged.
 *   - Acceptance is bound to the invited address, and the claim is a single
 *     conditional UPDATE, so two concurrent accepts cannot both provision.
 *   - The seat is claimed under a per-workspace advisory lock, so two accepts
 *     of DIFFERENT invitations cannot both take the last seat.
 *   - Revocation is a recorded state. An invitation that was sent and
 *     withdrawn stays visible; deleting the row would erase the fact.
 *   - Resend ROTATES the token. A resent link makes the previous one useless,
 *     which is what an operator means when they resend after a mis-delivery.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { provisionMembership } from "./membership-provisioning.service.js";
import { resolveWorkspaceSeatState } from "../billing/workspace-seats.service.js";

export class WorkspaceInvitationError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    httpStatus = 400,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkspaceInvitationError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** 7 days, matching the organization invitation. */
export const WORKSPACE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeInviteEmail(value: string): string {
  return value.trim().toLowerCase();
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * 256 bits, url-safe, prefixed so a value found in a log or a support ticket is
 * immediately identifiable as a workspace invitation token that needs revoking.
 */
function mintToken(): { raw: string; hash: string } {
  const raw = `wsit_v1_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

export type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export function invitationStatus(invite: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InvitationStatus {
  if (invite.acceptedAt) return "ACCEPTED";
  if (invite.revokedAt) return "REVOKED";
  if (invite.expiresAt.getTime() <= Date.now()) return "EXPIRED";
  return "PENDING";
}

/**
 * The safe projection.
 *
 * There is no `inviteUrl` and no `token`. The create and resend calls return
 * the raw token to their OWN caller so it can be delivered; everything that
 * lists invitations describes them instead.
 */
export type WorkspaceInvitationView = {
  id: string;
  email: string;
  role: prismaPkg.TeamRole;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  lastResentAt: Date | null;
  resendCount: number;
};

export function projectInvitation(invite: {
  id: string;
  email: string;
  role: prismaPkg.TeamRole;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  lastResentAt: Date | null;
  resendCount: number;
}): WorkspaceInvitationView {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invitationStatus(invite),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt,
    revokedAt: invite.revokedAt,
    lastResentAt: invite.lastResentAt,
    resendCount: invite.resendCount,
  };
}

// =============================================================================
// Create
// =============================================================================

export type CreatedWorkspaceInvitation = {
  invite: WorkspaceInvitationView;
  /** Returned ONCE, to the caller that will deliver it. Never persisted. */
  rawToken: string;
};

/**
 * Create a pending invitation, or refuse with a typed conflict.
 *
 * Duplicate suppression is the database's job now: a partial unique index over
 * `(team_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL`
 * makes "one live invitation per address per workspace" a constraint rather
 * than a read the route performed and then raced against.
 */
export async function createWorkspaceInvitation(
  input: {
    workspaceId: string;
    email: string;
    role: prismaPkg.TeamRole;
    invitedByUserId: string;
    expiresInMs?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<CreatedWorkspaceInvitation> {
  const email = normalizeInviteEmail(input.email);
  const { raw, hash } = mintToken();
  const expiresAt = new Date(
    Date.now() + (input.expiresInMs ?? WORKSPACE_INVITE_TTL_MS),
  );

  try {
    const created = await client.teamInvite.create({
      data: {
        teamId: input.workspaceId,
        email,
        role: input.role,
        token: null,
        tokenHash: hash,
        invitedByUserId: input.invitedByUserId,
        expiresAt,
      },
    });
    return { invite: projectInvitation(created), rawToken: raw };
  } catch (err) {
    if (
      err instanceof prismaPkg.Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new WorkspaceInvitationError(
        "INVITE_ALREADY_PENDING",
        "There is already a pending invitation for that address. Resend or revoke it instead.",
        409,
        { email },
      );
    }
    throw err;
  }
}

// =============================================================================
// Resend
// =============================================================================

/**
 * Rotate the token and extend the window.
 *
 * Rotation is the point. An operator resends because the first link did not
 * arrive or went somewhere it should not have; leaving the old token valid
 * would mean the resend fixed the delivery and not the exposure.
 */
export async function resendWorkspaceInvitation(
  input: { workspaceId: string; inviteId: string; expiresInMs?: number },
  client: PrismaClient = defaultPrisma,
): Promise<CreatedWorkspaceInvitation> {
  const existing = await client.teamInvite.findFirst({
    where: { id: input.inviteId, teamId: input.workspaceId },
  });
  if (!existing) {
    throw new WorkspaceInvitationError(
      "INVITE_NOT_FOUND",
      "Invitation not found.",
      404,
    );
  }
  const status = invitationStatus(existing);
  if (status === "ACCEPTED" || status === "REVOKED") {
    throw new WorkspaceInvitationError(
      "INVITE_NOT_PENDING",
      `This invitation is ${status.toLowerCase()} and cannot be resent.`,
      409,
      { status },
    );
  }

  const { raw, hash } = mintToken();
  const updated = await client.teamInvite.update({
    where: { id: existing.id },
    data: {
      tokenHash: hash,
      token: null,
      expiresAt: new Date(
        Date.now() + (input.expiresInMs ?? WORKSPACE_INVITE_TTL_MS),
      ),
      lastResentAt: new Date(),
      resendCount: { increment: 1 },
    },
  });
  return { invite: projectInvitation(updated), rawToken: raw };
}

// =============================================================================
// Revoke
// =============================================================================

export async function revokeWorkspaceInvitation(
  input: { workspaceId: string; inviteId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceInvitationView> {
  const existing = await client.teamInvite.findFirst({
    where: { id: input.inviteId, teamId: input.workspaceId },
  });
  if (!existing) {
    throw new WorkspaceInvitationError(
      "INVITE_NOT_FOUND",
      "Invitation not found.",
      404,
    );
  }
  if (existing.acceptedAt) {
    throw new WorkspaceInvitationError(
      "INVITE_NOT_PENDING",
      "This invitation was already accepted. Remove the member instead.",
      409,
    );
  }
  if (existing.revokedAt) return projectInvitation(existing);

  const updated = await client.teamInvite.update({
    where: { id: existing.id },
    data: {
      revokedAt: new Date(),
      revokedByUserId: input.actorUserId,
      // The token dies with the invitation. Keeping a revoked hash resolvable
      // would leave the link working until it expired.
      tokenHash: hashToken(`revoked:${existing.id}:${randomBytes(16).toString("hex")}`),
    },
  });
  return projectInvitation(updated);
}

// =============================================================================
// Accept
// =============================================================================

export type AcceptResult = {
  workspaceId: string;
  role: prismaPkg.TeamRole;
  alreadyMember: boolean;
};

/**
 * Claim an invitation and provision the membership, atomically.
 *
 * Three things happen in ONE transaction, in this order, and the order matters:
 *
 *   1. a per-workspace advisory lock, so seat arithmetic is serialised across
 *      API instances rather than merely across one event loop;
 *   2. the seat check, re-evaluated under that lock;
 *   3. a guarded claim of the invitation row, which decides the race between
 *      two accepts of the SAME link.
 *
 * The previous implementation had (3) and not (1) or (2): the seat count was
 * taken before the transaction opened, so N concurrent accepts of N DIFFERENT
 * invitations all saw the same "one seat left" and all provisioned.
 */
export async function acceptWorkspaceInvitation(
  input: { rawToken: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<AcceptResult> {
  const hash = hashToken(input.rawToken);
  const invite = await client.teamInvite.findFirst({
    where: { tokenHash: hash },
  });
  if (!invite) {
    throw new WorkspaceInvitationError(
      "INVITE_NOT_FOUND",
      "This invitation does not exist. Ask for a new one.",
      404,
    );
  }

  const status = invitationStatus(invite);
  if (status === "REVOKED") {
    throw new WorkspaceInvitationError(
      "INVITE_REVOKED",
      "This invitation has been revoked.",
      410,
    );
  }
  if (status === "EXPIRED") {
    throw new WorkspaceInvitationError(
      "INVITE_EXPIRED",
      "This invitation has expired. Ask for a new one.",
      410,
    );
  }

  const actor = await client.user.findUnique({
    where: { id: input.actorUserId },
    select: { email: true },
  });
  const actorEmail = normalizeInviteEmail(actor?.email ?? "");
  if (!actorEmail || actorEmail !== normalizeInviteEmail(invite.email)) {
    throw new WorkspaceInvitationError(
      "INVITE_EMAIL_MISMATCH",
      "Sign in with the address this invitation was sent to.",
      403,
    );
  }

  // An existing ACTIVE member re-clicking a link is a success, not an error,
  // and it consumes nothing.
  const existingMembership = await client.teamMember.findUnique({
    where: {
      teamId_userId: { teamId: invite.teamId, userId: input.actorUserId },
    },
    select: { status: true },
  });
  if (existingMembership?.status === prismaPkg.TeamMemberStatus.ACTIVE) {
    return {
      workspaceId: invite.teamId,
      role: invite.role,
      alreadyMember: true,
    };
  }

  /**
   * DO NOT HOLD A CONNECTION WHILE WAITING FOR A LOCK.
   *
   * The first version used `pg_advisory_xact_lock`, which is the repository's
   * canonical serialisation primitive and is the right idea: the seat count has
   * to be true across API instances, not merely within one event loop.
   *
   * Measured with twenty simultaneous accepts against live PostgreSQL, it was
   * also a connection-pool trap. A BLOCKING lock inside an interactive
   * transaction holds its pooled connection for the whole wait, so twenty
   * contenders occupy twenty connections to do nothing, the pool empties, and
   * later arrivals cannot even open the transaction that would let them queue.
   * The seat cap held — ten, never eleven — but fourteen callers were refused
   * for exhaustion rather than for capacity, which is a different fact and a
   * worse answer.
   *
   * `pg_try_advisory_xact_lock` inverts it: a contender that cannot take the
   * lock IMMEDIATELY rolls back, returns its connection, and retries after a
   * jittered pause. The critical section is still exactly one holder at a time
   * — the guarantee is unchanged — but waiting now costs nothing that another
   * request needs.
   */
  const run = async (tx: PrismaClient) => {
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${`workspace-seat:${invite.teamId}`})) AS locked
    `;
    if (!locked) return null;

    const seats = await resolveWorkspaceSeatState(invite.teamId, tx as PrismaClient);
    if (!seats.featureIncluded) {
      throw new WorkspaceInvitationError(
        "WORKSPACE_MEMBERS_NOT_INCLUDED",
        "This workspace's plan does not include additional members.",
        402,
        { plan: seats.plan, limit: seats.limit },
      );
    }
    if (seats.used >= seats.limit) {
      throw new WorkspaceInvitationError(
        "WORKSPACE_SEAT_LIMIT_REACHED",
        `This workspace has used all ${seats.limit} of its seats.`,
        409,
        { plan: seats.plan, limit: seats.limit, used: seats.used },
      );
    }

    const claimed = await tx.teamInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date(), acceptedByUserId: input.actorUserId },
    });
    if (claimed.count === 0) {
      throw new WorkspaceInvitationError(
        "INVITE_ALREADY_USED",
        "This invitation has already been used.",
        409,
      );
    }

    await provisionMembership(tx as never, {
      intent: "WORKSPACE_DIRECT_INVITE",
      source: "INVITATION",
      userId: input.actorUserId,
      workspace: { teamId: invite.teamId, role: invite.role as never },
      externalRef: `team-invite:${invite.id}`,
      accessReason: "workspace invitation acceptance",
    });

    return {
      workspaceId: invite.teamId,
      role: invite.role,
      alreadyMember: false,
    };
  };

  // Bounded, jittered retry. The jitter matters: without it a burst of
  // contenders re-collides on the same schedule and simply re-forms the queue.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const outcome = await client.$transaction(
      (tx) => run(tx as unknown as PrismaClient),
      { maxWait: 10_000, timeout: 15_000 },
    );
    if (outcome) return outcome;
    await new Promise((resolve) =>
      setTimeout(resolve, 40 + Math.floor(Math.random() * 120)),
    );
  }

  // Twenty-five failed attempts on one workspace is not a race any more; it is
  // sustained contention, and saying so is more useful than a generic error.
  throw new WorkspaceInvitationError(
    "WORKSPACE_SEAT_CONTENTION",
    "Too many people are joining this workspace at once. Try again in a moment.",
    409,
  );
}
