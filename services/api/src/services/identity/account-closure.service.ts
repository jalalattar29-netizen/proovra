/**
 * Lifecycle Phase 5 (2026-07-17) — personal account closure execution.
 *
 * ONE canonical processor for the AccountClosureRequest state machine.
 * Routes only create/cancel request rows; execution runs on the existing
 * digest cron via `processAccountClosures` (the same piggyback pattern as
 * data-export generation — no parallel job infrastructure).
 *
 * Execution model (ANONYMIZE + ARCHIVE, never destroy evidence):
 *   1. Re-run the canonical preflight. Any blocker acquired during the
 *      cooling-off window moves the request to BLOCKED — a request that
 *      passed preflight a week ago is NOT trusted at execution time.
 *   2. Atomically claim the row (guarded updateMany → PROCESSING) so two
 *      cron ticks can never double-execute.
 *   3. Revoke every session (RevokedSession ALL_FOR_USER — the JWT
 *      validation source of truth — plus the AuthenticatedSession
 *      inventory mirror).
 *   4. Revoke every login method: identity links → REVOKED, password
 *      hash nulled, provider subject scrambled to `closed:<userId>` so
 *      the OAuth pair can never resolve to this account again.
 *   5. Anonymize PII on the user row (email/name/avatar/bio/country).
 *   6. Cancel outstanding data-export requests and null their payloads.
 *   7. Archive solo implicit personal organizations (status ARCHIVED),
 *      then remove the user's org memberships and set their workspace
 *      memberships to REVOKED.
 *
 * Evidence is NEVER hard-deleted here — retention/legal governance owns
 * evidence destruction, not account lifecycle. Workspace rows, evidence
 * rows, and audit history remain intact under the archived organization.
 *
 * MEMBERS AUDIT LIFE-09 / LIFE-10 / LIFE-13 (2026-10-25) — ORDER AND
 * DURABILITY. The workspaces the user owned used to outlive the account: their
 * API keys, webhooks, pending invitations and suspended members stayed live
 * under an anonymised owner. Execution is now two transactions in a fixed
 * order:
 *
 *   A. DURABLE CLOSURE. Every workspace the user owns is closed through the
 *      ONE closure leg set (`closeWorkspacesTx`): memberships (ACTIVE and
 *      SUSPENDED) revoked with their reach ended, invitations revoked,
 *      credentials revoked, webhooks disabled, external grants revoked,
 *      `closedAtUtc` stamped. The user's own memberships elsewhere end the
 *      same way, invitations addressed to them are revoked, and credentials
 *      they minted in other workspaces are revoked.
 *   B. ANONYMISATION — only after A has committed. With a closure request,
 *      the request's COMPLETED state and its audit row commit in this same
 *      transaction (members audit AUD-01).
 *
 * The person is told (ACCOUNT_CLOSED, members audit AUD-04): the notice is
 * enqueued in A, while the address still exists, and dispatched once A has
 * committed.
 *
 * MEMBERS RE-AUDIT, THIRD ROUND (N4) — ONCE A COMMITS, THE CLOSURE IS
 * IRREVOCABLY IN PROGRESS.
 *   - A also ends the account's ACCESS: every session (RevokedSession
 *     ALL_FOR_USER and the AuthenticatedSession mirror) and every login method
 *     (identity links, password hash, provider subject → `closed:<userId>`)
 *     ends in the same transaction that closes the workspaces. There is no
 *     point at which the workspaces are closed and the person can still sign
 *     in. The scrambled provider subject is the durable "A committed" marker.
 *   - Blockers are judged only BEFORE A commits. A resumed run whose A has
 *     already committed is never re-judged into BLOCKED — that would strand a
 *     closed account half-done and cancellable.
 *   - A legal hold is never weakened: B anonymises only while no ACTIVE hold
 *     sits on a workspace the person owns, judged under the same workspace
 *     lock A takes. A hold that appears after A defers B — the request stays
 *     PROCESSING with access ended, the reaper resumes it, and anonymisation
 *     completes once the hold is released ("The hold must be released before
 *     closure", the preflight's own rule).
 *
 * Every leg selects only what is still live, so the whole execution is
 * idempotent: a reaper that finds a request stuck in PROCESSING simply runs it
 * again (`processAccountClosures`), and nothing already settled changes.
 */

import { prisma } from "../../db.js";
import { revokeAllSessionsForUser } from "../identity-security/session-revocation.service.js";
import { emitPlatformAudit } from "../audit/tenant-audit.service.js";
import { evaluateAccountClosurePreflight } from "./account-lifecycle-preflight.service.js";
// PROGRAM CONVERGENCE (2026-07-22) — the ONE Organization→ARCHIVED transition.
import { archiveOrganizationStatusTx } from "../organization/org-closure.service.js";
import { closeWorkspacesTx } from "../workspace/workspace-closure.service.js";
import { dispatchEnqueuedEmailNotifications } from "../notifications/index.js";
import { enqueueMembershipLifecycleNoticeTx } from "../notifications/membership-lifecycle-notice.js";
// PHASE 3 (2026-07-22) — canonical membership orchestrator.
import {
  massRevokeWorkspaceMemberships,
  removeAllOrganizationMembershipsForUser,
} from "./membership-provisioning.service.js";

export const COOLING_OFF_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PROCESS_BATCH = 5;
/** A PROCESSING request untouched this long was interrupted; the reaper resumes it. */
export const ACCOUNT_CLOSURE_STALE_MS = 30 * 60 * 1000;

/** Statuses that count as "an open closure request exists". */
export const ACTIVE_CLOSURE_STATUSES = [
  "REQUESTED",
  "COOLING_OFF",
  "SCHEDULED",
  "PROCESSING",
] as const;

/** Statuses the user may still cancel from. */
export const CANCELLABLE_CLOSURE_STATUSES = [
  "REQUESTED",
  "BLOCKED",
  "COOLING_OFF",
  "SCHEDULED",
] as const;

/**
 * MEMBERS RE-AUDIT (second round, defect 7) — a blocker found at EXECUTION
 * time, inside the closure transaction. Nothing was closed: the transaction
 * rolled back. The request records BLOCKED with these blockers.
 */
export class AccountClosureBlockedError extends Error {
  constructor(readonly blockers: Array<{ code: string }>) {
    super("account_closure_blocked_at_execution");
    this.name = "AccountClosureBlockedError";
  }
}

/**
 * MEMBERS RE-AUDIT, THIRD ROUND (N4) — phase A has committed (access ended,
 * workspaces closed) but an ACTIVE legal hold now sits on a workspace the
 * person owns, so anonymisation waits. The request stays PROCESSING; the
 * reaper resumes it, and it completes once the hold is released.
 */
export class AccountClosureDeferredError extends Error {
  constructor(readonly blockers: Array<{ code: string }>) {
    super("account_closure_anonymisation_deferred_by_hold");
    this.name = "AccountClosureDeferredError";
  }
}

/**
 * Lock every workspace this closure can close (FOR UPDATE). A membership or
 * legal-hold insert takes a KEY SHARE lock on its workspace row (foreign key),
 * so any such write either committed before this lock — and a check made
 * after it sees the write — or waits until the locking transaction ends.
 */
async function lockClosableWorkspacesTx(
  tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  userId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT t."id" FROM "teams" t
     WHERE t."owner_user_id" = ${userId}::uuid
        OR t."organization_id" IN (
             SELECT m."organization_id" FROM "organization_memberships" m
              WHERE m."user_id" = ${userId}::uuid AND m."role" = 'ORG_OWNER')
     ORDER BY t."id"
       FOR UPDATE OF t`;
}

export async function executeAccountClosure(
  userId: string,
  opts: { closureRequestId?: string } = {},
): Promise<void> {
  const now = new Date();

  // A. DURABLE CLOSURE — access ends and the workspaces close in one
  // transaction, committed before a single field is anonymised.
  const noticeIds = await prisma.$transaction(async (tx) => {
    // EXECUTION-TIME PREFLIGHT, INSIDE THIS TRANSACTION (members re-audit,
    // second round, defect 7). The cron's check before the claim — and the
    // reaper, which ran no check at all — left a window in which a member
    // joining, or a legal hold placed on, a workspace this user owns was not
    // seen before that workspace closed. The workspaces this execution can
    // close are locked FOR UPDATE first: a membership or hold insert takes a
    // KEY SHARE lock on its workspace row (foreign key), so any such write
    // either committed before this lock — and the preflight below sees it —
    // or waits until this transaction has finished. A blocker found here
    // rolls the transaction back: nothing closes, and the request records
    // BLOCKED. A direct call with no request (an operator tool) is not
    // re-judged here; it carries its own decision.
    //
    // Third round (N4): only BEFORE A has ever committed. Once it has (the
    // provider subject is scrambled), the closure is irrevocably in progress:
    // a resumed run settles A's legs again (idempotent) and goes on to B,
    // where a legal hold still governs anonymisation.
    if (opts.closureRequestId) await lockClosableWorkspacesTx(tx as never, userId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true, providerUserId: true },
    });
    const accessAlreadyEnded = user?.providerUserId === `closed:${userId}`;
    if (opts.closureRequestId && !accessAlreadyEnded) {
      const { blockers } = await evaluateAccountClosurePreflight(userId);
      if (blockers.length > 0) throw new AccountClosureBlockedError(blockers);
    }

    // Solo implicit organizations go first, so their workspaces close with
    // the user's own (the multi-member case is a preflight blocker).
    const ownerMemberships = await tx.organizationMembership.findMany({
      where: { userId, role: "ORG_OWNER" },
      select: { organizationId: true },
    });
    const soloOrgIds: string[] = [];
    for (const m of ownerMemberships) {
      const others = await tx.organizationMembership.count({
        where: { organizationId: m.organizationId, userId: { not: userId } },
      });
      if (others === 0) {
        // PROGRAM CONVERGENCE (2026-07-22) — the ONE Organization→ARCHIVED
        // transition (org-closure engine), never a second inline status write.
        await archiveOrganizationStatusTx(tx, { organizationId: m.organizationId });
        soloOrgIds.push(m.organizationId);
      }
    }

    // Every workspace the user owns, plus every workspace of an organization
    // that just archived with them. Already-closed ones are settled again
    // harmlessly (every leg selects only what is still live).
    const owned = await tx.team.findMany({
      where: {
        OR: [
          { ownerUserId: userId },
          ...(soloOrgIds.length ? [{ organizationId: { in: soloOrgIds } }] : []),
        ],
      },
      select: { id: true },
    });
    const closed = await closeWorkspacesTx(tx, {
      teamIds: owned.map((t) => t.id),
      actorUserId: userId,
      reason: "account closure",
    });

    // The user's memberships ELSEWHERE end, with their reach (canonical
    // orchestrator: governance memberships removed with provenance closed;
    // workspace memberships revoked, never erased).
    await removeAllOrganizationMembershipsForUser(tx, { userId });
    await massRevokeWorkspaceMemberships(tx, {
      where: { userId },
      reason: "account closure",
    });

    // Invitations addressed to this person can no longer be accepted by
    // anyone, and machine credentials they minted elsewhere stop working.
    if (user?.email) {
      await tx.teamInvite.updateMany({
        where: { email: { equals: user.email, mode: "insensitive" }, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    await tx.apiCredential.updateMany({
      where: { createdByUserId: userId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAtUtc: now, revokedReason: "account_closed" },
    });
    // ACCESS ENDS IN THIS TRANSACTION (third round, N4) — sessions and login
    // methods with the workspaces, never after them. A closure refused above
    // rolls all of this back with everything else: the person stays signed
    // in. Settled once; a resumed run finds them already ended.
    if (accessAlreadyEnded) return closed.noticeIds;
    // RevokedSession is the JWT-validation source of truth.
    await revokeAllSessionsForUser({ userId, reason: "ACCOUNT_CLOSED" }, tx as never);
    await tx.authenticatedSession.updateMany({
      where: { userId, revokedAtUtc: null },
      data: {
        revokedAtUtc: now,
        revokedByUserId: userId,
        revokedReason: "ACCOUNT_CLOSED",
      },
    });
    // Login methods. The scrambled provider subject keeps the
    // (provider, providerUserId) unique pair satisfied while making it
    // impossible for any future OAuth login to resolve to this row — and it
    // is the durable marker that A has committed.
    await tx.userIdentityLink.updateMany({
      where: { userId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAtUtc: now },
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: null,
        providerUserId: `closed:${userId}`,
        currentWorkspaceId: null,
      },
    });

    const confirmation = await enqueueMembershipLifecycleNoticeTx(tx as never, {
      eventType: "ACCOUNT_CLOSED",
      teamId: null,
      recipientUserId: userId,
      actorUserId: userId,
    });
    return [...closed.noticeIds, confirmation];
  });
  // Members of the closed workspaces lost access in A: they are told now,
  // whether or not anonymisation has to wait for a hold.
  await dispatchEnqueuedEmailNotifications(noticeIds);

  // B. ANONYMISATION — PII and privacy artifacts.
  await prisma.$transaction(async (tx) => {
    // A LEGAL HOLD GOVERNS ANONYMISATION (third round, N4). Judged under the
    // same workspace lock as A, so a hold placed concurrently either is seen
    // here or waits for this transaction. A held account stays closed with
    // its access ended; anonymisation completes once the hold is released.
    if (opts.closureRequestId) {
      await lockClosableWorkspacesTx(tx as never, userId);
      const { blockers } = await evaluateAccountClosurePreflight(userId);
      const holds = blockers.filter((b) => b.code === "LEGAL_HOLD_ACTIVE");
      if (holds.length > 0) throw new AccountClosureDeferredError(holds);
    }

    await tx.accountDataExportRequest.updateMany({
      where: { userId, status: { in: ["REQUESTED", "PROCESSING", "READY"] } },
      data: { status: "CANCELLED", packageJson: null, packageSha256: null },
    });

    // Anonymize the account (its login methods already ended in A).
    await tx.user.update({
      where: { id: userId },
      data: {
        email: null,
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: null,
        bio: null,
        country: null,
      },
    });
    if (opts.closureRequestId) {
      await tx.accountClosureRequest.update({
        where: { id: opts.closureRequestId },
        data: { status: "COMPLETED", completedAtUtc: new Date() },
      });
      await emitPlatformAudit(
        {
          action: "identity.account_closure_completed",
          outcome: "success",
          sourceApp: "API",
          actorUserId: userId,
          serviceActor: "account_closure_worker",
          resourceType: "account_closure_request",
          resourceId: opts.closureRequestId,
          causationId: opts.closureRequestId,
          previousState: "PROCESSING",
          resultingState: "COMPLETED",
          metadata: {},
        },
        tx as never,
      );
    }
  });
}

/** A closure request's terminal refusal or failure, and its audit, in one transaction. */
async function recordAccountClosureOutcome(input: {
  requestId: string;
  userId: string;
  fromStatus: string;
  outcome: "BLOCKED" | "FAILED";
  blockers?: Array<{ code: string }>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const moved = await tx.accountClosureRequest.updateMany({
      where: { id: input.requestId, status: input.fromStatus },
      data:
        input.outcome === "BLOCKED"
          ? { status: "BLOCKED", blockersJson: JSON.stringify(input.blockers ?? []) }
          : { status: "FAILED", failureCode: "closure_failed" },
    });
    if (moved.count === 0) return;
    await emitPlatformAudit(
      {
        action:
          input.outcome === "BLOCKED"
            ? "identity.account_closure_blocked"
            : "identity.account_closure_failed",
        outcome: input.outcome === "BLOCKED" ? "denied" : "error",
        ...(input.outcome === "BLOCKED" ? { denialReason: "closure_blocked" } : {}),
        sourceApp: "API",
        actorUserId: input.userId,
        serviceActor: "account_closure_worker",
        resourceType: "account_closure_request",
        resourceId: input.requestId,
        causationId: input.requestId,
        previousState: input.fromStatus,
        resultingState: input.outcome,
        metadata:
          input.outcome === "BLOCKED"
            ? { blockers: (input.blockers ?? []).map((b) => b.code) }
            : { failureCode: "closure_failed" },
      },
      tx as never,
    );
  });
}

/**
 * Cron entrypoint — executes due closure requests. Called from the digest
 * scheduler tick; every failure is isolated to the single request row.
 */
export async function processAccountClosures(now: Date): Promise<void> {
  const due = await prisma.accountClosureRequest.findMany({
    where: {
      status: { in: ["COOLING_OFF", "SCHEDULED"] },
      coolingOffEndsAtUtc: { lte: now },
    },
    orderBy: { coolingOffEndsAtUtc: "asc" },
    take: PROCESS_BATCH,
    select: { id: true, userId: true, status: true },
  });

  // THE REAPER (members audit LIFE-11). A request left in PROCESSING by an
  // interrupted run is resumed: execution is idempotent, so running it again
  // finishes what the first run started and changes nothing it settled.
  const stale = await prisma.accountClosureRequest.findMany({
    where: {
      status: "PROCESSING",
      startedAtUtc: { lte: new Date(now.getTime() - ACCOUNT_CLOSURE_STALE_MS) },
    },
    orderBy: { startedAtUtc: "asc" },
    take: PROCESS_BATCH,
    select: { id: true, userId: true },
  });
  for (const req of stale) {
    const reclaimed = await prisma.accountClosureRequest.updateMany({
      where: { id: req.id, status: "PROCESSING" },
      data: { startedAtUtc: now },
    });
    if (reclaimed.count === 0) continue;
    await runClaimedClosure(req);
  }

  for (const req of due) {
    // Execution-time preflight — a blocker acquired during cooling-off
    // stops execution cold.
    const { blockers } = await evaluateAccountClosurePreflight(req.userId);
    if (blockers.length > 0) {
      await recordAccountClosureOutcome({
        requestId: req.id,
        userId: req.userId,
        fromStatus: req.status,
        outcome: "BLOCKED",
        blockers,
      });
      continue;
    }

    const claimed = await prisma.accountClosureRequest.updateMany({
      where: { id: req.id, status: req.status },
      data: { status: "PROCESSING", startedAtUtc: now },
    });
    if (claimed.count === 0) continue;
    await runClaimedClosure(req);
  }
}

/** Execute one claimed request and record its outcome. */
async function runClaimedClosure(req: { id: string; userId: string }): Promise<void> {
  try {
    await executeAccountClosure(req.userId, { closureRequestId: req.id });
  } catch (err) {
    // A blocker found inside the closure transaction: nothing closed, and
    // the request is BLOCKED (with its audit), exactly as a blocker found
    // before the claim — on the reaper path too.
    if (err instanceof AccountClosureBlockedError) {
      await recordAccountClosureOutcome({
        requestId: req.id,
        userId: req.userId,
        fromStatus: "PROCESSING",
        outcome: "BLOCKED",
        blockers: err.blockers,
      }).catch(() => null);
      return;
    }
    // Third round (N4): A committed — access ended, workspaces closed — and a
    // legal hold now governs anonymisation. The closure is irrevocably in
    // progress, so it is neither BLOCKED (cancellable) nor FAILED: it stays
    // PROCESSING and the reaper resumes it until the hold is released.
    if (err instanceof AccountClosureDeferredError) return;
    // A committed, B rolled back (or A rolled back): either way the request
    // records FAILED with its audit, and A's legs are idempotent on re-run.
    await recordAccountClosureOutcome({
      requestId: req.id,
      userId: req.userId,
      fromStatus: "PROCESSING",
      outcome: "FAILED",
    }).catch(() => null);
  }
}
