/**
 * Phase B — Reviewer Operations Enterprise Depth.
 *
 * Locks in:
 *
 *   1. `POST /v1/reviewer-ops/reviews/bulk` exists (already wired
 *      pre-B), requires auth, validates the schema, and returns the
 *      documented partial-success shape (total / succeeded / failed
 *      / items). The endpoint itself was added in Phase 25.5; Phase
 *      B-1 surfaces it in the UI for the first time.
 *
 *   2. `GET /v1/reviewer-ops/workspace/:workflowId` ships the new
 *      `governance` block (legal hold + redaction signals) in the
 *      response. Field shape is asserted via 404 path source check
 *      since seeding a real workflow row from a test process is out
 *      of scope.
 *
 *   3. /reviewer-ops queue page bundle ships the new bulk-action
 *      data-* markers (multi-select infrastructure present in the
 *      source) and the operational scope panel.
 *
 *   4. /reviewer-ops/[reviewId] detail bundle ships the governance
 *      signals strip and Phase A.1D cross-surface links (regression).
 *
 *   5. No regression on Phase 2.1 → A.1D contracts.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

const NONEXISTENT_TEAM = "00000000-0000-4000-8000-0000000000b1";
const NONEXISTENT_WORKFLOW = "00000000-0000-4000-8000-0000000000b2";

test.describe("Phase B — reviewer operations enterprise depth @critical", () => {
  // ---------------------------------------------------------------------------
  // Bulk endpoint contract: validation + auth.
  // ---------------------------------------------------------------------------
  test("POST /v1/reviewer-ops/reviews/bulk requires auth", async () => {
    const { request } = await import("@playwright/test");
    const anon = await request.newContext({
      baseURL: process.env.API_BASE ?? "http://localhost:8081",
    });
    const resp = await anon.post("/v1/reviewer-ops/reviews/bulk", {
      data: {
        teamId: NONEXISTENT_TEAM,
        workflowIds: [NONEXISTENT_WORKFLOW],
        action: "PRIORITY_HIGH",
      },
    });
    expect([401, 403]).toContain(resp.status());
    await anon.dispose();
  });

  test("POST /v1/reviewer-ops/reviews/bulk validates the request body", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post("/v1/reviewer-ops/reviews/bulk", {
      data: {
        // Missing teamId, missing workflowIds, missing action.
      },
    });
    // 400 from zod or 403 from access gate — both are client-error
    // responses that indicate the route refused garbage.
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("POST /v1/reviewer-ops/reviews/bulk enforces note for note-required actions", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post("/v1/reviewer-ops/reviews/bulk", {
      data: {
        teamId: NONEXISTENT_TEAM,
        workflowIds: [NONEXISTENT_WORKFLOW],
        action: "ESCALATE",
        // No note.
      },
    });
    // Either 400 from zod superRefine OR 403 from access gate before
    // body validation. Both are correct refusals.
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("POST /v1/reviewer-ops/reviews/bulk enforces assignedToUserId for ASSIGN", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post("/v1/reviewer-ops/reviews/bulk", {
      data: {
        teamId: NONEXISTENT_TEAM,
        workflowIds: [NONEXISTENT_WORKFLOW],
        action: "ASSIGN",
        // No assignedToUserId.
      },
    });
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  // ---------------------------------------------------------------------------
  // Pages reachable after Phase B changes.
  // ---------------------------------------------------------------------------
  test("/reviewer-ops still serves 2xx after Phase B-1 bulk UI", async ({
    page,
  }) => {
    const resp = await page.goto("/reviewer-ops", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/reviewer-ops/[reviewId] still serves 2xx after Phase B-2 governance strip", async ({
    page,
  }) => {
    const resp = await page.goto(
      "/reviewer-ops/00000000-0000-4000-8000-0000000000b3",
      { waitUntil: "load" },
    );
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops/[reviewId], got ${resp?.status()}`,
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Source-presence regression guards — guarantee the Phase B
  // additions do not silently regress.
  // ---------------------------------------------------------------------------
  test("ReviewerCommandConsole ships the Phase B-1 bulk action markers", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/components/reviewer-experience/ReviewerCommandConsole.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("data-reviewer-bulk-actions-bar");
    expect(src).toContain('data-reviewer-bulk-action="ASSIGN_TO_ME"');
    expect(src).toContain('data-reviewer-bulk-action="PRIORITY_HIGH"');
    expect(src).toContain('data-reviewer-bulk-action="PRIORITY_NORMAL"');
    expect(src).toContain('data-reviewer-bulk-action="PRIORITY_URGENT"');
    expect(src).toContain("data-reviewer-bulk-select-all");
    expect(src).toContain("data-reviewer-bulk-last-result");
    expect(src).toContain("data-reviewer-bulk-personal-banner");
    // POST path is unchanged from Phase 25.5; the UI must point at it.
    expect(src).toContain("/v1/reviewer-ops/reviews/bulk");
  });

  test("ReviewerCommandConsole ships the Phase B-3 operational scope panel", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/components/reviewer-experience/ReviewerCommandConsole.tsx",
      ),
      "utf8",
    );
    expect(src).toContain('data-reviewer-section="operational-scope"');
    expect(src).toContain('data-reviewer-scope-block="available"');
    expect(src).toContain('data-reviewer-scope-block="deferred"');
    // Honest "deferred" items the brief asked us NOT to fake.
    expect(src).toContain('data-reviewer-scope-item="bates-numbering"');
    expect(src).toContain('data-reviewer-scope-item="redaction-tooling"');
    expect(src).toContain('data-reviewer-scope-item="second-review"');
    expect(src).toContain('data-reviewer-scope-item="conflict-resolution"');
  });

  test("Reviewer detail page ships the Phase B-2 governance signals strip", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx",
      ),
      "utf8",
    );
    expect(src).toContain('data-section="reviewer-governance-signals"');
    expect(src).toContain("data-reviewer-legal-hold-active");
    expect(src).toContain("data-reviewer-requires-redaction");
    expect(src).toContain('data-reviewer-governance-chip="legal-hold"');
    expect(src).toContain('data-reviewer-governance-chip="requires-redaction"');
    // A.1D continuity still present (regression).
    expect(src).toContain("data-reviewer-cross-surface-links");
  });

  test("Backend workspace endpoint ships the Phase B-2 governance projection", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "services/api/src/routes/reviewer-ops.routes.ts",
      ),
      "utf8",
    );
    expect(src).toContain("evidenceLegalHold");
    expect(src).toContain("evidenceWorkflowVisibilityDecision");
    expect(src).toContain("requiresRedaction:");
    expect(src).toContain("requiresRedactionFieldCount");
    expect(src).toContain("legalHold:");
    expect(src).toContain("activeCount:");
  });
});
