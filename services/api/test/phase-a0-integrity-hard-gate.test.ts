/**
 * Phase A0 — Integrity hard-gate, API surface contract.
 *
 * This suite is intentionally source-contract style (same shape as the
 * Phase 30.9 client-uploads suite): we exercise the modules that can
 * be exercised in isolation, and for the wiring that depends on a
 * live API + DB we assert at the source level that the right
 * invariants hold. That keeps the suite fast and deterministic in CI
 * without the orchestration footprint a full integration test would
 * need.
 *
 * Six contracts:
 *
 *   1. Migration adds `FAILED_HASH_MISMATCH` to `EvidenceStatus` and
 *      `INTEGRITY_REJECTED_HASH_MISMATCH` to `CustodyEventType` via
 *      `ALTER TYPE ... ADD VALUE IF NOT EXISTS`.
 *
 *   2. `schema.prisma` carries both enum values in their respective
 *      enums.
 *
 *   3. The public verify handler in `evidence.routes.ts` hard-404s a
 *      `FAILED_HASH_MISMATCH` row BEFORE the existing not-finalized
 *      branch (anti-enumeration ordering preserved).
 *
 *   4. The `/v1/evidence/:id/reports/regenerate` handler refuses with
 *      409 when status is `FAILED_HASH_MISMATCH` and emits an audit
 *      row with outcome=blocked + reason=integrity_failed.
 *
 *   5. `evidence-complete.service.ts` refuses retry on
 *      `FAILED_HASH_MISMATCH` (the early-return / throw branch).
 *
 *   6. `SECURITY_EVENT_TYPES` includes
 *      `evidence_integrity_rejected`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SECURITY_EVENT_TYPES } from "@proovra/shared";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const MIGRATION_SQL = readSource(
  "../prisma/migrations/20260930000000_phase_a0_integrity_hard_gate/migration.sql",
);
const SCHEMA = readSource("../prisma/schema.prisma");
const EVIDENCE_ROUTES = readSource("../src/routes/evidence.routes.ts");
const EVIDENCE_COMPLETE = readSource(
  "../src/services/evidence-complete.service.ts",
);

describe("Phase A0 — integrity hard-gate (API contract)", () => {
  it("migration adds FAILED_HASH_MISMATCH to EvidenceStatus", () => {
    expect(MIGRATION_SQL).toMatch(
      /ALTER\s+TYPE\s+"EvidenceStatus"\s+ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'FAILED_HASH_MISMATCH'/i,
    );
  });

  it("migration adds INTEGRITY_REJECTED_HASH_MISMATCH to CustodyEventType", () => {
    expect(MIGRATION_SQL).toMatch(
      /ALTER\s+TYPE\s+"CustodyEventType"\s+ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'INTEGRITY_REJECTED_HASH_MISMATCH'/i,
    );
  });

  it("schema.prisma EvidenceStatus enum includes FAILED_HASH_MISMATCH", () => {
    const enumBlock = SCHEMA.match(
      /enum\s+EvidenceStatus\s*\{[^}]*\}/,
    )?.[0];
    expect(enumBlock, "EvidenceStatus enum block").toBeTruthy();
    expect(enumBlock!).toContain("FAILED_HASH_MISMATCH");
  });

  it("schema.prisma CustodyEventType enum includes INTEGRITY_REJECTED_HASH_MISMATCH", () => {
    const enumBlock = SCHEMA.match(
      /enum\s+CustodyEventType\s*\{[\s\S]*?\}/,
    )?.[0];
    expect(enumBlock, "CustodyEventType enum block").toBeTruthy();
    expect(enumBlock!).toContain("INTEGRITY_REJECTED_HASH_MISMATCH");
  });

  it("public verify handler hard-404s FAILED_HASH_MISMATCH BEFORE the 409 not-finalized branch", () => {
    // We expect the FAILED_HASH_MISMATCH branch to appear FIRST inside
    // the public-verify status guard block. Anti-enumeration requires
    // the FAILED case to look identical to "Evidence not found".
    const handlerStart = EVIDENCE_ROUTES.indexOf(
      'app.get("/public/verify/:id"',
    );
    expect(handlerStart).toBeGreaterThan(0);
    const handlerSlice = EVIDENCE_ROUTES.slice(handlerStart, handlerStart + 20_000);

    const failedIdx = handlerSlice.indexOf("FAILED_HASH_MISMATCH");
    const notFinalizedIdx = handlerSlice.indexOf("EVIDENCE_NOT_FINALIZED");
    expect(failedIdx).toBeGreaterThan(0);
    expect(notFinalizedIdx).toBeGreaterThan(0);
    expect(failedIdx).toBeLessThan(notFinalizedIdx);

    // The FAILED branch must return reply.code(404) with the generic
    // "Evidence not found" body. Audit metadata is allowed to carry
    // the real outcome.
    const failedWindow = handlerSlice.slice(failedIdx, failedIdx + 1000);
    expect(failedWindow).toMatch(/reply\.code\(404\)/);
    expect(failedWindow).toContain("Evidence not found");
    expect(failedWindow).toContain('outcome: "integrity_failed"');
  });

  it("regenerate endpoint refuses with 409 + EVIDENCE_INTEGRITY_FAILED for FAILED_HASH_MISMATCH", () => {
    const regenStart = EVIDENCE_ROUTES.indexOf(
      '"/v1/evidence/:id/reports/regenerate"',
    );
    expect(regenStart).toBeGreaterThan(0);
    const regenSlice = EVIDENCE_ROUTES.slice(regenStart, regenStart + 8_000);

    expect(regenSlice).toContain(
      "prismaPkg.EvidenceStatus.FAILED_HASH_MISMATCH",
    );
    expect(regenSlice).toContain("EVIDENCE_INTEGRITY_FAILED");
    expect(regenSlice).toMatch(/reply\.code\(409\)/);

    // The audit row must record the operational reason and the
    // outcome=blocked, so this refusal is searchable in the admin
    // audit chain.
    expect(regenSlice).toContain('outcome: "blocked"');
    expect(regenSlice).toContain('reason: "integrity_failed"');
  });

  it("completion service refuses retry on FAILED_HASH_MISMATCH", () => {
    expect(EVIDENCE_COMPLETE).toContain(
      "evidence.status === EvidenceStatus.FAILED_HASH_MISMATCH",
    );
    expect(EVIDENCE_COMPLETE).toContain("EVIDENCE_INTEGRITY_FAILED");
    expect(EVIDENCE_COMPLETE).toMatch(/statusCode:\s*409/);
  });

  it("SECURITY_EVENT_TYPES includes evidence_integrity_rejected", () => {
    expect(SECURITY_EVENT_TYPES as readonly string[]).toContain(
      "evidence_integrity_rejected",
    );
  });
});
