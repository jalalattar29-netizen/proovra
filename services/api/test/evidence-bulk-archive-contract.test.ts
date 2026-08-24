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

// `caseBlock` sliced ONE `case "X":` block out of the bulk switch, because each
// lifecycle action had its own body to inspect. The four now share a single
// body that dispatches to the canonical service, so there is no per-action block
// left to slice — which is the property this file asserts rather than a detail
// it works around.

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

  it("an action that targets a case must name one", () => {
    // The contract, not only the route's runtime guard: `ADD_TO_CASE` with no
    // target used to pass validation and be caught later by a hand-written
    // check inside the handler.
    const withoutCase = EvidenceBulkRequestSchema.safeParse({
      action: "ADD_TO_CASE",
      evidenceIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(withoutCase.success).toBe(false);
    expect(
      withoutCase.success ? [] : withoutCase.error.issues.map((i) => i.path.join(".")),
    ).toEqual(["caseId"]);
    // The route keeps its own guard as defence in depth.
    expect(region).toContain('caseId is required for ADD_TO_CASE');
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
    // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the per-record capability
    // resolution moved INTO `applyEvidenceLifecycleAction`, which the single
    // routes call too. Resolving it here as well would mean two places could
    // answer differently, which is precisely the drift that let bulk
    // RESTORE_TRASH require `evidence.delete` while single restore required
    // only creator identity.
    expect(region).toContain("applyEvidenceLifecycleAction");
    expect(region).toContain("action: BULK_LIFECYCLE_ACTION[body.action]");

    const service = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/evidence/evidence-lifecycle.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(service).toContain('ARCHIVE: "evidence.archive"');
    expect(service).toContain('UNARCHIVE: "evidence.archive"');
    // Against the PERSISTED row, never a client-supplied workspace.
    expect(service).toMatch(
      /resolveEvidenceDestructiveAccess\(\s*\{\s*userId: input\.actorUserId,\s*evidenceId: input\.evidenceId,/,
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
  const service = readFileSync(
    fileURLToPath(
      new URL(
        "../src/services/evidence/evidence-lifecycle.service.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("answers before the update, so the original archive time is never overwritten", () => {
    // The guarantee is unchanged; where it lives is not. The bulk branch used
    // to throw "ALREADY_ARCHIVED" and the single route returned 200 for the
    // same situation — two answers to one question. The canonical service
    // resolves it ONCE, and in favour of the idempotent reading: a record
    // already where the caller wants it is a success with nothing to do,
    // reported honestly as `changed: false`.
    expect(service).toMatch(
      /const already =[\s\S]{0,120}?input\.action === "ARCHIVE" && caps\.productState === "ARCHIVED"/,
    );
    // …and it returns BEFORE the write, which is what protects the timestamp.
    expect(service.indexOf("const already =")).toBeLessThan(
      service.indexOf("const patch = buildLifecyclePatch("),
    );
    expect(service).toMatch(
      /if \(already\) \{\s*return \{\s*ok: true,\s*changed: false,/,
    );
  });

  it("still runs the lock check and the canonical destructive gate", () => {
    // Both survive — as ONE invocation covering single and bulk, rather than
    // one copy per branch.
    expect(service).toContain("runDestructiveActionGate");
    expect(service).toContain('"archive_evidence"');
    // The lock is no longer a hand-rolled assert: it is part of the canonical
    // capability projection, which is what the whole convergence is for.
    expect(service).toContain("computeEvidenceLifecycleCapabilities");
    expect(service).toContain("caps.canArchive");
  });

  it("archives by writing the ARCHIVED state and its event timestamp — it is not a delete", () => {
    const patch = service.slice(service.indexOf('case "ARCHIVE":'));
    expect(patch).toContain(
      'data: { lifecycleState: "ARCHIVED", archivedAt: now }',
    );
    expect(patch).toContain("CustodyEventType.EVIDENCE_ARCHIVED");
    // The state pointer and the event timestamp are written TOGETHER — writing
    // one without the other is what let the two disagree.
    const archiveCase = patch.slice(0, patch.indexOf('case "UNARCHIVE":'));
    expect(archiveCase).not.toContain("deletedAt");
    expect(archiveCase).not.toContain(".delete(");
  });
});
