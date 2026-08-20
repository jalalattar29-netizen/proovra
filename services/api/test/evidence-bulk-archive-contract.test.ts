/**
 * Bulk ARCHIVE — the contract the client reports against.
 *
 * The behavioural proof for these rules runs against a live PostgreSQL in
 * `evidence-bulk-archive.integration.test.ts` (gated on RUN_LIVE_INTEGRATION).
 * The assertions here run everywhere, with no infrastructure, and pin the
 * shape the Evidence Library depends on: per-record authorization, a refusal
 * that leaves the record untouched, and a reason string the UI can project
 * into an operator-readable category.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  EVIDENCE_BULK_ACTIONS,
  EVIDENCE_BULK_MAX_IDS,
  EvidenceBulkRequestSchema,
} from "@proovra/shared";

const routesSrc = readFileSync(
  fileURLToPath(new URL("../src/routes/evidence.routes.ts", import.meta.url)),
  "utf8",
);

function bulkHandlerRegion(): string {
  const start = routesSrc.indexOf('"/v1/evidence/bulk"');
  expect(start).toBeGreaterThan(-1);
  const rest = routesSrc.slice(start + 1);
  const nextRoute = rest.search(/app\.(get|post|put|patch|delete)\(/);
  return nextRoute === -1 ? rest : rest.slice(0, nextRoute);
}

function caseBlock(region: string, label: string): string {
  const start = region.indexOf(`case "${label}":`);
  expect(start).toBeGreaterThan(-1);
  const rest = region.slice(start + `case "${label}":`.length);
  const next = rest.search(/\n\s*case "|\n\s*default:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("bulk ARCHIVE — request bounds and per-record isolation", () => {
  const region = bulkHandlerRegion();

  it("validates with the SHARED contract, not a restatement of it", () => {
    // The route used to declare its own schema. The browser declared the same
    // request by hand, the two drifted, and `caseId: null` — valid to nobody —
    // was rejected with a 400 before any record was read.
    expect(routesSrc).toContain("const BulkEvidenceActionBody = EvidenceBulkRequestSchema");
    expect(routesSrc).not.toMatch(/const BulkEvidenceActionBody = z\.object\(/);
  });

  it("bounds the batch and de-duplicates the ids before touching anything", () => {
    expect(EVIDENCE_BULK_MAX_IDS).toBe(100);
    const ids = Array.from({ length: EVIDENCE_BULK_MAX_IDS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(
      EvidenceBulkRequestSchema.safeParse({ action: "ARCHIVE", evidenceIds: ids }).success,
    ).toBe(false);
    expect(region).toContain("const uniqueIds = [...new Set(body.evidenceIds)]");
  });

  it("`caseId` is optional and NOT nullable — the exact drift that broke Archive", () => {
    const base = {
      action: "ARCHIVE" as const,
      evidenceIds: ["00000000-0000-4000-8000-000000000001"],
    };
    // What the browser sends now.
    expect(EvidenceBulkRequestSchema.safeParse(base).success).toBe(true);
    // What it used to send.
    const rejected = EvidenceBulkRequestSchema.safeParse({ ...base, caseId: null });
    expect(rejected.success).toBe(false);
    expect(
      rejected.success ? [] : rejected.error.issues.map((i) => `${i.path.join(".")}:${i.code}`),
    ).toEqual(["caseId:invalid_type"]);
    // A real case id is accepted.
    expect(
      EvidenceBulkRequestSchema.safeParse({
        ...base,
        action: "ADD_TO_CASE",
        caseId: "00000000-0000-4000-8000-0000000000aa",
      }).success,
    ).toBe(true);
  });

  it("the action vocabulary is one list, in one casing", () => {
    expect([...EVIDENCE_BULK_ACTIONS]).toContain("ARCHIVE");
    for (const action of EVIDENCE_BULK_ACTIONS) {
      expect(action).toBe(action.toUpperCase());
      // Every action the toolbar can choose is a request the schema accepts.
      expect(
        EvidenceBulkRequestSchema.safeParse({
          action,
          evidenceIds: ["00000000-0000-4000-8000-000000000001"],
          ...(action === "ADD_TO_CASE"
            ? { caseId: "00000000-0000-4000-8000-0000000000aa" }
            : {}),
        }).success,
      ).toBe(true);
    }
  });

  it("authorizes ARCHIVE per record against the persisted tenant", () => {
    expect(region).toMatch(
      /body\.action === "ARCHIVE" \|\| body\.action === "RESTORE_ARCHIVED"[\s\S]{0,200}getEvidenceWithRecordAccess\([\s\S]{0,120}"evidence\.archive"/,
    );
  });

  it("a per-record failure is recorded as a failed row, never as a batch failure", () => {
    expect(region).toMatch(
      /catch \(error\) \{\s*results\.push\(\{\s*evidenceId,\s*ok: false,\s*reason: error instanceof Error \? error\.message/,
    );
    expect(region).toMatch(/successCount: results\.filter\(\(item\) => item\.ok\)\.length/);
    expect(region).toMatch(/failedCount: results\.filter\(\(item\) => !item\.ok\)\.length/);
  });
});

describe("bulk ARCHIVE — an already-archived record is reported, not re-stamped", () => {
  const archive = caseBlock(bulkHandlerRegion(), "ARCHIVE");

  it("skips before the update and answers with a categorisable reason", () => {
    expect(archive).toMatch(
      /if \(evidence\.archivedAt\) \{\s*throw new Error\("ALREADY_ARCHIVED"\);/,
    );
    // The guard must come BEFORE the mutation, or the archive time is already
    // overwritten by the time the record is recognised.
    expect(archive.indexOf("ALREADY_ARCHIVED")).toBeLessThan(
      archive.indexOf("prisma.evidence.update"),
    );
  });

  it("still runs the lock assertion and the canonical destructive gate", () => {
    expect(archive).toContain("assertEvidenceNotLocked");
    expect(archive).toContain("runDestructiveActionGate");
    expect(archive).toContain('action: "archive_evidence"');
  });

  it("archives by stamping archivedAt — it is not a delete", () => {
    expect(archive).toMatch(/data: \{ archivedAt: new Date\(\) \}/);
    expect(archive).not.toMatch(/deletedAt|delete\(/);
    expect(archive).toContain("CustodyEventType.EVIDENCE_ARCHIVED");
  });
});
