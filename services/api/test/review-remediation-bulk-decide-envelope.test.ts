/**
 * Review remediation 2026-11-27 — F-37 (BEHAVIOUR-SPEC §8).
 *
 * `bulkDecide` ("Set assessment tag" in the Inbox) and `bulkCode` write a
 * coded value only. Their envelope:
 *   - `ok: false` when nothing was written (never a success for an
 *     all-failed batch);
 *   - `recordsDecision: false`;
 *   - `{total, succeeded, failed, items[{workflowId, ok, errorCode, message}]}`;
 *   - `httpStatus` 200 only when every item was written, else 207.
 *
 * Prisma is an injected fake; the coded-value writer is stubbed so the suite
 * tests this module's envelope, not the writer (covered by its own suites
 * and the D52 integration test).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const writes: Array<{ workflowId: string }> = [];
vi.mock("../src/services/reviewer-workspace/coding-value.service.js", () => ({
  writeCodingValue: async (input: { workflowId: string }) => {
    writes.push({ workflowId: input.workflowId });
    return input.workflowId.endsWith("refused") ? { ok: false, denial: "NOT_PERMITTED" } : { ok: true };
  },
}));

import {
  bulkCode,
  bulkDecide,
  codingEnvelope,
  isBulkRefusal,
} from "../src/services/reviewer-workspace/bulk-operations.service.js";

const TEAM = "team-1";

function fakePrisma(workflows: Record<string, { codingSchemaId: string | null } | null>, hasField = true) {
  return {
    evidenceReviewWorkflow: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        const w = workflows[where.id];
        return w ? { id: where.id, codingSchemaId: w.codingSchemaId } : null;
      },
    },
    codingField: {
      findFirst: async () => (hasField ? { id: "field-1" } : null),
    },
    workflowReviewDecision: {
      create: async () => {
        throw new Error("bulkDecide must never write a WorkflowReviewDecision");
      },
    },
  } as never;
}

beforeEach(() => {
  writes.length = 0;
});

describe("F-37 bulkDecide envelope", () => {
  it("all written → ok, 200, recordsDecision false, items all ok", async () => {
    const res = await bulkDecide({
      prisma: fakePrisma({ a: { codingSchemaId: "s" }, b: { codingSchemaId: "s" } }),
      teamId: TEAM,
      actorUserId: "u",
      verdict: "APPROVE",
      workflowIds: ["a", "b"],
    });
    expect(isBulkRefusal(res)).toBe(false);
    if (isBulkRefusal(res)) return;
    expect(res).toMatchObject({ ok: true, total: 2, succeeded: 2, failed: 0, recordsDecision: false, httpStatus: 200 });
    expect(res.items).toEqual([
      { workflowId: "a", ok: true },
      { workflowId: "b", ok: true },
    ]);
  });

  it("partial → ok true, 207, failed items carry a code and a readable message", async () => {
    const res = await bulkDecide({
      prisma: fakePrisma({ a: { codingSchemaId: "s" }, nos: { codingSchemaId: null } }),
      teamId: TEAM,
      actorUserId: "u",
      verdict: "REJECT",
      workflowIds: ["a", "nos", "missing"],
    });
    if (isBulkRefusal(res)) throw new Error("unexpected refusal");
    expect(res).toMatchObject({ ok: true, total: 3, succeeded: 1, failed: 2, httpStatus: 207, recordsDecision: false });
    expect(res.items[1]).toEqual({
      workflowId: "nos",
      ok: false,
      errorCode: "SCHEMA_NOT_FOUND",
      message: "No coding schema is bound to this review.",
    });
    expect(res.items[2]).toMatchObject({ workflowId: "missing", ok: false, errorCode: "WORKFLOW_NOT_FOUND" });
  });

  it("all failed → ok FALSE, 207 — never reported as success", async () => {
    const res = await bulkDecide({
      prisma: fakePrisma({ x: { codingSchemaId: "s" } }, false),
      teamId: TEAM,
      actorUserId: "u",
      verdict: "ESCALATE",
      workflowIds: ["x", "y-refused"],
    });
    if (isBulkRefusal(res)) throw new Error("unexpected refusal");
    expect(res.ok).toBe(false);
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(2);
    expect(res.httpStatus).toBe(207);
    expect(res.recordsDecision).toBe(false);
    expect(writes).toEqual([]);
  });

  it("over the cap is a whole-call refusal", async () => {
    const res = await bulkDecide({
      prisma: fakePrisma({}),
      teamId: TEAM,
      actorUserId: "u",
      verdict: "APPROVE",
      workflowIds: Array.from({ length: 101 }, (_, i) => `w${i}`),
    });
    expect(isBulkRefusal(res)).toBe(true);
  });

  it("the module never writes a WorkflowReviewDecision (coding only)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/services/reviewer-workspace/bulk-operations.service.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/workflowReviewDecision\s*\.\s*(create|update|upsert|createMany)/);
  });
});

describe("F-37 bulkCode shares the envelope", () => {
  it("a writer refusal is a failed item; all failed → ok false", async () => {
    const res = await bulkCode({
      prisma: fakePrisma({ "a-refused": { codingSchemaId: "s" } }),
      teamId: TEAM,
      actorUserId: "u",
      fieldSlug: "estimate",
      value: { number: 1 },
      workflowIds: ["a-refused"],
    });
    if (isBulkRefusal(res)) throw new Error("unexpected refusal");
    expect(res).toMatchObject({ ok: false, succeeded: 0, failed: 1, httpStatus: 207, recordsDecision: false });
    expect(res.items[0]).toMatchObject({ ok: false, errorCode: "NOT_PERMITTED" });
  });

  it("an empty selection is an ok, 200 envelope", () => {
    expect(codingEnvelope([])).toMatchObject({ ok: true, total: 0, failed: 0, httpStatus: 200 });
  });
});
