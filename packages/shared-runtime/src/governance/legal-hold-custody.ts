/**
 * LEGAL HOLD ON THE CUSTODY CHAIN (ET-CUS-03, 2026-09-29).
 *
 * A hold is a preservation control; every record it covers must show it on its
 * own custody chain. Until 2026-09-29 the chain received it only best-effort:
 * a fire-and-forget fan-out after the hold committed, with every failure
 * swallowed, a CASE scope capped at 1000 records fired as one Promise.all
 * burst, a WORKSPACE scope never recorded at all, and evidence linked to a held
 * case (or created in a held workspace) afterwards never recorded either.
 *
 * Now:
 *   - an EVIDENCE-scope hold appends its event in the SAME transaction that
 *     places or releases it (legal-hold.service);
 *   - every hold's coverage is REconciled by `reconcileLegalHoldCustody`: for
 *     each covered record without this hold's event, the event is appended
 *     under the evidence lock, re-checked inside the transaction so concurrent
 *     runs append once. It runs right after a CASE/WORKSPACE placement or
 *     release (bounded) and on the Worker's governance sweep, so a failure, a
 *     large scope, a later link or a later record is caught up rather than
 *     lost.
 *
 * Coverage matches THE effective-hold evaluator (effective-legal-hold.ts):
 * EVIDENCE = that record; CASE = records linked to the case (CaseEvidenceLink);
 * WORKSPACE = records whose teamId is the hold's workspace. A released hold
 * appends its release event to every record that recorded its placement.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { appendCustodyEventTx } from "../custody/custody-chain.js";

type HoldScope = "EVIDENCE" | "CASE" | "WORKSPACE";

export type LegalHoldCustodyHold = {
  id: string;
  teamId: string;
  scope: string;
  evidenceId: string | null;
  caseId: string | null;
  status: string;
  title: string;
  placedByUserId: string | null;
  releasedByUserId: string | null;
};

export function legalHoldCustodyEventType(
  scope: string,
  kind: "PLACED" | "RELEASED",
): prismaPkg.CustodyEventType {
  if (scope === "CASE") {
    return kind === "PLACED"
      ? prismaPkg.CustodyEventType.CASE_LEGAL_HOLD_APPLIED
      : prismaPkg.CustodyEventType.CASE_LEGAL_HOLD_RELEASED;
  }
  return kind === "PLACED"
    ? prismaPkg.CustodyEventType.LEGAL_HOLD_PLACED
    : prismaPkg.CustodyEventType.LEGAL_HOLD_RELEASED;
}

async function hasHoldEvent(
  tx: Prisma.TransactionClient,
  evidenceId: string,
  eventType: prismaPkg.CustodyEventType,
  holdId: string,
): Promise<boolean> {
  const found = await tx.custodyEvent.findFirst({
    where: { evidenceId, eventType, payload: { path: ["legalHoldId"], equals: holdId } },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Append this hold's PLACED or RELEASED event to one record, once. Inside the
 * caller's transaction; the custody appender takes the evidence lock, and the
 * existence check runs after it, so two writers append exactly once.
 */
export async function appendLegalHoldCustodyTx(
  tx: Prisma.TransactionClient,
  params: {
    hold: Pick<LegalHoldCustodyHold, "id" | "scope" | "title">;
    evidenceId: string;
    kind: "PLACED" | "RELEASED";
    actorUserId: string | null;
    at: Date;
    /** Internal only; never surfaced publicly. */
    releaseNoteInternal?: string | null;
    source: "COMMAND" | "RECONCILED";
  },
): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))`;
  const eventType = legalHoldCustodyEventType(params.hold.scope, params.kind);
  if (await hasHoldEvent(tx, params.evidenceId, eventType, params.hold.id)) return false;
  await appendCustodyEventTx(tx, {
    evidenceId: params.evidenceId,
    eventType,
    atUtc: params.at,
    payload: {
      legalHoldId: params.hold.id,
      scope: params.hold.scope,
      title: params.hold.title,
      ...(params.kind === "PLACED"
        ? { placedByUserId: params.actorUserId }
        : { releasedByUserId: params.actorUserId }),
      ...(params.releaseNoteInternal ? { releaseNoteInternal: params.releaseNoteInternal.slice(0, 4000) } : {}),
      // RECONCILED: recorded when the record came under (or left) the hold's
      // coverage was observed — not necessarily when the hold was placed.
      recordedBy: params.source,
    },
  });
  return true;
}

/** Records a hold covers that do not yet carry its event (bounded). */
async function uncoveredRecords(
  client: PrismaClient,
  hold: LegalHoldCustodyHold,
  kind: "PLACED" | "RELEASED",
  limit: number,
): Promise<string[]> {
  const eventType = legalHoldCustodyEventType(hold.scope, kind);
  const placedType = legalHoldCustodyEventType(hold.scope, "PLACED");
  const scope = hold.scope as HoldScope;
  // RELEASED: exactly the records that recorded this hold's placement.
  const covered =
    kind === "RELEASED"
      ? prismaPkg.Prisma.sql`EXISTS (SELECT 1 FROM custody_events p WHERE p.evidence_id = e.id
           AND p.event_type = ${placedType}::"CustodyEventType" AND p.payload->>'legalHoldId' = ${hold.id})`
      : scope === "EVIDENCE"
        ? prismaPkg.Prisma.sql`e.id = ${hold.evidenceId}::uuid`
        : scope === "CASE"
          ? prismaPkg.Prisma.sql`e.id IN (SELECT l.evidence_id FROM case_evidence_links l WHERE l.case_id = ${hold.caseId}::uuid)`
          : prismaPkg.Prisma.sql`e.team_id = ${hold.teamId}::uuid`;
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT e.id FROM evidence e
    WHERE ${covered}
      AND e.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM custody_events c
        WHERE c.evidence_id = e.id
          AND c.event_type = ${eventType}::"CustodyEventType"
          AND c.payload->>'legalHoldId' = ${hold.id}
      )
    ORDER BY e.id
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

export type ReconcileLegalHoldCustodyResult = { holds: number; appended: number; failed: number };

const HOLD_SELECT = {
  id: true,
  teamId: true,
  scope: true,
  evidenceId: true,
  caseId: true,
  status: true,
  title: true,
  placedByUserId: true,
  releasedByUserId: true,
} as const;

/**
 * Bring custody in line with hold coverage. `holdId` restricts the run to one
 * hold (the command path); otherwise every non-historical ACTIVE or RELEASED
 * hold is visited (the sweep). Bounded by `perHoldLimit`; the next run
 * continues where this one stopped.
 */
export async function reconcileLegalHoldCustody(
  client: PrismaClient,
  options: { holdId?: string; perHoldLimit?: number; maxHolds?: number; now?: Date } = {},
): Promise<ReconcileLegalHoldCustodyResult> {
  const perHoldLimit = Math.max(1, Math.min(options.perHoldLimit ?? 500, 5000));
  const now = options.now ?? new Date();
  const holds = (await client.evidenceLegalHold.findMany({
    where: {
      historical: false,
      status: { in: ["ACTIVE", "RELEASED"] },
      ...(options.holdId ? { id: options.holdId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: options.holdId ? 1 : Math.max(1, Math.min(options.maxHolds ?? 200, 2000)),
    select: HOLD_SELECT,
  })) as unknown as LegalHoldCustodyHold[];

  const result: ReconcileLegalHoldCustodyResult = { holds: holds.length, appended: 0, failed: 0 };
  for (const hold of holds) {
    const kinds: Array<"PLACED" | "RELEASED"> = hold.status === "ACTIVE" ? ["PLACED"] : ["RELEASED"];
    for (const kind of kinds) {
      const ids = await uncoveredRecords(client, hold, kind, perHoldLimit);
      for (const evidenceId of ids) {
        try {
          const appended = await client.$transaction((tx) =>
            appendLegalHoldCustodyTx(tx, {
              hold,
              evidenceId,
              kind,
              actorUserId: kind === "PLACED" ? hold.placedByUserId : hold.releasedByUserId,
              at: now,
              source: "RECONCILED",
            }),
          );
          if (appended) result.appended++;
        } catch {
          // Counted, and retried by the next run — never silently lost.
          result.failed++;
        }
      }
    }
  }
  return result;
}
