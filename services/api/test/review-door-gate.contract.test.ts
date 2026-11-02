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

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8").replace(/\r\n/g, "\n");

const CONSOLE = read("../src/routes/reviewer-ops.routes.ts");
const LEGACY = read("../src/routes/review-operations.routes.ts");
const WORKSPACE = read("../src/routes/reviewer-workspace.routes.ts");

function handlers(source: string): Array<{ method: string; path: string; body: string }> {
  const out: Array<{ method: string; path: string; body: string }> = [];
  const re = /\n  app\.(get|post|patch|delete|put)\(\n\s*"([^"]+)"/g;
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
    expect(handlers(CONSOLE).find((x) => x.path === "/v1/reviewer-ops/reviews/bulk")?.body).toMatch(
      /action: "bulk"/,
    );
    expect(handlers(LEGACY).find((x) => x.path === "/v1/review-operations/bulk")?.body).toMatch(/action: "bulk"/);
    for (const path of ["/v1/reviewer/bulk/assign", "/v1/reviewer/bulk/decide", "/v1/reviewer/bulk/code"]) {
      expect(handlers(WORKSPACE).find((x) => x.path === path)?.body, path).toMatch(/bulkGate\(req, reply, ctx/);
    }
  });

  it("no route gates a review action through a private copy of the flags or the adaptive check", () => {
    for (const source of [CONSOLE, LEGACY, WORKSPACE]) {
      expect(source).not.toMatch(/runtimeAdaptiveGate\(/);
      expect(source).not.toMatch(/enforceStepUpIfFlagged/);
    }
  });
});
