/**
 * WS-SHELL remediation — unit regressions for rules that need no database.
 *
 *   PRO-G1Z-03  Disabling an automation rule is a revocation (no terms gate);
 *               enabling one is not.
 *   PRO-E1-05 / PRO-E2-07  A bulk record failure carries a bounded reason.
 *   PRO-P1C-01  The projection's action → permission table equals what each
 *               workflow route enforces.
 *   PRO-PW-05   CORS exposes the support reference and the back-off header.
 *   PRO-G1-01   Only wired automation actions may succeed.
 */
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { AppError, ErrorCode } from "../src/errors.js";
import { legalAcceptanceExemptionFor } from "../src/middleware/legal-acceptance-route-policy.js";
import { isAutomationActionImplemented } from "../src/services/automation/automation-actions.service.js";
import { AUTOMATION_ACTION_CATALOG, AUTOMATION_ACTION_TYPES } from "../src/services/automation/automation.service.js";
import { BULK_OPERATION_FAILED, bulkRefusalReason } from "../src/services/evidence/bulk-refusal-reason.js";
import {
  WORKFLOW_ACTION_KEYS,
  WORKFLOW_ACTION_OPS_PERMISSION,
  projectWorkflowActions,
} from "../src/services/observability/workflow-actions.service.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("PRO-G1Z-03 — rule disable is a revocation", () => {
  it("disable is exempt from the terms gate; enable is not", () => {
    expect(legalAcceptanceExemptionFor("POST", "/v1/automation/rules/:id/disable")).toEqual({ category: "REVOCATION" });
    expect(legalAcceptanceExemptionFor("POST", "/v1/automation/rules/:id/enable")).toBeNull();
  });
});

describe("PRO-E1-05 / PRO-E2-07 — bulk refusal reasons are bounded", () => {
  it("keeps domain refusals (sentences, codes, AppError) and replaces anything else", () => {
    expect(bulkRefusalReason(new Error("Case not found"))).toBe("Case not found");
    expect(bulkRefusalReason(new Error("LEGAL_HOLD_BLOCKED"))).toBe("LEGAL_HOLD_BLOCKED");
    expect(bulkRefusalReason(new Error("case_hold_active"))).toBe("case_hold_active");
    expect(bulkRefusalReason(new AppError(ErrorCode.NOT_FOUND, "Evidence not found"))).toBe("Evidence not found");
    const prismaFault = new Prisma.PrismaClientKnownRequestError(
      "Invalid `prisma.caseEvidenceLink.create()` invocation: Unique constraint failed on the fields: (`case_id`,`evidence_id`)",
      { code: "P2002", clientVersion: "test" },
    );
    expect(bulkRefusalReason(prismaFault)).toBe(BULK_OPERATION_FAILED);
    expect(bulkRefusalReason(new Error("connect ECONNREFUSED 10.0.0.5:5432"))).toBe(BULK_OPERATION_FAILED);
    expect(bulkRefusalReason("a string")).toBe(BULK_OPERATION_FAILED);
  });
});

describe("PRO-P1C-01 — one action → permission table", () => {
  const ops = read("../src/routes/ops.routes.ts");
  for (const action of WORKFLOW_ACTION_KEYS) {
    it(`/v1/ops/workflows/:id/${action} enforces ${WORKFLOW_ACTION_OPS_PERMISSION[action]}`, () => {
      const start = ops.indexOf(`"/v1/ops/workflows/:id/${action}"`);
      expect(start).toBeGreaterThan(-1);
      const gate = /requireOpsCapability\(req, reply, body\.teamId, "(operations\.[a-z]+)"\)/.exec(ops.slice(start));
      expect(gate?.[1]).toBe(WORKFLOW_ACTION_OPS_PERMISSION[action]);
    });
  }

  it("projects each action from its own grant, not one shared flag", () => {
    const grants = Object.fromEntries(WORKFLOW_ACTION_KEYS.map((a) => [a, a !== "assign" && a !== "escalate"])) as never;
    const p = projectWorkflowActions({ workflow: { status: "OPEN", updatedAt: new Date(0) } as never, grants });
    const by = Object.fromEntries(p.actions.map((a) => [a.action, a]));
    expect(by.start!.available).toBe(true);
    expect(by.assign!.reason).toBe("CAPABILITY_REQUIRED");
    expect(by.escalate!.reason).toBe("CAPABILITY_REQUIRED");
    expect(by.reopen!.reason).toBe("NOT_RESOLVED_OR_SUPPRESSED");
    expect(p.canAct).toBe(true);
    expect(new Set(p.actions.map((a) => a.permission))).not.toContain("identity.access_review.action");
  });
});

describe("PRO-PW-05 — CORS exposes the support reference and Retry-After", () => {
  it("lists x-request-id and retry-after in exposedHeaders", () => {
    const server = read("../src/server.ts");
    const block = server.slice(server.indexOf("exposedHeaders: ["), server.indexOf("],", server.indexOf("exposedHeaders: [")));
    expect(block).toContain('"x-request-id"');
    expect(block).toContain('"retry-after"');
  });
});

describe("PRO-G1-01 — automation catalog is truthful", () => {
  it("every action that is not wired is marked recordOnly; the wired one is not", () => {
    for (const type of AUTOMATION_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_CATALOG[type].recordOnly === true, type).toBe(!isAutomationActionImplemented(type));
    }
    expect(isAutomationActionImplemented("WEBHOOK_DELIVERY_INTERNAL_ONLY")).toBe(true);
  });
});
