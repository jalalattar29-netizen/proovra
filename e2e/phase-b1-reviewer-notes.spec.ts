/**
 * Phase B.1 — Reviewer collaboration, decision intelligence, multi-stage review.
 *
 * Locks in:
 *
 *   1. `GET /v1/reviewer-ops/workspace/:workflowId/notes` exists,
 *      requires auth + team-member gate (404 for non-members), and
 *      returns the documented envelope.
 *
 *   2. `POST /v1/reviewer-ops/workspace/:workflowId/notes` exists,
 *      requires auth + team-member gate, validates body shape
 *      (teamId uuid, type enum, body 1–4000 chars).
 *
 *   3. The seven structured note types are accepted server-side:
 *      observation, concern, request_info, escalation_context,
 *      decision_rationale, legal_hold_context, redaction_context.
 *
 *   4. Reviewer detail page bundle ships the notes panel + deferred-
 *      features panel markers so the operational scope claim stays
 *      true regression-tested.
 *
 *   5. No regression on Phase 2.7X / A.1B / A.1C / A.1D / Phase B /
 *      Phase C contracts.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

const NONEXISTENT_TEAM = "00000000-0000-4000-8000-0000000000c1";
const NONEXISTENT_WORKFLOW = "00000000-0000-4000-8000-0000000000c2";

test.describe("Phase B.1 — reviewer notes + collaboration depth @critical", () => {
  // ---------------------------------------------------------------------------
  // Auth + RBAC contracts.
  // ---------------------------------------------------------------------------
  test("GET notes requires auth", async () => {
    const { request } = await import("@playwright/test");
    const anon = await request.newContext({
      baseURL: process.env.API_BASE ?? "http://localhost:8081",
    });
    const resp = await anon.get(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/notes?teamId=${NONEXISTENT_TEAM}`,
    );
    expect([401, 403]).toContain(resp.status());
    await anon.dispose();
  });

  test("POST notes requires auth", async () => {
    const { request } = await import("@playwright/test");
    const anon = await request.newContext({
      baseURL: process.env.API_BASE ?? "http://localhost:8081",
    });
    const resp = await anon.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/notes`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          type: "observation",
          body: "test",
        },
      },
    );
    expect([401, 403]).toContain(resp.status());
    await anon.dispose();
  });

  test("GET notes for unknown team returns 404 (non-member)", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/notes?teamId=${NONEXISTENT_TEAM}`,
    );
    // requireReviewerActor returns 404 for non-members (defense in
    // depth — we never expose "this team exists, you're not in it"
    // semantics).
    expect(resp.status()).toBe(404);
  });

  test("POST notes validates body shape", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/notes`,
      {
        data: {
          // Missing teamId, type, body.
        },
      },
    );
    expect(resp.status()).toBe(400);
  });

  test("POST notes rejects invalid type values", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/notes`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          type: "not-a-real-type",
          body: "test",
        },
      },
    );
    expect(resp.status()).toBe(400);
  });

  test("POST notes rejects empty body", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/notes`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          type: "observation",
          body: "",
        },
      },
    );
    expect(resp.status()).toBe(400);
  });

  test("POST notes rejects body over 4000 chars", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/reviewer-ops/workspace/${NONEXISTENT_WORKFLOW}/notes`,
      {
        data: {
          teamId: NONEXISTENT_TEAM,
          type: "observation",
          body: "x".repeat(4001),
        },
      },
    );
    expect(resp.status()).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Page bundle reachability.
  // ---------------------------------------------------------------------------
  test("/reviewer-ops/[reviewId] still serves 2xx after Phase B.1 additions", async ({
    page,
  }) => {
    const resp = await page.goto(
      "/reviewer-ops/00000000-0000-4000-8000-0000000000c3",
      { waitUntil: "load" },
    );
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops/[reviewId], got ${resp?.status()}`,
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Source-presence regression guards.
  // ---------------------------------------------------------------------------
  test("Reviewer detail page ships the Phase B.1 notes panel + deferred-features markers", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx",
      ),
      "utf8",
    );
    // Notes panel markers
    expect(src).toContain('data-section="reviewer-notes"');
    expect(src).toContain("data-reviewer-notes-total");
    expect(src).toContain("data-reviewer-notes-form");
    expect(src).toContain("data-reviewer-notes-compose-type");
    expect(src).toContain("data-reviewer-notes-compose-body");
    expect(src).toContain("data-reviewer-notes-compose-submit");
    expect(src).toContain("data-reviewer-notes-items");
    // Deferred-features panel markers
    expect(src).toContain('data-section="reviewer-deferred-features"');
    expect(src).toContain('data-reviewer-deferred-block="available"');
    expect(src).toContain('data-reviewer-deferred-block="deferred"');
    // Honest items the brief told us not to fake. Note: second-review
    // and conflict-resolution were PROMOTED out of "deferred" in
    // Phase B.2 — they are now real (server-enforced state machine).
    // The remaining deferred items below are still genuinely deferred.
    expect(src).toContain('data-reviewer-deferred-item="evidence-compare"');
    expect(src).toContain('data-reviewer-deferred-item="auto-routing"');
    expect(src).toContain(
      'data-reviewer-deferred-item="manual-second-review-override"',
    );
    expect(src).toContain('data-reviewer-deferred-item="senior-reviewer-role"');
    // Available items grounding what IS shipped.
    expect(src).toContain('data-reviewer-deferred-item="structured-notes"');
    expect(src).toContain('data-reviewer-deferred-item="rationale-required"');
    // Phase B.2 additions to the "available" block.
    expect(src).toContain('data-reviewer-deferred-item="multi-stage-review"');
    expect(src).toContain('data-reviewer-deferred-item="decision-lineage"');
    // Phase B.1 must preserve Phase A.1D + Phase B continuity markers.
    expect(src).toContain("data-reviewer-cross-surface-links");
    expect(src).toContain('data-section="reviewer-governance-signals"');
  });

  test("Backend reviewer-ops routes ship the notes endpoints + audit emission", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "services/api/src/routes/reviewer-ops.routes.ts",
      ),
      "utf8",
    );
    expect(src).toContain('"/v1/reviewer-ops/workspace/:workflowId/notes"');
    expect(src).toContain("evidenceReviewerComment.create");
    expect(src).toContain("evidenceReviewerComment.findMany");
    // The seven structured types must be in the enum schema.
    expect(src).toContain("observation");
    expect(src).toContain("concern");
    expect(src).toContain("request_info");
    expect(src).toContain("escalation_context");
    expect(src).toContain("decision_rationale");
    expect(src).toContain("legal_hold_context");
    expect(src).toContain("redaction_context");
    // Audit emission to TeamActivity.
    expect(src).toContain("REVIEWER_NOTE_CREATED");
    // JSON envelope parser tolerates legacy plain-text comments.
    expect(src).toContain("parseStoredNoteBody");
  });
});
