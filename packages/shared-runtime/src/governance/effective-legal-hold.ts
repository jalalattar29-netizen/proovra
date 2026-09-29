/**
 * PHASE 12B CLUSTER 8 — THE effective legal-hold evaluator.
 *
 * ONE function answers "is this target protected by ANY legal hold, from ANY
 * store, right now?". Before this file the answer was split three ways and the
 * three answers disagreed:
 *
 *   - evidence-delete-eligibility read ONLY `evidence_legal_holds`
 *   - the worker lifecycle gate read ONLY `legal_holds`
 *   - case-legal-hold.service read ONLY `case_legal_holds`
 *
 * Every destructive path now evaluates the UNION and FAILS CLOSED.
 *
 * ---------------------------------------------------------------------------
 * MIRRORED FILE — DO NOT EDIT ONE COPY.
 *
 *   services/api/src/services/governance/effective-legal-hold.ts
 *   services/worker/src/governance/effective-legal-hold.ts
 *
 * are BYTE-IDENTICAL. The worker process cannot import api services, so the
 * union rule is duplicated rather than allowed to diverge — the same pattern
 * already used by `lifecycle-legal-hold.ts`. The convergence matrix
 * (services/api/test/phase-12b-legal-hold-convergence.test.ts) fails if the
 * two files drift by a single byte.
 * ---------------------------------------------------------------------------
 *
 * FAIL-CLOSED CONTRACT
 *
 * A transient database failure MUST NOT be read as "no hold". Only a
 * genuinely-absent relation or column may degrade a clause to "no match"
 * (Prisma P2021 / P2022, or a raw Postgres "... does not exist"), and only for
 * the clauses that cannot possibly have rows in that shape yet. Every other
 * error is rethrown so the destructive run aborts.
 *
 * EXPIRY NEVER AUTO-UNBLOCKS
 *
 * `expiresAtUtc` is deliberately NOT consulted here. A hold stops protecting
 * its target only when an explicit state transition moves it out of ACTIVE
 * (RELEASED by an operator, or EXPIRED by an explicit sweep). Reading a
 * passed expiry as "not held" would let a clock make evidence destructible.
 *
 * SCOPE SEMANTICS (accepted, preserved)
 *
 * `CaseEvidenceLink` is the ONE Case↔Evidence authority (Evidence.caseId no
 * longer exists). Evidence may be linked to MULTIPLE cases, and an ACTIVE
 * hold on ANY linked case blocks.
 *
 * AN UNRESOLVED (HISTORICAL) HOLD BLOCKS
 *
 * A converged hold whose original target row no longer exists is stored with
 * `historical = true` and NULL targets — the scope/target CHECK constraint
 * exempts exactly those rows. An unresolvable target means we cannot prove the
 * hold does NOT cover this record, so while such a row is still ACTIVE it
 * BLOCKS every record in its workspace. That is deliberately conservative: an
 * operator resolving one orphan (visible in the readiness report as
 * ORPHAN_TARGET_*) is recoverable, destroyed evidence is not.
 *
 * SCOPE IS NEVER INFERRED FROM A NULL TARGET
 *
 * No clause below filters on `evidenceId: null`. A NULL target is not a scope
 * signal — `scope` is. Matching on the absence of a target would let a single
 * mis-scoped row widen into "every record", which is a false negative waiting
 * to happen in the other direction the moment the predicate is inverted.
 */
import type { PrismaClient } from "@prisma/client";

export type EffectiveLegalHoldSource =
  | "EVIDENCE_LEGAL_HOLD"
  | "CASE_LEGAL_HOLD"
  | "LIFECYCLE_LEGAL_HOLD";

export type EffectiveLegalHoldScope = "EVIDENCE" | "CASE" | "WORKSPACE";

export type EffectiveLegalHoldInput = {
  /** Tenant authority. `null` = personal-scope evidence (no workspace holds). */
  teamId: string | null;
  evidenceId?: string | null;
  /**
   * Linked case ids. When omitted AND an evidenceId is supplied, the links are
   * resolved from `CaseEvidenceLink`. Pass explicitly to avoid the roundtrip.
   */
  caseIds?: readonly string[];
  /**
   * Collect every matching hold instead of short-circuiting on the first.
   * Only for reporting surfaces — destructive gates want the cheap answer.
   */
  collectAll?: boolean;
};

export type EffectiveLegalHoldMatch = {
  holdId: string;
  source: EffectiveLegalHoldSource;
  scope: EffectiveLegalHoldScope;
  /**
   * The hold's original target row no longer exists (`historical = true`).
   * Its reach cannot be proven, so it blocks its whole workspace.
   */
  unresolved?: boolean;
};

export type EffectiveLegalHoldResult = {
  held: boolean;
  matches: readonly EffectiveLegalHoldMatch[];
  holdIds: readonly string[];
  sources: readonly EffectiveLegalHoldSource[];
  reasonCode:
    | "EVIDENCE_HOLD"
    | "CASE_HOLD"
    | "WORKSPACE_HOLD"
    | "UNRESOLVED_HOLD"
    | null;
};

const EMPTY_RESULT: EffectiveLegalHoldResult = {
  held: false,
  matches: [],
  holdIds: [],
  sources: [],
  reasonCode: null,
};

/**
 * True ONLY for a genuinely-absent relation/column. Everything else — timeout,
 * connection reset, permission error — is a transient failure that must abort
 * the caller rather than silently report "no hold".
 */
export function isAbsentRelationError(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code === "P2021" || code === "P2022") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /does not exist/i.test(msg);
}

/**
 * Runs a clause that may target a relation/column absent in older
 * environments. Degrades to `null` ONLY on an absent relation; rethrows
 * everything else.
 */
async function tolerateAbsentRelation<T>(
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (isAbsentRelationError(err)) return null;
    throw err;
  }
}

function summarize(
  matches: readonly EffectiveLegalHoldMatch[],
): EffectiveLegalHoldResult {
  if (matches.length === 0) return EMPTY_RESULT;
  const sources: EffectiveLegalHoldSource[] = [];
  for (const m of matches) {
    if (!sources.includes(m.source)) sources.push(m.source);
  }
  // Most specific RESOLVED scope wins the reason code; the block itself is
  // identical either way. When ONLY unresolved (historical) holds matched the
  // reason says so, because the remedy is different: an operator has to
  // resolve the orphan, not release a hold on this record.
  const resolved = matches.filter((m) => m.unresolved !== true);
  if (resolved.length === 0) {
    return {
      held: true,
      matches,
      holdIds: matches.map((m) => m.holdId),
      sources,
      reasonCode: "UNRESOLVED_HOLD",
    };
  }
  const scopes = resolved.map((m) => m.scope);
  const reasonCode = scopes.includes("EVIDENCE")
    ? ("EVIDENCE_HOLD" as const)
    : scopes.includes("CASE")
      ? ("CASE_HOLD" as const)
      : ("WORKSPACE_HOLD" as const);
  return {
    held: true,
    matches,
    holdIds: matches.map((m) => m.holdId),
    sources,
    reasonCode,
  };
}

/**
 * Resolve the cases an evidence row is linked to. NOT degradable — a failure
 * here means we cannot know whether a case hold applies, so the caller must
 * abort rather than proceed as if the evidence were unlinked.
 */
export async function resolveLinkedCaseIds(
  prisma: PrismaClient,
  evidenceId: string,
): Promise<string[]> {
  const links = await prisma.caseEvidenceLink.findMany({
    where: { evidenceId },
    select: { caseId: true },
    take: 200,
  });
  return links.map((l) => l.caseId);
}

/**
 * THE union evaluator. Returns whether ANY active hold from ANY store
 * protects the target.
 */
export async function evaluateEffectiveLegalHold(
  prisma: PrismaClient,
  input: EffectiveLegalHoldInput,
): Promise<EffectiveLegalHoldResult> {
  const evidenceId = input.evidenceId ?? null;
  const teamId = input.teamId ?? null;
  const collectAll = input.collectAll === true;
  const matches: EffectiveLegalHoldMatch[] = [];

  let caseIds: string[] = input.caseIds ? Array.from(new Set(input.caseIds)) : [];
  if (!input.caseIds && evidenceId) {
    caseIds = Array.from(new Set(await resolveLinkedCaseIds(prisma, evidenceId)));
  }

  // ---- Clause A — evidence-direct hold in the canonical table. --------------
  // Deliberately restricted to columns that predate the canonical migration
  // (`evidence_id`, `status`) so this clause NEVER degrades: it is the single
  // most important block condition and must work in every environment.
  if (evidenceId) {
    const direct = await prisma.evidenceLegalHold.findMany({
      where: { evidenceId, status: "ACTIVE" },
      select: { id: true },
      take: 25,
    });
    for (const row of direct) {
      matches.push({
        holdId: row.id,
        source: "EVIDENCE_LEGAL_HOLD",
        scope: "EVIDENCE",
      });
    }
    if (matches.length > 0 && !collectAll) return summarize(matches);
  }

  // ---- Clause B — CASE / WORKSPACE scoped + UNRESOLVED rows. ---------------
  // Uses the CLUSTER 8 columns (`scope`, `historical`). Degradable: before the
  // canonical migration is applied those columns do not exist, and no row can
  // possibly carry a non-EVIDENCE scope or historical flag yet, so degrading
  // loses no protection.
  //
  // Three clause shapes, all keyed on `scope` — never on the ABSENCE of a
  // target, which would silently widen the query:
  //   * scope WORKSPACE, resolved → covers every record in the workspace
  //   * scope CASE, resolved      → covers records linked to a matching case
  //   * historical (ANY scope)    → target unresolvable, so FAIL CLOSED and
  //                                 block the whole workspace until resolved
  if (teamId) {
    const scopeClauses: Array<Record<string, unknown>> = [
      { scope: "WORKSPACE", historical: false },
      { historical: true },
    ];
    if (caseIds.length > 0) {
      scopeClauses.push({
        scope: "CASE",
        caseId: { in: caseIds },
        historical: false,
      });
    }
    const scoped = await tolerateAbsentRelation(() =>
      prisma.evidenceLegalHold.findMany({
        where: {
          teamId,
          status: "ACTIVE",
          OR: scopeClauses,
        },
        select: { id: true, scope: true, historical: true },
        take: 25,
      }),
    );
    for (const row of scoped ?? []) {
      const unresolved = row.historical === true;
      matches.push({
        holdId: row.id,
        source: "EVIDENCE_LEGAL_HOLD",
        // An unresolved hold cannot claim a narrower reach than the workspace.
        scope: unresolved ? "WORKSPACE" : row.scope === "CASE" ? "CASE" : "WORKSPACE",
        ...(unresolved ? { unresolved: true } : {}),
      });
    }
    if (matches.length > 0 && !collectAll) return summarize(matches);
  }

  // ---- Clauses C and D (legacy store union) — RETIRED in Phase 12
  // Point 3. `case_legal_holds` and `legal_holds` were read here during
  // the migration window. The backfill (20271107000000) converted every
  // row of both stores into a canonical row that clause A or B already
  // matches, and 20271108000000 drops the tables. The evaluator's answer
  // is unchanged; it now has exactly ONE source of truth.

  return summarize(matches);
}

/** Cheap boolean form of {@link evaluateEffectiveLegalHold}. */
export async function isUnderEffectiveLegalHold(
  prisma: PrismaClient,
  input: EffectiveLegalHoldInput,
): Promise<boolean> {
  const result = await evaluateEffectiveLegalHold(prisma, input);
  return result.held;
}
