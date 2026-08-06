/**
 * PHASE 12 POINT 4 PASS C1 — ONE writer for decision-derived review status.
 *
 * `EvidenceReviewWorkflow.status` is a PROJECTION. For the three verdict
 * values (APPROVED_INTERNAL / REJECTED_INSUFFICIENT / NEEDS_INFO) it means
 * "the immutable decision log resolved to this outcome", and only
 * `recordReviewDecision` may produce it — appending the decision row and
 * deriving the status in the same transaction.
 *
 * The competing writer this closes: `PATCH /v1/evidence/:id/reviewer-workflow`
 * → `upsertEvidenceReviewerWorkflow` accepted a client-chosen status and wrote
 * it straight onto the row. A reviewer could mark a record APPROVED_INTERNAL
 * with no decision appended, no second-review or adjudication rule applied,
 * and no terminal/stale check — leaving a workflow whose status contradicted
 * its own decision history. The browser, not the server, held the verdict.
 *
 * Only Prisma is faked here, and the fake RECORDS writes so a refusal can be
 * shown to mutate nothing.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DECISION_DERIVED_WORKFLOW_STATUSES } from "../src/services/evidence-review/review-status-vocabulary.js";

const writes: string[] = [];

vi.mock("../src/db.js", () => ({
  prisma: {
    evidenceReviewWorkflow: {
      findUnique: async () => ({
        id: "wf-1",
        evidenceId: "ev-1",
        workspaceType: "TEAM",
        teamId: "team-1",
        status: "IN_REVIEW",
        priority: "NORMAL",
        dueAt: null,
        lastReviewedAt: null,
        closedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        assignedTo: null,
        assignedBy: null,
        assignedToUserId: null,
        assignedByUserId: null,
        templateSlug: null,
        templateVersion: null,
        templateDbId: null,
      }),
      update: async () => {
        writes.push("workflow.update");
        return {
          id: "wf-1",
          evidenceId: "ev-1",
          workspaceType: "TEAM",
          teamId: "team-1",
          status: "IN_REVIEW",
          priority: "NORMAL",
          dueAt: null,
          lastReviewedAt: null,
          closedAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          assignedTo: null,
          assignedBy: null,
        };
      },
      create: async () => {
        writes.push("workflow.create");
        return { id: "wf-1" };
      },
    },
    evidenceReviewWorkflowEvent: {
      create: async () => {
        writes.push("event.create");
        return { id: "ev-1" };
      },
    },
    $transaction: async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : (ops as () => unknown)(),
  },
}));

// The audit sink is an external boundary too — record, never assert on it.
vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async () => undefined,
}));

const { upsertEvidenceReviewerWorkflow } = await import(
  "../src/services/evidence-review/reviewer-workflow.service.js"
);

const upsert = (status: string) =>
  upsertEvidenceReviewerWorkflow({
    evidenceId: "ev-1",
    workspaceType: "TEAM",
    teamId: "team-1",
    actorUserId: "user-1",
    status: status as never,
  });

beforeEach(() => {
  writes.length = 0;
});

describe("Phase 12 Point 4 — the administrative writer cannot assign a verdict", () => {
  for (const status of DECISION_DERIVED_WORKFLOW_STATUSES) {
    it(`refuses ${status} and mutates NOTHING`, async () => {
      await expect(upsert(status)).rejects.toMatchObject({
        code: "INVALID_STATE_TRANSITION",
      });
      expect(writes).toEqual([]);
    });
  }

  it("still performs ROUTING transitions — this is not a freeze", async () => {
    await expect(upsert("IN_REVIEW")).resolves.toMatchObject({
      available: true,
    });
    expect(writes).toContain("workflow.update");
  });

  it("the derived-status set matches the verdicts the decision authority projects", () => {
    expect([...DECISION_DERIVED_WORKFLOW_STATUSES].sort()).toEqual([
      "APPROVED_INTERNAL",
      "NEEDS_INFO",
      "REJECTED_INSUFFICIENT",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Repo-wide guard — no second writer may reappear.
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const CANONICAL = join(
  SRC_ROOT,
  "services",
  "reviewer-ops",
  "review-decision.service.ts",
);

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, acc);
    else if (full.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("authority guard — ONE writer of a decision-derived status", () => {
  it("no service outside the canonical authority assigns a verdict status to a workflow row", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      if (file === CANONICAL) continue;
      const src = readFileSync(file, "utf8");
      // Look at every workflow write and ask whether its data block names a
      // verdict status. Comments are stripped so documentation is not a use.
      const code = src
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      const writeBlocks = code.match(
        /evidenceReviewWorkflow\s*\.\s*(update|updateMany|upsert|create)\s*\(\s*\{[\s\S]{0,900}?\}\s*\)/g,
      );
      if (!writeBlocks) continue;
      for (const block of writeBlocks) {
        for (const status of DECISION_DERIVED_WORKFLOW_STATUSES) {
          if (new RegExp(`status\\s*:\\s*["'\`]${status}["'\`]`).test(block)) {
            offenders.push(`${file} → ${status}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the reviewer-workflow PATCH route refuses verdict statuses at the edge", () => {
    const routes = readFileSync(join(SRC_ROOT, "routes", "evidence.routes.ts"), "utf8");
    // The accepted status set is DERIVED by excluding verdicts, so a new
    // verdict added to the enum is excluded automatically.
    expect(routes).toMatch(/isDecisionDerivedWorkflowStatus/);
    expect(routes).not.toMatch(
      /status:\s*z\.nativeEnum\(prismaPkg\.EvidenceReviewWorkflowStatus\)/,
    );
  });
});
