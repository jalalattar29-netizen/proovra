/**
 * THE RUNTIME HALF OF THE OPERATIONS WRITER SCHEMA CONTRACT.
 *
 * `scripts/operations-writer-schema-contract.mjs` owns the contract itself and
 * is the SINGLE authority: the release preflight, CI and this module all ask
 * it the same question and none of them re-implements the answer. What lives
 * here is only the part that is specific to a running server — caching, and
 * the decision about what a violation does to readiness.
 *
 * WHY READINESS AND NOT A CRASH
 * ---------------------------------------------------------------------------
 * A process that exits on a schema disagreement cannot be exec'd into to apply
 * the migration, and takes the API down for every surface — including the ones
 * that are working perfectly, which during this incident was almost all of
 * them. `/readyz` failing takes the instance out of rotation while leaving it
 * alive and inspectable, which is the same posture the existing required-schema
 * canary already uses.
 *
 * WHY IT IS CACHED
 * ---------------------------------------------------------------------------
 * `/readyz` is polled by orchestrators at a high rate, and this is four catalog
 * reads. The contract can only change when a migration is applied, so the
 * result is cached — but a FAILING result is cached for a much shorter window
 * than a passing one, so an instance recovers on its own shortly after the
 * migration lands rather than needing a restart to notice.
 */

import { prisma } from "../../db.js";

export type WriterContractStatus = {
  ok: boolean;
  /** Bounded, operator-facing. Never a driver message. Empty when ok. */
  detail: string;
  /** Tables whose contract could not be established. */
  indeterminate: string[];
};

const PASS_TTL_MS = 5 * 60 * 1000;
const FAIL_TTL_MS = 15 * 1000;

let cached: { at: number; value: WriterContractStatus } | null = null;

/** Drop the cache. Tests and the reconcile path use this; nothing else needs it. */
export function resetWriterContractCache(): void {
  cached = null;
}

export async function checkWriterSchemaContract(
  now: number = Date.now(),
): Promise<WriterContractStatus> {
  if (cached) {
    const ttl = cached.value.ok ? PASS_TTL_MS : FAIL_TTL_MS;
    if (now - cached.at < ttl) return cached.value;
  }

  let value: WriterContractStatus;
  try {
    const [{ checkOperationsWriterContract, describeWriterContractFailure }, { Prisma }] =
      await Promise.all([
        import("../../../scripts/operations-writer-schema-contract.mjs"),
        import("@prisma/client"),
      ]);
    const result = await checkOperationsWriterContract(
      Prisma.dmmf,
      async (sql: string) =>
        (await prisma.$queryRawUnsafe(sql)) as Array<{ missing_column: string }>,
    );
    value = {
      ok: result.ok,
      detail: result.ok ? "" : describeWriterContractFailure(result),
      indeterminate: result.indeterminate,
    };
  } catch {
    // FAIL CLOSED. The contract could not be established, and "we could not
    // look" must never read as "it is there" — that equivalence is the entire
    // defect this module exists to remove.
    value = {
      ok: false,
      detail:
        "the Operations writer schema contract could not be established against this database",
      indeterminate: ["<contract check unavailable>"],
    };
  }

  cached = { at: now, value };
  return value;
}
