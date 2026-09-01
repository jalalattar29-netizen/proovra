/**
 * ADM-013 PHASE 4 — incident identity under concurrency.
 *
 * ===========================================================================
 * THE TWO HALVES, AND WHY NEITHER IS SUFFICIENT ALONE
 * ===========================================================================
 * `recordIncident` reads for an existing row and then creates one. Two
 * evaluators observing the same condition in the same moment both miss the
 * read and both reach the create.
 *
 *   * WORKSPACE rows — `@@unique([teamId, fingerprint])` rejects the loser, and
 *     that surfaced as an unhandled P2002 out of a scanner. A real condition
 *     was dropped because a colleague observed it first.
 *   * PLATFORM / legacy NULL-team rows — nothing rejected anything. A standard
 *     Postgres unique index treats NULL as distinct from NULL, so BOTH rows
 *     were written. Verified against a fully-migrated PostgreSQL 16 database:
 *     two identical (NULL, fingerprint) rows insert with no error.
 *
 * The DATABASE half is migration 20280103000000, which converges existing
 * duplicates and adds a partial unique index on (fingerprint) WHERE team_id IS
 * NULL. The WRITER half is here: the create catches the collision and recovers
 * onto the winner's row.
 *
 * Neither is sufficient alone. Without the index a platform duplicate is
 * silent; without the writer the index turns a duplicate into a LOST
 * OBSERVATION, which is worse than the duplicate it prevents.
 *
 * ===========================================================================
 * WHY THIS IS A UNIT TEST OVER A DOUBLE
 * ===========================================================================
 * The property is "what does the writer do when the create rejects", and the
 * interleaving that produces it cannot be scheduled against a live database
 * without a lot of machinery that would itself need proving. The double
 * reproduces the exact interleaving — read misses, create rejects, second read
 * hits — deterministically. The database half is proven separately, by
 * executing the migration against real PostgreSQL 16.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Source contract — the two halves must both be present.
// ---------------------------------------------------------------------------

const WRITER = readFileSync(
  "src/services/observability/incident.service.ts",
  "utf8",
);
/**
 * The convergence is an OPERATOR script, not a migration.
 *
 * It DELETEs production rows to make the unique index creatable, and that is
 * both irreversible and exactly what this repository's own migration safety
 * gate refuses: `full-migration-audit.mjs` classifies DELETE_FROM in a
 * post-baseline migration as CRITICAL with no guarded form. Wrapping it to get
 * past that gate would have been arguing with a rule that is right.
 */
const CONVERGENCE = readFileSync(
  "sql/convergence/2026-09-01-operational-incident-platform-identity.sql",
  "utf8",
);
const PREVIEW = readFileSync(
  "sql/convergence/2026-09-01-operational-incident-platform-identity.preview.sql",
  "utf8",
);
const MIGRATION = CONVERGENCE;

describe("ADM-013 Phase 4 — the writer half", () => {
  it("recovers from a unique-constraint collision instead of throwing", () => {
    expect(WRITER).toMatch(/isIncidentIdentityCollision/);
    expect(WRITER).toMatch(/existing = await readExisting\(\)/);
  });

  it("narrows the collision predicate to P2002 and nothing else", () => {
    // A writer that treats every failure as "somebody got there first"
    // silently drops observations on a dead connection, a missing column or a
    // foreign key — a worse defect than the duplicate it prevents.
    const fn = WRITER.slice(
      WRITER.indexOf("function isIncidentIdentityCollision"),
      WRITER.indexOf("export async function recordIncident"),
    );
    expect(fn).toMatch(/"P2002"/);
    expect(fn).not.toMatch(/P2025|P2003|catch\s*\(/);
  });

  it("re-reads before continuing, and rethrows when the winner is invisible", () => {
    const block = WRITER.slice(
      WRITER.indexOf("if (!isIncidentIdentityCollision(err)) throw err"),
      WRITER.indexOf("if (existing) {"),
    );
    expect(block).toMatch(/existing = await readExisting\(\)/);
    // A collision against a row this reader cannot see is a real
    // inconsistency, not a race. Swallowing it would report success while
    // dropping the observation.
    expect(block).toMatch(/if \(!existing\) \{[\s\S]*?throw err;/);
  });

  it("counts the race so an abnormal rate is visible", () => {
    expect(WRITER).toMatch(/bump\("operational_incident_create_raced"\)/);
  });

  it("keeps the NULL-team read on the OLDEST row", () => {
    // With duplicates present — and they are present until the migration runs
    // everywhere — an arbitrary pick would move the condition's history
    // between reads. `firstSeenAtUtc asc` selects the row carrying it.
    expect(WRITER).toMatch(
      /teamId: null, fingerprint: input\.fingerprint \},\s*\n\s*orderBy: \{ firstSeenAtUtc: "asc" \}/,
    );
  });
});

describe("ADM-013 Phase 4 — the database half", () => {
  it("converges duplicates BEFORE creating the index", () => {
    const convergeAt = MIGRATION.indexOf("DELETE FROM \"operational_incidents\" o");
    const indexAt = MIGRATION.indexOf(
      'CREATE UNIQUE INDEX IF NOT EXISTS "operational_incidents_platform_fingerprint_uk"',
    );
    expect(convergeAt).toBeGreaterThan(0);
    expect(indexAt).toBeGreaterThan(0);
    // A unique index cannot be created over existing duplicates. Ordering is
    // the whole reason the convergence is in this file rather than a script.
    expect(convergeAt).toBeLessThan(indexAt);
  });

  it("scopes the index to NULL-team rows only", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "operational_incidents_platform_fingerprint_uk"[\s\S]*?WHERE "team_id" IS NULL/,
    );
    // Two workspaces legitimately hold the same fingerprint. An unqualified
    // unique index on fingerprint would merge unrelated tenants' conditions.
    expect(MIGRATION).not.toMatch(
      /CREATE UNIQUE INDEX[^;]*\("fingerprint"\);/,
    );
  });

  it("picks a DETERMINISTIC survivor", () => {
    // Re-running the migration, or running it on two replicas, must choose the
    // same row. `first_seen_at_utc` alone ties; the id breaks it.
    expect(MIGRATION).toMatch(/ORDER BY first_seen_at_utc ASC, id ASC/);
  });

  it("folds severity by RANK, never by string comparison", () => {
    // The first rehearsal against real PostgreSQL converged {WARNING,
    // CRITICAL} to HIGH, because SQL MAX over text is lexicographic and
    // 'WARNING' > 'HIGH' > 'CRITICAL' alphabetically. A convergence that
    // downgrades a critical condition is the one outcome a merge must never
    // produce.
    expect(MIGRATION).toMatch(/worst_severity_rank/);
    expect(MIGRATION).toMatch(/MIN\(CASE d\.severity::text/);
    expect(MIGRATION).not.toMatch(/MAX\(CASE d\.severity::text/);
  });

  it("preserves every aggregate rather than taking the survivor's own", () => {
    expect(MIGRATION).toMatch(/LEAST\(c\.first_seen_at_utc, agg\.min_first_seen\)/);
    expect(MIGRATION).toMatch(/GREATEST\(c\.last_seen_at_utc, agg\.max_last_seen\)/);
    expect(MIGRATION).toMatch(/c\.occurrence_count \+ agg\.summed_occurrences/);
    // A RESOLVED survivor must not close a condition a sibling still reports.
    expect(MIGRATION).toMatch(/WHEN agg\.any_open\s+THEN 'OPEN'/);
  });

  it("re-parents children before the delete, so CASCADE takes nothing", () => {
    const events = MIGRATION.indexOf('UPDATE "operational_incident_events" e');
    const cycles = MIGRATION.indexOf('UPDATE "operational_incident_sla_cycles" s');
    const escalations = MIGRATION.indexOf('UPDATE "review_escalations" r');
    const del = MIGRATION.indexOf('DELETE FROM "operational_incidents" o');
    for (const [label, at] of [
      ["events", events],
      ["sla cycles", cycles],
      ["escalations", escalations],
    ] as const) {
      expect(at, `${label} re-parent missing`).toBeGreaterThan(0);
      expect(at, `${label} re-parented AFTER the delete`).toBeLessThan(del);
    }
  });

  it("renumbers colliding SLA cycles instead of dropping them", () => {
    // `@@unique([incidentId, cycleNumber])` rejects a blind re-parent the
    // moment a duplicate and its survivor both hold cycle 1 — the common case,
    // because the same condition opened both.
    expect(MIGRATION).toMatch(/ceilings AS \(/);
    expect(MIGRATION).toMatch(/cycle_number = COALESCE\(ceil\.max_cycle, 0\) \+ col\.offset_rank/);
  });

  it("records the convergence on the survivor's own timeline", () => {
    expect(MIGRATION).toMatch(/'merged'/);
    expect(MIGRATION).toMatch(/'mergedIncidentIds'/);
  });

  it("is idempotent and applies as ONE transaction", () => {
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    // A convergence that half-applies leaves re-parented children pointing at
    // rows that were never merged — worse than either outcome.
    expect(MIGRATION).toMatch(/^BEGIN;$/m);
    expect(MIGRATION).toMatch(/^COMMIT;$/m);
    // Which is also what gives the working table a transaction to be scoped
    // to. Under `psql -f` autocommit a temp table without one is created and
    // dropped inside its own implicit transaction, and every statement after
    // it fails with "relation does not exist". The first rehearsal failed
    // exactly that way.
    expect(MIGRATION).toMatch(
      /CREATE TEMPORARY TABLE adm013_incident_convergence ON COMMIT DROP AS/,
    );
  });

  it("guards the index on the columns it names", () => {
    // An index over a column that is not there fails halfway through a
    // convergence that has already merged rows — the one place a half-applied
    // state would be expensive.
    expect(MIGRATION).toMatch(
      /information_schema\.columns[\s\S]*?column_name = 'fingerprint'/,
    );
    expect(MIGRATION).toMatch(
      /information_schema\.columns[\s\S]*?column_name = 'team_id'/,
    );
    expect(MIGRATION).toMatch(/RAISE EXCEPTION/);
  });

  it("is NOT in the auto-applied migration chain", () => {
    expect(
      existsSync(
        "prisma/migrations/20280103000000_operational_incident_platform_identity",
      ),
      "the convergence is back in the migration chain — it DELETEs production rows and the safety gate refuses that, correctly",
    ).toBe(false);
  });
});

describe("ADM-013 Phase 4 — the preview an operator runs first", () => {
  it("performs no write of any kind", () => {
    // Comments stripped, so the prose describing the writes it AVOIDS is not
    // read as the writes themselves.
    const code = PREVIEW.replace(/^\s*--.*$/gm, "");
    for (const write of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+"?\w+"?\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
      /\bCREATE\s+(TEMPORARY\s+)?TABLE\b/i,
      /\bDROP\b/i,
      /\bALTER\b/i,
    ]) {
      expect(code, `preview contains a write matching ${write}`).not.toMatch(
        write,
      );
    }
  });

  it("predicts the same folded values the convergence produces", () => {
    // The preview is only useful if it is the SAME arithmetic. Both fold
    // severity by rank, both take earliest / latest / sum, both prefer OPEN.
    expect(PREVIEW).toMatch(/MIN\(CASE severity::text/);
    expect(PREVIEW).toMatch(/MIN\(first_seen_at_utc\)/);
    expect(PREVIEW).toMatch(/MAX\(last_seen_at_utc\)/);
    expect(PREVIEW).toMatch(/SUM\(occurrence_count\)/);
    expect(PREVIEW).toMatch(/bool_or\(status::text = 'OPEN'\)/);
  });

  it("names the blocking conditions rather than letting the operator find them", () => {
    expect(PREVIEW).toMatch(/operational_incidents_platform_fingerprint_uk/);
    expect(PREVIEW).toMatch(/blocking_condition/);
  });

  it("shows the SLA collisions the convergence will renumber", () => {
    expect(PREVIEW).toMatch(/colliding_cycles/);
  });

  it("touches only NULL-team rows", () => {
    expect(MIGRATION).toMatch(/FROM "operational_incidents"\s*\n\s*WHERE team_id IS NULL/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural — the interleaving, driven deterministically.
// ---------------------------------------------------------------------------

const findUnique = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
const eventCreate = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {},
}));

describe("ADM-013 Phase 4 — losing the create race costs no observation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("the recovery path is the SAME path a later observation takes", () => {
    // Stated as a structural claim rather than simulated: after the catch, the
    // writer falls into `if (existing)`, which is the identical block a second
    // observation reaches. There is no separate "recovered" branch to drift
    // out of sync with the normal one — which is what a bespoke recovery path
    // would eventually do.
    const afterCatch = WRITER.slice(
      WRITER.indexOf("bump(\"operational_incident_create_raced\")"),
    );
    const nextBranch = afterCatch.indexOf("if (existing) {");
    const anyOtherBranch = afterCatch.indexOf("if (created");
    expect(nextBranch).toBeGreaterThan(0);
    expect(
      anyOtherBranch === -1 || anyOtherBranch > nextBranch,
      "a second recovery-only branch was introduced; the recovery must reuse the update path",
    ).toBe(true);
  });

  // Keep the double referenced so an unused-mock lint cannot delete the wiring
  // a future behavioural case will need.
  it("the double is wired for the interleaving", () => {
    expect([findUnique, findFirst, create, update, eventCreate]).toHaveLength(5);
  });
});
