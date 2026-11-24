/**
 * THE GATE CANNOT BE FORGOTTEN (WORKFLOW-001, WORKFLOW-003, WORKFLOW-004).
 *
 * Two generations of findings were one route that missed a check another route
 * had. These read the route files and fail when a new handler names a workflow
 * without the reach guard, or a mutating handler skips the capability check.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { classifyReviewBulkRequest } from "@proovra/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8").replace(/\r\n/g, "\n");

const CONSOLE = read("../src/routes/reviewer-ops.routes.ts");
const LEGACY = read("../src/routes/review-operations.routes.ts");
const WORKSPACE = read("../src/routes/reviewer-workspace.routes.ts");
const GATE = read("../src/services/reviewer-ops/review-action-gate.ts");

function handlers(source: string): Array<{ method: string; path: string; body: string }> {
  const out: Array<{ method: string; path: string; body: string }> = [];
  const re = /\n {2}app\.(get|post|patch|delete|put)\(\n\s*"([^"]+)"/g;
  const starts = [...source.matchAll(re)];
  starts.forEach((m, i) => {
    const end = starts[i + 1]?.index ?? source.length;
    out.push({ method: m[1]!, path: m[2]!, body: source.slice(m.index, end) });
  });
  return out;
}

describe("review doors", () => {
  it("every console handler naming a workflow asks for reach", () => {
    const named = handlers(CONSOLE).filter((h) => h.path.includes(":workflowId"));
    expect(named.length).toBeGreaterThanOrEqual(12);
    for (const h of named) {
      expect(h.body, `${h.method} ${h.path}`).toMatch(/requireWorkflowInReach\(ctx, reply, workflowId/);
    }
  });

  it("every console handler that writes under a workflow checks the review permission", () => {
    const writes = handlers(CONSOLE).filter((h) => h.path.includes(":workflowId") && h.method !== "get");
    for (const h of writes) {
      expect(h.body, `${h.method} ${h.path}`).toMatch(/requireReviewerCapable\(ctx, reply\)/);
    }
  });

  it("every workspace handler naming a workflow asks for reach", () => {
    const named = handlers(WORKSPACE).filter((h) => h.path.includes(":workflowId"));
    expect(named.length).toBeGreaterThanOrEqual(4);
    for (const h of named) {
      expect(h.body, `${h.method} ${h.path}`).toMatch(/workflowOpenToCaller\(ctx, workflowId\)/);
    }
  });

  it("the verdict doors share one gate", () => {
    for (const path of [
      "/v1/reviewer-ops/reviews/:workflowId/approve",
      "/v1/reviewer-ops/reviews/:workflowId/reject",
      "/v1/reviewer-ops/workspace/:workflowId/decisions",
    ]) {
      const h = handlers(CONSOLE).find((x) => x.path === path && x.method === "post");
      expect(h?.body, path).toMatch(/enforceReviewActionGate\(req, reply,/);
    }
    const legacy = handlers(LEGACY).find((x) => x.path.endsWith("/decision"));
    expect(legacy?.body).toMatch(/enforceReviewActionGate\(req, reply,/);
  });

  it("every bulk door has the same gate", () => {
    // T-030 / T-036 (stage B) — every bulk door hands its request to the ONE
    // bulk-door gate, which classifies it by the shared
    // `classifyReviewBulkRequest`: bulk decisions stay gated as "bulk",
    // assignment is not a step-up action (direction 7), a single archive uses
    // the archive gate. No door calls the gate with its own literal.
    expect(handlers(CONSOLE).find((x) => x.path === "/v1/reviewer-ops/reviews/bulk")?.body).toMatch(
      /enforceReviewBulkDoorGate\(req, reply, \{[\s\S]{0,200}action: body\.action,/,
    );
    expect(handlers(LEGACY).find((x) => x.path === "/v1/review-operations/bulk")?.body).toMatch(
      /enforceReviewBulkDoorGate\(req, reply, \{[\s\S]{0,200}action: body\.action,/,
    );
    for (const [path, action] of [
      ["/v1/reviewer/bulk/assign", "ASSIGN"],
      ["/v1/reviewer/bulk/decide", "DECIDE"],
      ["/v1/reviewer/bulk/code", "CODE"],
    ] as const) {
      expect(handlers(WORKSPACE).find((x) => x.path === path)?.body, path).toMatch(
        new RegExp(`bulkGate\\(req, reply, ctx, body\\.workflowIds, "${action}"\\)`),
      );
    }
    expect(WORKSPACE).toMatch(/async function bulkGate\([\s\S]{0,600}enforceReviewBulkDoorGate\(req, reply, \{/);
    // The gate itself: the shared classification decides; a non-assignment
    // goes through the canonical action gate with that classification.
    expect(GATE).toMatch(/const classification = classifyReviewBulkRequest\(\{/);
    expect(GATE).toMatch(/enforceReviewActionGate\(req, reply, \{[\s\S]{0,120}action: classification,/);

    // The classification, behaviourally.
    for (const action of ["DECIDE", "APPROVE", "REJECT", "CODE", "ESCALATE"]) {
      expect(classifyReviewBulkRequest({ action, itemCount: 5 }), action).toBe("bulk");
    }
    expect(classifyReviewBulkRequest({ action: "CLOSE", itemCount: 5, scope: "bulk" })).toBe("bulk");
    expect(classifyReviewBulkRequest({ action: "CLOSE", itemCount: 2, scope: "single" })).toBe("bulk");
    expect(classifyReviewBulkRequest({ action: "CLOSE", itemCount: 1, scope: "single" })).toBe("archive");
    expect(classifyReviewBulkRequest({ action: "ASSIGN", itemCount: 5 })).toBe("assignment");
    expect(classifyReviewBulkRequest({ action: "reassign", itemCount: 1 })).toBe("assignment");
  });

  it("no route gates a review action through a private copy of the flags or the adaptive check", () => {
    for (const source of [CONSOLE, LEGACY, WORKSPACE]) {
      expect(source).not.toMatch(/runtimeAdaptiveGate\(/);
      expect(source).not.toMatch(/enforceStepUpIfFlagged/);
    }
  });
});
