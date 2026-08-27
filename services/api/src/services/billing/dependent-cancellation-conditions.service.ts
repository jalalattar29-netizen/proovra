/**
 * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — the Operations
 * condition for an add-on that is still billing.
 *
 * WHAT IT SAYS
 * ---------------------------------------------------------------------------
 * "This recurring Storage add-on's plan was cancelled and the add-on is still
 * live at the payment provider." That is money leaving a customer's account
 * every month for something they cancelled, so it is not a warning — it is a
 * condition with an owner, a lifecycle and an auto-resolution that only
 * provider truth can trigger.
 *
 * WHY IT IS WRITTEN HERE AND NOT IN THE CANCELLATION PATH
 * ---------------------------------------------------------------------------
 * The obligation is the durable fact; the condition is its projection into
 * Operations. Keeping them separate means a condition can never exist without
 * an obligation behind it, and an obligation that is recorded while Operations
 * is unavailable still gets its condition on the next sweep.
 *
 * SAFETY OF THE PAYLOAD
 * ---------------------------------------------------------------------------
 * The fingerprint and metadata carry the INTERNAL add-on id, the safe storage
 * size, the attempt count, the safe reason code and timestamps. They never
 * carry a Stripe or PayPal subscription id, a payment id, a raw provider
 * error, a customer email or anything from a provider payload — an operator
 * needs to know that an add-on is still charging and how hard the platform has
 * tried, not the customer's provider identifiers.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { recordIncident } from "../observability/incident.service.js";
import { UNRESOLVED_STATES } from "./dependent-cancellation.service.js";

const S = prismaPkg.DependentCancellationState;

/** The registered source that owns this condition. */
export const DEPENDENT_CANCELLATION_SOURCE_ID =
  "billing.dependent_cancellation_failed" as const;

/** `billing_dependent_cancellation:<addonId>` — one condition per add-on. */
export function dependentCancellationFingerprint(addonId: string): string {
  return `billing_dependent_cancellation:${addonId}`;
}

function humanBytes(bytes: bigint): string {
  const gb = Number(bytes / (BigInt(1024) ** BigInt(2))) / 1024;
  return gb >= 1 ? `${Math.round(gb)} GB` : `${Number(bytes / BigInt(1024))} KB`;
}

/**
 * Open or refresh the condition for every unresolved obligation.
 *
 * Idempotent by construction: `recordIncident` upserts on
 * `(teamId, fingerprint)`, so a repeated sweep bumps the occurrence count and
 * reopens a prematurely-resolved row rather than creating a second condition.
 *
 * Resolution is NOT written here. The registered lifecycle is
 * `SOURCE_TRUTH` + `PROBE_AUTO_RESOLVE`, so the probe reads
 * `dependentCancellationState` and closes the condition when — and only when —
 * it reaches CONFIRMED. Nothing in this file may close it, because closing it
 * would not stop the charge.
 */
export async function syncDependentCancellationConditions(input?: {
  /**
   * Bound the sweep to ONE workspace.
   *
   * The Operations discovery sweep runs per workspace and its readiness is a
   * statement about that workspace, so a source that quietly scanned every
   * tenant would be reporting one workspace's success using another's data.
   * Omitted only by the billing retry sweep, which is global by design.
   */
  teamId?: string | null;
  /** Bound one sweep. Never a full-table scan. */
  limit?: number;
}): Promise<{ opened: number; skippedUnscoped: number }> {
  // A workspace-scoped sweep must see the add-ons that belong to it in BOTH
  // shapes: a shared workspace's carry its team id, and a personal one's carry
  // `teamId: null` with the owner's personal team resolved below. The personal
  // arm is matched by resolving the workspace's owner rather than by a bare
  // null, which would read every other account's rows.
  const personalOwner = input?.teamId
    ? await prisma.team.findFirst({
        where: { id: input.teamId, isPersonal: true },
        select: { ownerUserId: true },
      })
    : null;

  const rows = await prisma.workspaceStorageAddon.findMany({
    where: {
      dependentCancellationState: { in: [...UNRESOLVED_STATES] },
      ...(input?.teamId
        ? {
            OR: [
              { teamId: input.teamId },
              ...(personalOwner
                ? [{ ownerUserId: personalOwner.ownerUserId, teamId: null }]
                : []),
            ],
          }
        : {}),
    },
    orderBy: { dependentCancellationRequestedAtUtc: "asc" },
    take: input?.limit ?? 100,
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      addonKey: true,
      extraStorageBytes: true,
      paymentProvider: true,
      dependentCancellationState: true,
      dependentCancellationAttemptCount: true,
      dependentCancellationReasonCode: true,
      dependentCancellationRequestedAtUtc: true,
      dependentCancellationFailedAtUtc: true,
      dependentCancellationNextRetryAtUtc: true,
    },
  });

  let opened = 0;
  let skippedUnscoped = 0;

  for (const addon of rows) {
    // TENANT ISOLATION, and the PERSONAL case is not an afterthought.
    //
    // A shared workspace's add-on carries that workspace's team id. A PERSONAL
    // add-on carries `teamId: null` — that is what makes it personal — so the
    // condition is attributed to the owner's own Personal Space team, which is
    // the canonical workspace identity for personal-scope Operations
    // conditions. Skipping null rows instead, as a first pass did, would have
    // meant personal customers never saw this condition at all, which is the
    // majority of the accounts that can hit it.
    //
    // An owner with no personal team is a malformed row: it is counted and
    // skipped rather than attributed to a guessed workspace, because putting
    // one customer's billing condition in another's Operations page is worse
    // than not raising it.
    const scopeTeamId =
      addon.teamId ??
      (
        await prisma.team.findFirst({
          where: { ownerUserId: addon.ownerUserId, isPersonal: true },
          select: { id: true },
        })
      )?.id ??
      null;

    if (!scopeTeamId) {
      skippedUnscoped += 1;
      continue;
    }

    const manual =
      addon.dependentCancellationState === S.MANUAL_INTERVENTION;

    await recordIncident({
      teamId: scopeTeamId,
      // The LITERAL, not the constant above it. The emitter-totality gate
      // reads the id at the writer call site to prove every registered ACTIVE
      // source has a real producer, and a constant hides that identity from it
      // — which would let a source be registered with nothing writing it.
      sourceId: "billing.dependent_cancellation_failed",
      category: "STORAGE",
      // HIGH throughout: the customer is being charged for the whole time this
      // is open. Escalation is expressed by the state and the attempt count,
      // not by pretending the earlier attempts mattered less.
      severity: "HIGH",
      fingerprint: dependentCancellationFingerprint(addon.id),
      title: manual
        ? "Storage add-on still billing — support needed"
        : "Storage add-on still billing after cancellation",
      safeSummary: manual
        ? "This storage add-on's plan was cancelled but the payment provider has not confirmed the add-on itself is stopped, and automatic retries are exhausted. It may still be charging."
        : "This storage add-on's plan was cancelled but the payment provider has not yet confirmed the add-on itself is stopped. It may still be charging while we retry.",
      // The provider NAME is safe and useful for triage; no identifier is.
      relatedProvider: addon.paymentProvider ?? null,
      metadata: {
        addonId: addon.id,
        addonKey: addon.addonKey,
        storage: humanBytes(addon.extraStorageBytes),
        state: addon.dependentCancellationState,
        attemptCount: addon.dependentCancellationAttemptCount,
        reasonCode: addon.dependentCancellationReasonCode,
        requestedAtUtc:
          addon.dependentCancellationRequestedAtUtc?.toISOString() ?? null,
        lastAttemptAtUtc:
          addon.dependentCancellationFailedAtUtc?.toISOString() ?? null,
        nextRetryAtUtc:
          addon.dependentCancellationNextRetryAtUtc?.toISOString() ?? null,
        supportRequired: manual,
      },
    });
    opened += 1;
  }

  return { opened, skippedUnscoped };
}
