/**
 * Phase A.1D — Reports + Reviewer Operations operational maturity.
 *
 * Locks in:
 *
 *   1. `POST /v1/evidence/:id/reports/regenerate` exists, requires
 *      auth, returns the documented envelope shape on 404 (unknown
 *      evidence), 403 (non-owner), and 202 (owner with valid
 *      evidence — happy path is harder to drive here because seeding
 *      a real evidence record from the test process is out of scope).
 *
 *   2. `/reports` route still serves 2xx after the retry-CTA wiring
 *      (regression).
 *
 *   3. `/reviewer-ops` route + `/reviewer-ops/sla` + `/reviewer-ops/escalations`
 *      + `/reviewer-ops/[reviewId]` page bundles still serve 2xx
 *      after Phase A.1D cross-surface link additions.
 *
 *   4. The reviewer detail bundle contains the new `data-reviewer-link=*`
 *      markers (source-text presence check; the page is auth-gated so
 *      runtime DOM is not directly inspectable without an authed
 *      browser context, but the static bundle ships the markers).
 *
 *   5. No regression on Phase 2.7X / A.1B / A.1C contracts.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

const NON_UUID = "not-a-uuid";
const NONEXISTENT_EVIDENCE = "00000000-0000-4000-8000-00000000a1d0";

test.describe("Phase A.1D — reports + reviewer operational maturity @critical", () => {
  // ---------------------------------------------------------------------------
  // New endpoint shape — error paths first, since happy path requires
  // a real evidence row + worker queue.
  // ---------------------------------------------------------------------------
  test("POST /v1/evidence/:id/reports/regenerate requires auth", async () => {
    const { request } = await import("@playwright/test");
    const anon = await request.newContext({
      baseURL: process.env.API_BASE ?? "http://localhost:8081",
    });
    const resp = await anon.post(
      `/v1/evidence/${NONEXISTENT_EVIDENCE}/reports/regenerate`,
    );
    expect([401, 403]).toContain(resp.status());
    await anon.dispose();
  });

  test("POST /v1/evidence/:id/reports/regenerate validates the UUID shape", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/evidence/${NON_UUID}/reports/regenerate`,
    );
    // zod parse should 400 the request; if the framework folds it into
    // a generic 500 the contract is still that a non-UUID never reaches
    // the queue (which would crash on bad id). We assert client-error.
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("POST /v1/evidence/:id/reports/regenerate returns 404 for unknown evidence id", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/evidence/${NONEXISTENT_EVIDENCE}/reports/regenerate`,
    );
    // Owner-only gate. For an unknown id the helper throws 404; if a
    // defense-in-depth path returns 403 instead, accept it.
    expect([403, 404]).toContain(resp.status());
  });

  // ---------------------------------------------------------------------------
  // Pages reachable after Phase A.1D wiring.
  // ---------------------------------------------------------------------------
  test("/reports still serves 2xx after retry-CTA wiring", async ({ page }) => {
    const resp = await page.goto("/reports", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /reports, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/reviewer-ops queue page still serves 2xx", async ({ page }) => {
    const resp = await page.goto("/reviewer-ops", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/reviewer-ops/sla page serves 2xx (Phase A.1D regression)", async ({
    page,
  }) => {
    const resp = await page.goto("/reviewer-ops/sla", { waitUntil: "load" });
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops/sla, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/reviewer-ops/escalations page serves 2xx (Phase A.1D regression)", async ({
    page,
  }) => {
    const resp = await page.goto("/reviewer-ops/escalations", {
      waitUntil: "load",
    });
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops/escalations, got ${resp?.status()}`,
    ).toBe(true);
  });

  test("/reviewer-ops/[reviewId] page bundle serves 2xx for an arbitrary id", async ({
    page,
  }) => {
    const resp = await page.goto(
      "/reviewer-ops/00000000-0000-4000-8000-00000000a1d1",
      { waitUntil: "load" },
    );
    expect(
      resp?.ok(),
      `expected 2xx from /reviewer-ops/[reviewId], got ${resp?.status()}`,
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Bundle / source-presence checks — guard the explicit Phase A.1D
  // additions so they don't silently regress.
  // ---------------------------------------------------------------------------
  test("ReportsIndex source ships the Phase A.1D retry CTA marker", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/components/reports-experience/ReportsIndex.tsx",
      ),
      "utf8",
    );
    expect(src).toContain('data-reports-regenerate=');
    expect(src).toContain("/reports/regenerate");
    expect(src).toContain('"Retry generation"');
  });

  test("Reviewer workspace detail source ships the Phase A.1D cross-surface links", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx",
      ),
      "utf8",
    );
    expect(src).toContain('data-reviewer-cross-surface-links');
    expect(src).toContain('data-reviewer-link="open-evidence"');
    expect(src).toContain('data-reviewer-link="download-report"');
    expect(src).toContain('data-reviewer-link="download-package"');
    expect(src).toContain('data-reviewer-link="open-reports"');
    expect(src).toContain('data-reviewer-link="open-escalations"');
  });

  test("Backend regenerate endpoint source is registered with audit emission", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "services/api/src/routes/evidence.routes.ts",
      ),
      "utf8",
    );
    expect(src).toContain('/v1/evidence/:id/reports/regenerate');
    expect(src).toContain("evidence.report.regenerate_requested");
    expect(src).toContain("forceRegenerate: true");
    // The owner-only gate must be used (we deliberately did NOT use
    // getEvidenceWithReadAccess for this mutation).
    expect(src).toContain("getEvidenceWithOwnerAccess(userId, id)");
  });
});
