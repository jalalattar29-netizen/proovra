/**
 * PHASE R8.1.6 / R8.1.7 — Pending MFA recovery digest worker.
 *
 * R8.1.6 sent ONE email per (team, admin) per UTC day — admins of
 * many teams received many emails. R8.1.7 refactors to ONE email
 * per ADMIN per UTC day with all of the admin's teams' pending
 * requests grouped together in a single message.
 *
 * Lifecycle:
 *   1. Find PENDING_ADMIN_REVIEW rows older than 24h.
 *   2. Group by team. Build a per-team `{ teamId, teamName,
 *      pendingCount }` summary.
 *   3. Discover the set of ACTIVE OWNER/ADMIN users across all
 *      flagged teams (the union of admin recipients).
 *   4. For each admin: filter the team summaries to the teams
 *      they're an admin of, look up their digest preferences,
 *      drop teams where `shouldSendDigest` returns false, and
 *      build a consolidated payload.
 *   5. Send ONE email per admin. The per-admin idempotency log
 *      (`MfaRecoveryAdminDigestLog`, UNIQUE on userId+sentDate)
 *      is written ONLY AFTER the transport returns OK — a failed
 *      send does NOT mark the admin as "delivered today".
 *   6. The legacy per-team log (`MfaRecoveryDigestLog`) is still
 *      written per team (after at least one admin received a
 *      consolidated digest that included this team) — preserved
 *      as a per-team operational marker for SecOps dashboards.
 *   7. Emit ONE `mfa_recovery_digest_sent` event per team that
 *      was included in at least one delivered digest; emit
 *      `mfa_recovery_digest_failed` per admin whose email failed.
 *
 * Hard rules:
 *   - The email body carries ONLY counts, team display names, a
 *     deep link to the admin SPA, and the explicit "approval does
 *     NOT grant a session" reminder. No raw tokens / OTPs /
 *     recovery codes / user emails / signed pending tokens.
 *   - The job is idempotent: the per-admin UNIQUE constraint
 *     makes a re-run on the same UTC day a no-op for that admin.
 *   - The job is bounded: at most `MAX_ADMINS_PER_TICK` admins
 *     processed per invocation.
 *   - Suppressed admins (preferences.digestEnabled=false OR
 *     suppressUntil > now) receive NO email and are NOT recorded
 *     in the per-admin log.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";

import * as PrismaPkg from "@prisma/client";

import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { captureException } from "./sentry.js";
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";
import {
  AMBIGUOUS_ERROR_CODE,
  AMBIGUOUS_RETRY_BACKOFF_MS,
  ATTEMPT_LEASE_MS,
  MFA_DIGEST_EVENT_TYPE,
  MFA_DIGEST_TEMPLATE_KEY,
  canonicalEmailFrom,
  deliverEmail,
  DELIVERY_IDEMPOTENCY_OPERATION,
  STORED_IDEMPOTENCY_KEY_FIELD,
  mintEmailIdempotencyKey,
  resolveIntentIdempotencyKey,
  deriveDeliveryPhase,
  outcomeCode,
  type EmailDeliveryOutcome,
} from "@proovra/shared-runtime";

/** Requests in PENDING_ADMIN_REVIEW older than this many seconds
 *  qualify for digest inclusion. 24 hours per the spec. */
/**
 * Is this the database refusing a second holder of a unique slot?
 *
 * Narrow on purpose. `P2002` is the ONLY error that means "someone else has
 * it"; the previous string-matching form (`msg.includes("Unique")`) would
 * also have swallowed an unrelated failure whose message happened to contain
 * the word.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof PrismaPkg.Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

const PENDING_AGE_THRESHOLD_SECONDS = 24 * 60 * 60;

/** Bounded per-tick fan-out — the worker processes at most this
 *  many admins per invocation. Multiple ticks drain a larger
 *  backlog. */
const MAX_ADMINS_PER_TICK = 100;

/** Bounded total team summaries per admin. Defends against a
 *  pathological case where an admin sits on hundreds of teams. */
const MAX_TEAMS_PER_DIGEST = 50;

export interface MfaRecoveryDigestResult {
  /** Teams that had at least one stale pending request. */
  teamsConsidered: number;
  /** Teams that ended up included in at least one delivered
   *  digest (others skipped via the per-team idempotency log or
   *  because all admins were suppressed). */
  teamsDigested: number;
  /** Admins for whom a consolidated digest was attempted. */
  adminsAttempted: number;
  /** Admins whose digest email transport returned OK. */
  adminsSent: number;
  /** Admins whose send failed (retried next tick). */
  adminsFailed: number;
}

export interface RunMfaRecoveryDigestOptions {
  trigger?: string;
}

interface TeamSummary {
  teamId: string;
  teamName: string;
  pendingCount: number;
}

export async function runMfaRecoveryDigest(
  options: RunMfaRecoveryDigestOptions = {},
): Promise<MfaRecoveryDigestResult> {
  const trigger = options.trigger ?? "manual";
  const requestId = randomUUID();
  const now = new Date();
  const cutoff = new Date(now.getTime() - PENDING_AGE_THRESHOLD_SECONDS * 1000);
  const sentDate = now.toISOString().slice(0, 10);

  let teamsConsidered = 0;
  const teamsDigested = new Set<string>();
  let adminsAttempted = 0;
  let adminsSent = 0;
  let adminsFailed = 0;

  try {
    // 1. Stale pending rows grouped by team.
    const staleRows = await prisma.mfaRecoveryRequest.findMany({
      where: {
        status: "PENDING_ADMIN_REVIEW",
        createdAt: { lt: cutoff },
      },
      select: { teamId: true },
    });
    const countsByTeam = new Map<string, number>();
    for (const row of staleRows) {
      countsByTeam.set(
        row.teamId,
        (countsByTeam.get(row.teamId) ?? 0) + 1,
      );
    }
    teamsConsidered = countsByTeam.size;
    if (teamsConsidered === 0) {
      return {
        teamsConsidered: 0,
        teamsDigested: 0,
        adminsAttempted: 0,
        adminsSent: 0,
        adminsFailed: 0,
      };
    }

    // 2. Resolve team display names in one batched query.
    const teamIds = [...countsByTeam.keys()];
    const teams = await prisma.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(teams.map((t) => [t.id, t.name ?? "your workspace"]));

    const teamSummaryById = new Map<string, TeamSummary>();
    for (const teamId of teamIds) {
      teamSummaryById.set(teamId, {
        teamId,
        teamName: nameById.get(teamId) ?? "your workspace",
        pendingCount: countsByTeam.get(teamId) ?? 0,
      });
    }

    // 3. ACTIVE OWNER/ADMIN members across all flagged teams.
    const memberships = await prisma.teamMember.findMany({
      where: {
        teamId: { in: teamIds },
        status: "ACTIVE",
        role: { in: ["OWNER", "ADMIN"] },
      },
      select: {
        teamId: true,
        user: { select: { id: true, email: true } },
      },
    });
    // Build admin → set<teamId> map; skip users without email.
    const teamsByAdmin = new Map<
      string,
      { email: string; teams: Set<string> }
    >();
    for (const m of memberships) {
      const u = m.user;
      if (!u?.email) continue;
      let bucket = teamsByAdmin.get(u.id);
      if (!bucket) {
        bucket = { email: u.email, teams: new Set() };
        teamsByAdmin.set(u.id, bucket);
      }
      bucket.teams.add(m.teamId);
    }

    if (teamsByAdmin.size === 0) {
      return {
        teamsConsidered,
        teamsDigested: 0,
        adminsAttempted: 0,
        adminsSent: 0,
        adminsFailed: 0,
      };
    }

    // 4. Per-admin processing — bounded per tick.
    const adminIds = [...teamsByAdmin.keys()].slice(0, MAX_ADMINS_PER_TICK);

    for (const adminUserId of adminIds) {
      const bucket = teamsByAdmin.get(adminUserId);
      if (!bucket) continue;

      // 4a. Load this admin's preferences.
      const prefs = await prisma.mfaAdminDigestPreference.findMany({
        where: { userId: adminUserId },
        select: { teamId: true, digestEnabled: true, suppressUntil: true },
      });

      // 4b. Build the per-admin team summary list, filtered by
      //     preferences. Drop teams where the admin is suppressed.
      const includedSummaries: TeamSummary[] = [];
      for (const teamId of bucket.teams) {
        if (!isDigestAllowed(prefs, teamId, now)) continue;
        const summary = teamSummaryById.get(teamId);
        if (!summary || summary.pendingCount === 0) continue;
        includedSummaries.push(summary);
        if (includedSummaries.length >= MAX_TEAMS_PER_DIGEST) break;
      }
      if (includedSummaries.length === 0) {
        // Admin is fully suppressed across their flagged teams.
        // We do NOT write a digest log row — the suppression
        // shouldn't count as "delivered today".
        continue;
      }
      const totalPending = includedSummaries.reduce(
        (acc, s) => acc + s.pendingCount,
        0,
      );

      // 4c. THE CLAIM, taken BEFORE the send — and now backed by a durable
      //     DELIVERY-ATTEMPT record rather than by the claim row alone.
      //
      // What was here before took the claim correctly and recorded it
      // dishonestly. `MfaRecoveryAdminDigestLog.sentAtUtc` defaults to
      // `now()`, so the row inserted as a claim was indistinguishable from a
      // row representing a delivered message. A crash between that INSERT and
      // the provider call therefore left a row every later tick read as
      // "today is done": the digest was silently skipped for the rest of the
      // UTC day and nothing recorded that a message had been intended.
      //
      // The claim row still elects the winner — its UNIQUE (userId, sentDate)
      // is a real atomic primitive and there is no reason to replace it. What
      // it no longer does is answer "was it sent?". That question now belongs
      // to a `NotificationDelivery` row created in the SAME transaction, whose
      // lifecycle distinguishes claimed / in-flight / acknowledged / retryable
      // / ambiguous / failed, and whose lease lets another worker recover an
      // attempt whose owner died.
      const claim = await acquireDigestClaim({
        adminUserId,
        adminEmail: bucket.email,
        sentDate,
        teamCount: includedSummaries.length,
        requestCount: totalPending,
      });
      if (claim.kind !== "leased") continue;

      adminsAttempted += 1;

      // 4d. Send, through the canonical transport, carrying the idempotency
      //     key derived from the durable delivery row. The key does not change
      //     between attempts — that is what makes a retry after an ambiguous
      //     outcome safe rather than a second email.
      //
      // PHASE R8.1.9 — the one-click snooze URL. Null when AUTH_JWT_SECRET is
      // absent (test envs); the email then omits the snooze block.
      const snoozeUrl = buildDigestSnoozeUrl(adminUserId);
      const outcome = await sendAdminDigest({
        adminEmail: bucket.email,
        adminSpaUrl: buildAdminSpaUrl(),
        teams: includedSummaries,
        totalPending,
        snoozeUrl,
        idempotencyKey: claim.idempotencyKey,
      });

      // 4e. Project the outcome onto the durable authority. Nothing below
      //     this line decides what happened; it only records it.
      await recordDigestOutcome({
        deliveryId: claim.deliveryId,
        logId: claim.logId,
        outcome,
      });

      if (outcome.kind === "acknowledged" || outcome.kind === "not_configured") {
        if (outcome.kind === "acknowledged") adminsSent += 1;
      } else {
        adminsFailed += 1;
        logger.warn(
          {
            requestId,
            trigger,
            adminUserId,
            outcome: outcome.kind,
            code: outcomeCode(outcome),
          },
          "mfa.recovery_digest.send_not_acknowledged",
        );
        try {
          await prisma.securityEvent.create({
            data: {
              teamId: null,
              userId: adminUserId,
              eventType: "mfa_recovery_digest_failed",
              severity: "WARNING",
              details: {
                trigger,
                teamCount: includedSummaries.length,
                requestCount: totalPending,
                reason: outcome.kind,
                failureCode: outcomeCode(outcome),
              },
            },
          });
        } catch {
          // Best-effort.
        }
        continue;
      }

      // 4f. Mark every team the admin received in their digest as "digested
      //     today". Reached only on an acknowledged send or on a deliberate
      //     no-transport skip — a team is never recorded as digested off the
      //     back of a failure.
      for (const summary of includedSummaries) {
        teamsDigested.add(summary.teamId);
        try {
          await prisma.mfaRecoveryDigestLog.create({
            data: {
              teamId: summary.teamId,
              sentDate,
              pendingCount: summary.pendingCount,
              recipientCount: 1,
            },
          });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // Already recorded for this team today — fine.
        }
        // One bounded security event per team that was included.
        try {
          await prisma.securityEvent.create({
            data: {
              teamId: summary.teamId,
              userId: null,
              eventType: "mfa_recovery_digest_sent",
              severity: "INFO",
              details: {
                trigger,
                pendingCount: summary.pendingCount,
                recipientUserId: adminUserId,
                sentDate,
              },
            },
          });
        } catch {
          // Best-effort.
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, requestId, trigger },
      "mfa.recovery_digest.failed",
    );
    captureException(err, { trigger });
  }

  logger.info(
    {
      requestId,
      trigger,
      teamsConsidered,
      teamsDigested: teamsDigested.size,
      adminsAttempted,
      adminsSent,
      adminsFailed,
    },
    "mfa.recovery_digest.completed",
  );

  return {
    teamsConsidered,
    teamsDigested: teamsDigested.size,
    adminsAttempted,
    adminsSent,
    adminsFailed,
  };
}

// ===========================================================================
// PHASE 12 POINT 5 — the durable delivery-attempt authority
// ===========================================================================

type DigestClaim =
  | {
      kind: "leased";
      logId: string;
      deliveryId: string;
      /** Stable across every attempt on this delivery row. */
      idempotencyKey: string;
    }
  /** Another worker holds a live lease, or the day is already terminal. */
  | { kind: "unavailable" };

/**
 * Acquire — or recover — the exclusive right to send today's digest to one
 * admin.
 *
 * Two durable rows, written in ONE transaction:
 *
 *   `MfaRecoveryAdminDigestLog`  the daily slot. UNIQUE (userId, sentDate)
 *                                elects exactly one winner per UTC day.
 *   `NotificationDelivery`       the attempt record. Created `PENDING` with no
 *                                attempt marker — the `claimed` phase — and
 *                                immediately eligible.
 *
 * Writing them together is what closes the original lost-message window. If
 * the slot were taken without an attempt record, a crash before the record was
 * written would leave a claim nobody could interpret, which is precisely the
 * state the old code left behind.
 *
 * The lease is then taken by a CONDITIONAL update whose affected-row count is
 * the winner election, so the same code path serves a fresh claim and a
 * recovery: a row that is `claimed`, `expired`, `retryable` or `ambiguous` has
 * `nextAttemptAtUtc <= now` and can be leased; a row that is `in_flight` does
 * not and cannot.
 */
async function acquireDigestClaim(input: {
  adminUserId: string;
  adminEmail: string;
  sentDate: string;
  teamCount: number;
  requestCount: number;
}): Promise<DigestClaim> {
  const now = new Date();
  let logId: string;
  let deliveryId: string;
  /**
   * The provider idempotency key for this durable intent.
   *
   * Minted once when the intent is created and PERSISTED on the row; loaded on
   * every subsequent attempt. Never re-derived from the current secret, so a
   * rotation cannot change the key an in-flight message was already sent with.
   */
  let storedKey: string;

  const existingLog = await prisma.mfaRecoveryAdminDigestLog.findUnique({
    where: {
      userId_sentDate: { userId: input.adminUserId, sentDate: input.sentDate },
    },
    select: { id: true },
  });

  if (existingLog) {
    logId = existingLog.id;
    const existingDelivery = await findDigestDelivery(logId);
    if (!existingDelivery) {
      // A slot row with no attempt record predates this state machine. Its
      // meaning is genuinely unknown — the old code wrote such a row both as a
      // claim and as a delivery marker — so it is treated as delivered. That
      // is the conservative reading: it can at worst skip one legacy day, and
      // the alternative could email an admin who already received the digest.
      return { kind: "unavailable" };
    }
    const phase = deriveDeliveryPhase(existingDelivery, now);
    if (phase === "acknowledged" || phase === "delivered" || phase === "skipped") {
      return { kind: "unavailable" };
    }
    if (phase === "failed") {
      // Permanent failure is terminal for the day. Visible, not retried.
      return { kind: "unavailable" };
    }
    deliveryId = existingDelivery.id;
    // The key this intent was ALREADY sent with. Loaded, never re-derived: a
    // key that changes when the signing secret rotates is not a retry key.
    // A row written before this authority existed has none, so one is minted
    // from its immutable id and persisted by the lease update below.
    storedKey = resolveIntentIdempotencyKey({
      metadata: existingDelivery.metadata,
      operation: DELIVERY_IDEMPOTENCY_OPERATION,
      intentId: deliveryId,
    }).key;
  } else {
    logId = randomUUID();
    deliveryId = randomUUID();
    // Minted ONCE, at the moment the durable intent is created, and written in
    // the same transaction as the claim.
    storedKey = mintEmailIdempotencyKey(
      DELIVERY_IDEMPOTENCY_OPERATION,
      deliveryId,
    );
    try {
      await prisma.$transaction([
        prisma.mfaRecoveryAdminDigestLog.create({
          data: {
            id: logId,
            userId: input.adminUserId,
            sentDate: input.sentDate,
            teamCount: input.teamCount,
            requestCount: input.requestCount,
          },
          select: { id: true },
        }),
        prisma.notificationDelivery.create({
          data: {
            id: deliveryId,
            // A digest spans every workspace the admin administers, so it
            // belongs to none of them. `teamId` is left null rather than
            // arbitrarily attributed to one of them.
            teamId: null,
            eventType: MFA_DIGEST_EVENT_TYPE,
            channel: "EMAIL",
            provider: "RESEND",
            recipient: input.adminEmail,
            recipientUserId: input.adminUserId,
            status: "PENDING",
            templateKey: MFA_DIGEST_TEMPLATE_KEY,
            // Eligible immediately: a claim with no attempt is recoverable
            // from the instant it exists.
            nextAttemptAtUtc: now,
            metadata: {
              claimLogId: logId,
              digestSentDate: input.sentDate,
              teamCount: input.teamCount,
              requestCount: input.requestCount,
              [STORED_IDEMPOTENCY_KEY_FIELD]: storedKey,
            },
          },
          select: { id: true },
        }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Another tick won the slot between our read and our insert. Its
        // delivery row exists (same transaction), so the next tick will find
        // it; this one simply steps aside.
        return { kind: "unavailable" };
      }
      throw err;
    }
  }

  // THE LEASE. `updateMany` with the eligibility predicate in the WHERE
  // clause: the database decides, and the affected-row count is the answer.
  const idempotencyKey = storedKey;
  const leased = await prisma.notificationDelivery.updateMany({
    where: {
      id: deliveryId,
      status: { in: ["PENDING", "RETRY_SCHEDULED"] },
      nextAttemptAtUtc: { lte: now },
    },
    data: {
      status: "PENDING",
      errorCode: null,
      errorMessage: null,
      nextAttemptAtUtc: new Date(now.getTime() + ATTEMPT_LEASE_MS),
      retryCount: { increment: 1 },
      metadata: {
        claimLogId: logId,
        digestSentDate: input.sentDate,
        teamCount: input.teamCount,
        requestCount: input.requestCount,
        // Rewritten verbatim on every lease so the stored key survives the
        // metadata replacement — `updateMany` replaces the JSON, it does not
        // merge into it, and losing the key here would silently re-mint it on
        // the next attempt.
        [STORED_IDEMPOTENCY_KEY_FIELD]: idempotencyKey,
        attempt: {
          startedAtUtc: now.toISOString(),
          idempotencyKey,
        },
      },
    },
  });
  if (leased.count !== 1) return { kind: "unavailable" };

  return { kind: "leased", logId, deliveryId, idempotencyKey };
}

/** The attempt record for one claim row, if this state machine wrote one. */
async function findDigestDelivery(claimLogId: string) {
  return prisma.notificationDelivery.findFirst({
    where: {
      eventType: MFA_DIGEST_EVENT_TYPE,
      metadata: { path: ["claimLogId"], equals: claimLogId },
    },
    select: {
      id: true,
      status: true,
      errorCode: true,
      providerMessageId: true,
      sentAtUtc: true,
      deliveredAtUtc: true,
      nextAttemptAtUtc: true,
      metadata: true,
    },
  });
}

/**
 * Write what the provider actually said.
 *
 * Every branch is a state, and none of them is a boolean. In particular
 * `ambiguous` does not collapse into either success or failure: the row stays
 * non-terminal, keeps its idempotency key, and becomes eligible again after a
 * backoff, so the retry is a deduplicated re-send rather than a second email.
 */
async function recordDigestOutcome(input: {
  deliveryId: string;
  logId: string;
  outcome: EmailDeliveryOutcome;
}): Promise<void> {
  const now = new Date();
  const { outcome } = input;

  switch (outcome.kind) {
    case "acknowledged":
      await prisma.notificationDelivery.update({
        where: { id: input.deliveryId },
        data: {
          status: "SENT",
          providerMessageId: outcome.providerMessageId,
          sentAtUtc: now,
          nextAttemptAtUtc: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      // Only now does the daily slot mean "delivered".
      await prisma.mfaRecoveryAdminDigestLog.update({
        where: { id: input.logId },
        data: { sentAtUtc: now },
      });
      return;

    case "not_configured":
      // No transport is configured. This is not a failure to retry: it is a
      // deliberate no-op, recorded as SKIPPED so an operator can see that the
      // day produced no message and why.
      await prisma.notificationDelivery.update({
        where: { id: input.deliveryId },
        data: {
          status: "SKIPPED",
          errorCode: "not_configured",
          nextAttemptAtUtc: null,
        },
      });
      await prisma.mfaRecoveryAdminDigestLog.update({
        where: { id: input.logId },
        data: { sentAtUtc: now },
      });
      return;

    case "permanent":
      await prisma.notificationDelivery.update({
        where: { id: input.deliveryId },
        data: {
          status: "FAILED",
          errorCode: outcome.errorCode,
          failedAtUtc: now,
          nextAttemptAtUtc: null,
        },
      });
      return;

    case "retryable":
      await prisma.notificationDelivery.update({
        where: { id: input.deliveryId },
        data: {
          status: "RETRY_SCHEDULED",
          errorCode: outcome.errorCode,
          // Eligible on the next tick: the provider answered "not now", not
          // "maybe". Releasing the lease is the whole retry mechanism.
          nextAttemptAtUtc: now,
        },
      });
      return;

    case "ambiguous":
      await prisma.notificationDelivery.update({
        where: { id: input.deliveryId },
        data: {
          status: "RETRY_SCHEDULED",
          errorCode: AMBIGUOUS_ERROR_CODE,
          errorMessage: outcome.errorCode,
          nextAttemptAtUtc: new Date(now.getTime() + AMBIGUOUS_RETRY_BACKOFF_MS),
        },
      });
      return;
  }
}

/**
 * Pure helper — duplicates the API-side `shouldSendDigest` so the
 * worker doesn't have to import across service boundaries. Same
 * resolution rules: team-specific wins, then global, then default
 * enabled. `suppressUntil > now` overrides `digestEnabled`.
 */
function isDigestAllowed(
  prefs: ReadonlyArray<{
    teamId: string | null;
    digestEnabled: boolean;
    suppressUntil: Date | null;
  }>,
  teamId: string,
  now: Date,
): boolean {
  const teamPref = prefs.find((p) => p.teamId === teamId);
  const globalPref = prefs.find((p) => p.teamId === null);
  const effective = teamPref ?? globalPref;
  if (!effective) return true;
  if (
    effective.suppressUntil &&
    effective.suppressUntil.getTime() > now.getTime()
  ) {
    return false;
  }
  return effective.digestEnabled;
}

// PHASE 11 — nav-only path (not a resource-id route): the admin's own
// console section, not scoped to any team/workspace the job payload
// might reference.
function buildAdminSpaUrl(): string {
  const base = process.env["WEB_BASE_URL"] || "https://www.proovra.com";
  return absoluteInternalUrl(
    base,
    internalNavPath("security-center/mfa-recovery")
  );
}

/**
 * PHASE R8.1.9 — Build a signed one-click snooze URL for the
 * admin's GLOBAL digest preference (teamId = null). Embedded in
 * the digest email body. When `AUTH_JWT_SECRET` is absent (test
 * environments without secrets), returns null so the caller omits
 * the snooze block rather than generating an unsigned URL.
 *
 * The signing implementation is a self-contained HS256 JWT builder
 * (same algorithm as `mfa-digest-snooze-token.ts` in the API
 * service) — kept inline here so the worker has no cross-service
 * import dependency. Any change to the token shape must be applied
 * to BOTH implementations.
 *
 * Hard rules:
 *   - Token purpose is ALWAYS `"mfa_recovery_digest_snooze"` —
 *     the verify endpoint refuses any other purpose value.
 *   - The token is UX-ONLY: it can apply a snooze, NOT authenticate.
 *   - TTL matches the snooze duration (15 days) so the token cannot
 *     outlive the action it describes.
 */
const MFA_DIGEST_SNOOZE_PURPOSE = "mfa_recovery_digest_snooze" as const;
const MFA_DIGEST_SNOOZE_TTL_SECONDS = 15 * 24 * 60 * 60;
const API_BASE_URL = process.env["API_BASE_URL"] || "https://api.proovra.com";

function buildDigestSnoozeUrl(
  adminUserId: string,
): string | null {
  const secret = process.env["AUTH_JWT_SECRET"];
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    purpose: MFA_DIGEST_SNOOZE_PURPOSE,
    sub: adminUserId,
    teamId: null,
    snoozeSeconds: MFA_DIGEST_SNOOZE_TTL_SECONDS,
    jti: randomBytes(16).toString("hex"),
    iat: now,
    exp: now + MFA_DIGEST_SNOOZE_TTL_SECONDS,
  };
  // base64url-encode a UTF-8 string (for header / payload).
  const b64uStr = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  // base64url-encode a raw Buffer (for signature bytes).
  const b64uBuf = (b: Buffer) =>
    b
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const header = b64uStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64uStr(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = b64uBuf(
    createHmac("sha256", secret).update(signingInput).digest(),
  );
  const token = `${signingInput}.${sig}`;
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/v1/identity/mfa-admin/digest-preferences/snooze-link?token=${encodeURIComponent(token)}`;
}

interface SendAdminDigestInput {
  adminEmail: string;
  adminSpaUrl: string;
  teams: ReadonlyArray<TeamSummary>;
  totalPending: number;
  /** PHASE R8.1.9 — signed one-click snooze URL. Null when the JWT
   *  secret is absent (test/dev without secrets); in that case the
   *  email body omits the snooze block. The URL targets the global
   *  digest preference (teamId = null). */
  snoozeUrl: string | null;
  /** Derived from the durable delivery row; identical on every retry. */
  idempotencyKey: string;
}

/**
 * Render the digest and hand it to the CANONICAL transport.
 *
 * PHASE 12 POINT 5 — this function used to BE a transport: a raw `fetch` at
 * the provider's send endpoint, with its own key handling, no timeout, no
 * idempotency key, and a `throw` on any non-2xx that the caller could only
 * read as "failed". That made it the third independent email transport policy
 * engine in the repository, and the only one whose retries could deliver
 * twice. It now renders, and `deliverEmail` transports — which is also why the
 * provider's hostname no longer appears anywhere in this file.
 *
 * PHASE R8.1.8 — sends BOTH a plain-text and an HTML body. The
 * HTML body uses a minimal inline template (the API's
 * `emailShell` helper is not importable from the worker) with the
 * same content contract as the text body: counts + team names +
 * admin SPA URL + the "approval does NOT grant a session"
 * reminder + the preference-management link. No tokens, no OTPs,
 * no recovery codes, no user emails enumerated.
 */
async function sendAdminDigest(
  input: SendAdminDigestInput,
): Promise<EmailDeliveryOutcome> {
  const totalPending = input.totalPending;
  const teamCount = input.teams.length;
  const subject = `${totalPending} pending MFA recovery request${
    totalPending === 1 ? "" : "s"
  } across ${teamCount} team${teamCount === 1 ? "" : "s"}`;
  // Plain text body — bounded fields only. Preserved as the
  // fallback for clients that don't render HTML.
  const lines: string[] = [
    `Pending MFA recovery requests on PROOVRA`,
    ``,
    `You have ${totalPending} request${
      totalPending === 1 ? "" : "s"
    } awaiting your review across ${teamCount} team${
      teamCount === 1 ? "" : "s"
    }:`,
    ``,
  ];
  for (const t of input.teams) {
    lines.push(
      `  • ${t.teamName}: ${t.pendingCount} request${
        t.pendingCount === 1 ? "" : "s"
      }`,
    );
  }
  lines.push(``);
  lines.push(`Open the admin console: ${input.adminSpaUrl}`);
  lines.push(``);
  lines.push(
    `Approving a request does NOT grant a session — the user must still re-enroll their MFA.`,
  );
  if (input.snoozeUrl) {
    lines.push(
      `To snooze these digest emails for 15 days: ${input.snoozeUrl}`,
    );
  }
  lines.push(
    `To change which workspaces send you these digests, update your notification preferences in the admin console.`,
  );
  const text = lines.join("\n");

  // HTML body — minimal inline template. The worker cannot import
  // the API's `emailShell` helper across service boundaries, so we
  // assemble the markup directly. Style is intentionally simple
  // and email-client-friendly (no external CSS, no JS, no
  // remote images).
  const teamRows = input.teams
    .map(
      (t) =>
        `<li style="margin:4px 0;"><strong>${escapeHtml(
          t.teamName,
        )}</strong>: ${t.pendingCount} request${
          t.pendingCount === 1 ? "" : "s"
        }</li>`,
    )
    .join("");
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
    <h1 style="font-size:18px;margin:0 0 8px 0;">Pending MFA recovery requests</h1>
    <p style="margin:0 0 12px 0;color:#475569;">
      You have <strong>${totalPending}</strong> request${totalPending === 1 ? "" : "s"} awaiting your review across <strong>${teamCount}</strong> team${teamCount === 1 ? "" : "s"}:
    </p>
    <ul style="margin:0 0 16px 0;padding-left:20px;color:#0f172a;">
      ${teamRows}
    </ul>
    <p style="margin:16px 0;">
      <a href="${escapeHtml(input.adminSpaUrl)}"
         style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
        Open admin console
      </a>
    </p>
    <p style="margin:16px 0 0 0;padding:12px 14px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:8px;font-size:13px;">
      <strong>Approving a request does NOT grant a session.</strong> The user must still re-enroll their MFA after approval.
    </p>
    <p style="margin:16px 0 0 0;font-size:13px;color:#475569;">
      To change which workspaces send you these digests, update your
      notification preferences in the admin console.
    </p>
    ${input.snoozeUrl ? `
    <p style="margin:12px 0 0 0;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#475569;">
      Not ready to review now?
      <a href="${escapeHtml(input.snoozeUrl)}"
         style="color:#2563eb;text-decoration:none;font-weight:600;">
        Snooze these digest emails for 15 days
      </a>
      &mdash; security events and audit logs are unaffected.
    </p>` : ""}
  </div>
</body></html>`;

  return deliverEmail({
    from: canonicalEmailFrom(),
    to: input.adminEmail,
    subject,
    text,
    html,
    idempotencyKey: input.idempotencyKey,
  });
}

/** Bounded HTML escape — defends against a team name containing
 *  angle brackets bleeding into the markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
