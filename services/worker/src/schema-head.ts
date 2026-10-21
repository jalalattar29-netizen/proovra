/**
 * AUD-32 (2026-10-20) — THE WORKER REFUSES TO RUN AGAINST A SCHEMA OLDER THAN
 * ITS OWN CODE.
 *
 * The API image migrates; the worker image carries no migrations and never
 * checked. A worker deployed ahead of its migration (or beside a database
 * restored from an older backup) ran its processors against columns that did
 * not exist yet and failed every job, or — worse — wrote with an older
 * column's meaning.
 *
 * The expected head is a constant here, pinned by a test against the API's
 * migrations directory, so adding a migration without updating it fails CI.
 * At boot the worker asks `_prisma_migrations` whether that migration is
 * applied (finished, not rolled back) and does not start its consumers when it
 * is not.
 */

/** The newest migration this worker build was written against. */
export const EXPECTED_MIGRATION_HEAD = "20281021000100_output_lease_renewal_and_issued_custody_cutoff";

export type MigrationRow = {
  migration_name: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
};

export type SchemaHeadProblem =
  | { kind: "HEAD_NOT_APPLIED"; expected: string }
  | { kind: "HEAD_FAILED"; expected: string }
  | { kind: "UNREADABLE"; expected: string; message: string };

/** Null when the database has applied the expected head. */
export async function schemaHeadProblem(
  readRows: (name: string) => Promise<MigrationRow[]>,
  expected: string = EXPECTED_MIGRATION_HEAD,
): Promise<SchemaHeadProblem | null> {
  let rows: MigrationRow[];
  try {
    rows = await readRows(expected);
  } catch (err) {
    return { kind: "UNREADABLE", expected, message: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
  const mine = rows.filter((r) => r.migration_name === expected);
  if (mine.length === 0) return { kind: "HEAD_NOT_APPLIED", expected };
  if (!mine.some((r) => r.finished_at !== null && r.rolled_back_at === null)) return { kind: "HEAD_FAILED", expected };
  return null;
}

/**
 * Boot gate. A migration may be running as the worker starts (the API image
 * migrates), so the head is asked again for a bounded window before the
 * process gives up. It exits non-zero rather than run any consumer against an
 * older schema; the orchestrator restarts it once the schema is current.
 */
export async function enforceSchemaHeadBeforeConsumers(deps: {
  readRows: (name: string) => Promise<MigrationRow[]>;
  log: (level: "info" | "error", obj: Record<string, unknown>, msg: string) => void;
  exit: (code: number) => never | void;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}): Promise<boolean> {
  const attempts = deps.attempts ?? 20;
  const intervalMs = deps.intervalMs ?? 15_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let problem: SchemaHeadProblem | null = null;
  for (let i = 1; i <= attempts; i += 1) {
    problem = await schemaHeadProblem(deps.readRows);
    if (!problem) {
      deps.log("info", { expected: EXPECTED_MIGRATION_HEAD, attempt: i }, "worker.schema_head.current");
      return true;
    }
    if (i < attempts) await sleep(intervalMs);
  }
  deps.log("error", { ...problem, attempts }, "worker.schema_head.behind_refusing_to_start");
  deps.exit(1);
  return false;
}
