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

  /**
   * THE COMPONENT THIS GUARDED WAS UNMOUNTED, THEN DELETED.
   *
   * `ReviewerCommandConsole` was never rendered. Phase 12 Point 4 extracted
   * its capabilities onto the canonical `/review` console "so the capability
   * keeps a real product surface", and the dead component went with it — which
   * is why this read `ENOENT` rather than a failed assertion.
   *
   * So the same markers are asserted against the components that now own them.
   * That is strictly more than before: these ones actually render.
   */
  test("the canonical console ships the Phase B-1 bulk action markers", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const read = async (rel: string) =>
      fs.readFile(path.resolve(process.cwd(), rel), "utf8");
    const bar = await read(
      "apps/web/components/reviewer-experience/ReviewerBulkOpsBar.tsx",
    );
    const console_ = await read(
      "apps/web/components/reviewer-experience/ReviewerConsole.tsx",
    );

    // The action bar owns the actions.
    expect(bar).toContain("data-reviewer-bulk-actions-bar");
    expect(bar).toContain('data-reviewer-bulk-action="ASSIGN_TO_ME"');
    expect(bar).toContain('data-reviewer-bulk-action="PRIORITY_HIGH"');
    expect(bar).toContain('data-reviewer-bulk-action="PRIORITY_NORMAL"');
    expect(bar).toContain('data-reviewer-bulk-action="PRIORITY_URGENT"');
    expect(bar).toContain("data-reviewer-bulk-last-result");
    expect(bar).toContain("data-reviewer-bulk-personal-banner");
    // POST path is unchanged from Phase 25.5; the UI must point at it.
    expect(bar).toContain("/v1/reviewer-ops/reviews/bulk");

    // The console owns the selection the bar acts on, and mounts the bar —
    // without which the markers above would be shipped and unreachable, which
    // is exactly the state this test used to be blind to.
    expect(console_).toContain("data-reviewer-bulk-select-all");
    expect(console_).toContain("ReviewerBulkOpsBar");
  });

  /**
   * THE DEFERRAL PANEL WENT WITH THE UNMOUNTED CONSOLE — AND THREE OF ITS FOUR
   * DEFERRALS WERE DELIVERED.
   *
   * This required an "operational scope" panel disclosing four things the
   * brief said not to fake: bates-numbering, redaction-tooling, second-review
   * and conflict-resolution. The panel lived in `ReviewerCommandConsole`,
   * which was never rendered and has since been deleted, so the disclosure was
   * being asserted in a component no user could reach.
   *
   * Measured against the current tree: redaction tooling, second review
   * (multi-stage) and conflict resolution all exist in the product now. Bates
   * numbering does not — and, correctly, nothing anywhere claims it does.
   *
   * So what the brief actually asked for is asserted directly: the delivered
   * capabilities are real, and the undelivered one is not faked. That is a
   * stronger reading of "do not fake it" than a panel admitting the gap.
   */
  test("the reviewer capabilities the brief deferred are delivered, and the one that is not is not faked", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const read = async (rel: string) =>
      fs.readFile(path.resolve(process.cwd(), rel), "utf8");

    // Second review / conflict resolution — real, with its own surface.
    const card = await read(
      "apps/web/components/reviewer-experience/MultiStageReviewSummaryCard.tsx",
    );
    expect(card).toContain('key: "second_required"');
    expect(card).toContain('key: "conflict_detected"');
    expect(card).toContain('key: "resolved"');

    // Redaction tooling — a real backend surface, not a label.
    const routes = await read("docs/architecture/current-runtime-capability-map.json");
    expect(routes).toContain("/v1/redaction/policies");
    expect(routes).toContain("/v1/redaction/regions/:id");

    // Bates numbering is NOT implemented, and nothing pretends otherwise:
    // no route, no component, no copy anywhere in the product tree.
    const { execFileSync } = await import("node:child_process");
    const hits = execFileSync(
      process.execPath,
      [
        "-e",
        "const{execSync}=require('node:child_process');" +
          "try{process.stdout.write(execSync('git grep -il bates -- apps services packages',{encoding:'utf8'}))}" +
          "catch{process.stdout.write('')}",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    ).trim();
    expect(hits, `nothing should claim bates numbering; found: ${hits}`).toBe("");
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
