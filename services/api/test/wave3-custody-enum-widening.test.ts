/**
 * Wave 3 — Phase 7A: CustodyEventType enum widening regression test
 * (source-contract).
 *
 * Pins the Phase 7A schema-side work that unblocks Phase 7B custody
 * emits from the Investigation-mutation surfaces:
 *
 *   * 8 new values appended to the Prisma `CustodyEventType` enum:
 *       DUPLICATE_DECISION_RECORDED
 *       MANUAL_RELATIONSHIP_CREATED
 *       MANUAL_RELATIONSHIP_RETRACTED
 *       GRAPH_RECONCILE_REQUESTED
 *       MEDIA_INTELLIGENCE_REFRESH_REQUESTED
 *       INVESTIGATION_GRAPH_EXPORTED
 *       INVESTIGATION_TIMELINE_EXPORTED
 *       INVESTIGATION_DUPLICATES_EXPORTED
 *
 *   * Wave 3 additive migration file exists under
 *     `20270812000000_wave3_custody_event_type_widening/` and uses
 *     ALTER TYPE ... ADD VALUE IF NOT EXISTS wrapped in a DO $$
 *     pg_enum + pg_type lookup guard for every new value.
 *
 *   * Migration is allowlisted in the phase-32-7-2 drift gate so the
 *     downstream CI gate keeps the file off the "unattributed
 *     post-baseline migration" list.
 *
 *   * Phase O safety gate: the migration is structurally clean
 *     (additive ALTER TYPE ADD VALUE — classified HIGH, not
 *     CRITICAL) so no APPROVED_CRITICAL_BY_MIGRATION entry is
 *     required. We assert this by re-running detectFindings on the
 *     migration text and confirming zero CRITICAL findings.
 *
 *   * Hard rule (additive only): the migration source contains zero
 *     ALTER TYPE ... DROP VALUE / RENAME VALUE statements.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

const SCHEMA = readApi("prisma/schema.prisma");
const MIGRATION_DIR =
  "prisma/migrations/20270812000000_wave3_custody_event_type_widening";
const MIGRATION_SQL_PATH = `${MIGRATION_DIR}/migration.sql`;
const MIGRATION_SQL = readApi(MIGRATION_SQL_PATH);
const PHASE_32_7_2 = readApi(
  "test/phase-32-7-2-security-event-mapping-drift.test.ts",
);

const NEW_VALUES = [
  "DUPLICATE_DECISION_RECORDED",
  "MANUAL_RELATIONSHIP_CREATED",
  "MANUAL_RELATIONSHIP_RETRACTED",
  "GRAPH_RECONCILE_REQUESTED",
  "MEDIA_INTELLIGENCE_REFRESH_REQUESTED",
  "INVESTIGATION_GRAPH_EXPORTED",
  "INVESTIGATION_TIMELINE_EXPORTED",
  "INVESTIGATION_DUPLICATES_EXPORTED",
] as const;

describe("Wave 3 — CustodyEventType enum widening (Phase 7A)", () => {
  it("CustodyEventType enum block is present in schema.prisma", () => {
    expect(SCHEMA).toMatch(/enum\s+CustodyEventType\s*\{/);
  });

  it("all 8 new values are appended to the CustodyEventType enum", () => {
    const match = SCHEMA.match(/enum\s+CustodyEventType\s*\{([\s\S]*?)\n\}/m);
    expect(match, "CustodyEventType block must be readable").toBeTruthy();
    const block = match![1];
    for (const value of NEW_VALUES) {
      // Each value sits on its own line inside the enum block (no leading
      // comment-only matches). Anchor on word-boundary to avoid matching
      // a comment that mentions the value name.
      const lineRegex = new RegExp(`^\\s*${value}\\s*$`, "m");
      expect(
        lineRegex.test(block),
        `expected ${value} on its own line in CustodyEventType enum`,
      ).toBe(true);
    }
  });

  it("existing forensic baseline values are still present (additive only — zero deletions)", () => {
    // Anchor a small representative set of pre-existing values that must
    // never be removed. A full enumeration would be brittle and overlap
    // with other source-contract tests.
    const block = (SCHEMA.match(
      /enum\s+CustodyEventType\s*\{([\s\S]*?)\n\}/m,
    ) ?? ["", ""])[1];
    for (const value of [
      "EVIDENCE_CREATED",
      "UPLOAD_AUTHORIZED",
      "UPLOAD_COMPLETED",
      "EVIDENCE_COMPLETED",
      "SIGNATURE_APPLIED",
      "TIMESTAMP_APPLIED",
      "REPORT_GENERATED",
      "ANCHOR_PUBLISHED",
      "OTS_APPLIED",
      "EVIDENCE_DOWNLOADED",
      "EVIDENCE_LOCKED",
      "EVIDENCE_ARCHIVED",
      "EXTERNAL_INTAKE_SUBMITTED",
      "LEGAL_HOLD_PLACED",
      "PUBLIC_VERIFY_PUBLISHED",
      "REPORT_PDF_SIGNED",
      "INTEGRITY_REJECTED_HASH_MISMATCH",
      "CAPTURE_TRUST_EVENT",
    ]) {
      const lineRegex = new RegExp(`^\\s*${value}\\s*$`, "m");
      expect(
        lineRegex.test(block),
        `pre-existing ${value} must remain in CustodyEventType enum`,
      ).toBe(true);
    }
  });
});

describe("Wave 3 — additive Prisma migration", () => {
  it("migration directory exists at the Wave 3 timestamp", () => {
    const dir = fileURLToPath(
      new URL(`../${MIGRATION_DIR}`, import.meta.url),
    );
    expect(existsSync(dir)).toBe(true);
  });

  it("migration file exists", () => {
    const file = fileURLToPath(
      new URL(`../${MIGRATION_SQL_PATH}`, import.meta.url),
    );
    expect(existsSync(file)).toBe(true);
  });

  it("migration declares a wave3_readiness marker (Phase O additive pattern)", () => {
    expect(MIGRATION_SQL).toMatch(/wave3_readiness/);
  });

  it("each of the 8 new values has an ALTER TYPE ADD VALUE statement", () => {
    for (const value of NEW_VALUES) {
      const stmt = new RegExp(
        `ALTER TYPE\\s+"CustodyEventType"\\s+ADD VALUE IF NOT EXISTS\\s+'${value}'`,
      );
      expect(
        stmt.test(MIGRATION_SQL),
        `missing ALTER TYPE ... ADD VALUE IF NOT EXISTS '${value}'`,
      ).toBe(true);
    }
  });

  it("each ALTER TYPE is wrapped in a DO $$ block guarded by pg_enum + pg_type lookup", () => {
    // Each guard pattern: DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum
    // WHERE enumlabel = '<value>' ...) THEN ALTER TYPE ... ADD VALUE ...
    for (const value of NEW_VALUES) {
      const guard = new RegExp(
        `IF NOT EXISTS\\s*\\(\\s*SELECT 1 FROM pg_enum\\s+WHERE enumlabel = '${value}'[\\s\\S]*?pg_type WHERE typname = 'CustodyEventType'`,
      );
      expect(
        guard.test(MIGRATION_SQL),
        `missing pg_enum guard for '${value}'`,
      ).toBe(true);
    }
    // 8 DO $$ blocks total — one per value. Strip line comments first so
    // the migration header (which mentions "DO $$" in prose) does not
    // inflate the count.
    const sqlNoComments = MIGRATION_SQL.split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const doBlocks = (sqlNoComments.match(/DO\s*\$\$/g) ?? []).length;
    expect(doBlocks).toBe(8);
  });

  it("migration is purely additive — zero DROP VALUE / RENAME VALUE / data movement", () => {
    // Strip `-- …` line comments before matching so the migration header
    // can mention what it does NOT do (e.g. "no DROP VALUE / RENAME") without
    // tripping the gate.
    const sqlNoComments = MIGRATION_SQL.split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    expect(sqlNoComments).not.toMatch(/\bDROP\s+VALUE\b/i);
    expect(sqlNoComments).not.toMatch(/\bRENAME\s+VALUE\b/i);
    expect(sqlNoComments).not.toMatch(/\bDROP TABLE\b/i);
    expect(sqlNoComments).not.toMatch(/\bDROP COLUMN\b/i);
    expect(sqlNoComments).not.toMatch(/\bTRUNCATE\b/i);
    expect(sqlNoComments).not.toMatch(/\bUPDATE\b/i);
    expect(sqlNoComments).not.toMatch(/\bDELETE FROM\b/i);
    // ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so
    // the migration must NOT wrap the body in BEGIN; / COMMIT;.
    expect(sqlNoComments).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sqlNoComments).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

describe("Wave 3 — CI gate allowlisting", () => {
  it("migration is allowlisted in the phase-32-7-2 drift gate", () => {
    expect(PHASE_32_7_2).toMatch(
      /20270812000000_wave3_custody_event_type_widening/,
    );
  });

  it("Phase O migration safety gate accepts the migration (zero CRITICAL findings)", async () => {
    // The Phase O gate (phase-o-migration-safety-gate.test.ts) only
    // blocks on CRITICAL findings. ENUM_ADD_VALUE + ALTER_TYPE are both
    // classified HIGH by `full-migration-audit.mjs`, so no
    // APPROVED_CRITICAL_BY_MIGRATION entry is required for this
    // migration. We assert that by importing the audit script and
    // confirming the finding set contains zero CRITICAL entries.
    const auditPath = fileURLToPath(
      new URL("../scripts/full-migration-audit.mjs", import.meta.url),
    );
    const audit = (await import(auditPath)) as {
      detectFindings(sql: string): {
        findings: ReadonlyArray<{ risk: string; kind: string }>;
      };
    };
    const { findings } = audit.detectFindings(MIGRATION_SQL);
    const critical = findings.filter((f) => f.risk === "CRITICAL");
    expect(
      critical,
      `unexpected CRITICAL findings: ${JSON.stringify(critical)}`,
    ).toEqual([]);
  });
});
