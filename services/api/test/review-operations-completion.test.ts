/**
 * Phase 13.5 — Review operations completion tests.
 *
 *   - Governance gate matrix: every review status maps to the
 *     correct "approved-for-export" predicate. Tightening from
 *     Phase 13 is permanent.
 *   - SLA cron is production-fail-closed (source-level: routes use
 *     `requireIntegrationCronSecret`, middleware returns 503 in prod).
 *   - Decision flow emits notifications only for the safe surface
 *     (ESCALATE + REQUEST_MORE_INFO) — no notification of internal
 *     decisions (APPROVE_INTERNAL / REJECT_INSUFFICIENT).
 *   - Reconciliation summary fields exist + skip-completed and
 *     skip-paused branches are present in the source.
 *   - Workspace SLA defaults flow through ensureReviewWorkflow.
 *
 * Source-text + projection tests; no DB needed.
 */

import { describe, expect, it } from "vitest";

import {
  reviewStatusSatisfiesGovernanceGate,
} from "../src/services/governance.service.js";

// -----------------------------------------------------------------------------
// Part A — governance gate matrix
// -----------------------------------------------------------------------------

describe("reviewStatusSatisfiesGovernanceGate — Phase 13.5 strict matrix", () => {
  it("APPROVED_INTERNAL satisfies the gate", () => {
    expect(reviewStatusSatisfiesGovernanceGate("APPROVED_INTERNAL")).toBe(
      true,
    );
  });

  it("READY_FOR_EXTERNAL_REVIEW (legacy) satisfies the gate", () => {
    expect(
      reviewStatusSatisfiesGovernanceGate("READY_FOR_EXTERNAL_REVIEW"),
    ).toBe(true);
  });

  it("IN_REVIEW does NOT satisfy the gate (Phase 13 tightening)", () => {
    expect(reviewStatusSatisfiesGovernanceGate("IN_REVIEW")).toBe(false);
  });

  it("every other stage does NOT satisfy the gate", () => {
    for (const status of [
      "NOT_STARTED",
      "QUEUED",
      "ASSIGNED",
      "NEEDS_INFO",
      "NEEDS_MORE_INFO",
      "RESPONSE_RECEIVED",
      "ESCALATED",
      "REOPENED",
      "REJECTED_INSUFFICIENT",
      "CLOSED",
    ]) {
      expect(
        reviewStatusSatisfiesGovernanceGate(status),
        `${status} should NOT satisfy`,
      ).toBe(false);
    }
  });

  it("null / undefined / unknown short-circuits to false", () => {
    expect(reviewStatusSatisfiesGovernanceGate(null)).toBe(false);
    expect(reviewStatusSatisfiesGovernanceGate(undefined)).toBe(false);
    expect(reviewStatusSatisfiesGovernanceGate("nonsense")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Part F — governance routes wire the gate through canGenerateReport /
// canGeneratePackage / canPublishPublicVerify. Verify the source still
// calls `evidenceIsReviewed` and passes it as `reviewState.isReviewed`.
// -----------------------------------------------------------------------------

describe("export-gate wiring — source-level", () => {
  it("evidence.routes.ts passes evidenceIsReviewed into the gate", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/evidenceIsReviewed\(/);
    expect(src).toMatch(/const\s+reviewState\s*=\s*\{\s*isReviewed\s*\}/);
  });

  it("canGenerateReport / canGeneratePackage / canPublishPublicVerify all gate on reviewState.isReviewed", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/services/governance.service.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const fnName of [
      "canGenerateReport",
      "canGeneratePackage",
      "canPublishPublicVerify",
    ]) {
      // Match the function body from its signature through `return { allowed: true };`
      // — every gate ends with that line on the happy path.
      const re = new RegExp(
        `export function ${fnName}[\\s\\S]*?return \\{ allowed: true \\};`,
      );
      const m = src.match(re);
      expect(m, `expected ${fnName} body to be present`).not.toBeNull();
      if (m) {
        expect(m[0]).toMatch(/reviewState\?\.isReviewed/);
        expect(m[0]).toMatch(/requireReviewBefore/);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// Part D — SLA cron source-level checks
// -----------------------------------------------------------------------------

describe("SLA cron route — production fail-closed", () => {
  it("uses requireIntegrationCronSecret + cron-secret middleware fails closed in prod", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");

    const route = await readFile(
      fileURLToPath(
        new URL(
          "../src/routes/review-operations.routes.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(route).toMatch(/requireIntegrationCronSecret/);

    const middleware = await readFile(
      fileURLToPath(
        new URL("../src/middleware/cron-secret.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(middleware).toMatch(/isProduction\(\)/);
    expect(middleware).toMatch(/CONFIGURATION_ERROR/);
    expect(middleware).toMatch(/reply\.code\(503\)/);
  });

  it("reconcileReviewSlas summary surfaces skip + flip counters and dedupes BREACHED", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/review-operations/review-operations.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/skippedCompleted/);
    expect(src).toMatch(/skippedPaused/);
    expect(src).toMatch(/flippedBreached/);
    // Already-BREACHED rows are excluded by the WHERE clause so the
    // sweep is idempotent.
    expect(src).toMatch(/slaStatus:\s*\{\s*in:\s*\[/);
    // Closed / terminal workflows are excluded too.
    expect(src).toMatch(/notIn:\s*\["CLOSED"/);
  });
});

// -----------------------------------------------------------------------------
// Part C — decision dispatch surface
// -----------------------------------------------------------------------------

describe("review decision → notification dispatch", () => {
  it("decision flow notifies ONLY safe events (ESCALATE / REQUEST_INFO)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    // Track 1C — the dispatch is now split across the two canonical
    // writers: the lifecycle service notifies on ESCALATE only; the
    // decision authority notifies when the projection lands on
    // NEEDS_MORE_INFO. APPROVE / REJECT never email anyone — they're
    // internal operator decisions.
    const lifecycleSrc = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/review-operations/review-operations.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(lifecycleSrc).toMatch(/notifyReviewEscalated\(/);
    // Verdict notifications no longer live in the lifecycle service.
    expect(lifecycleSrc).not.toMatch(/notifyReviewNeedsMoreInfo/);

    const authoritySrc = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/reviewer-ops/review-decision.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(authoritySrc).toMatch(/notifyReviewNeedsMoreInfo\(/);
    // No approve / reject notification dispatch exists anywhere in
    // either writer.
    for (const src of [lifecycleSrc, authoritySrc]) {
      expect(src).not.toMatch(/notifyReview\w*(Approved|Rejected)/);
    }
  });

  it("assignReviewer dispatches notifyReviewAssigned on every (re)assignment", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/review-operations/review-operations.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/notifyReviewAssigned\(/);
    expect(src).toMatch(/isReassignment/);
  });

  it("review-notification dispatch reuses safeSendEmailNotification", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/review-operations/review-notifications.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/safeSendEmailNotification\(/);
    // The template uses ONLY ReviewAssigned-shaped data so internal
    // notes, rejection reasons, and decision content can never leak.
    expect(src).toMatch(/kind: "ReviewAssigned"/);
    // No reference to internal note / rejection reason / escalation
    // reason fields in the email payload.
    expect(src).not.toMatch(/escalationReason/);
    expect(src).not.toMatch(/rejectionReason/);
    expect(src).not.toMatch(/note:/);
  });
});

// -----------------------------------------------------------------------------
// Part E — workspace SLA default foundation
// -----------------------------------------------------------------------------

describe("workspace SLA defaults — foundation", () => {
  it("ensureReviewWorkflow consumes workspace policy defaults at create time", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/review-operations/review-operations.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/loadWorkspaceSlaDefaults/);
    expect(src).toMatch(/defaultReviewDueHours/);
    expect(src).toMatch(/defaultFirstResponseDueHours/);
    expect(src).toMatch(/defaultEscalationDueHours/);
    // SLA_UPDATED event is emitted with source: "template_default" so
    // operators can trace why the SLA exists.
    expect(src).toMatch(/source:\s*"template_default"/);
  });

  it("DEFAULT_POLICY has the three new SLA-default fields (no migration drift)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/services/governance.service.ts", import.meta.url),
      ),
      "utf8",
    );
    const def = src.match(/export const DEFAULT_POLICY[\s\S]*?\};/);
    expect(def).not.toBeNull();
    if (def) {
      expect(def[0]).toMatch(/defaultReviewDueHours:\s*null/);
      expect(def[0]).toMatch(/defaultFirstResponseDueHours:\s*null/);
      expect(def[0]).toMatch(/defaultEscalationDueHours:\s*null/);
    }
  });
});

// -----------------------------------------------------------------------------
// Part H — privacy
// -----------------------------------------------------------------------------

describe("review privacy — service accounts cannot make human decisions", () => {
  it("review-operations routes require authenticated session, not API key", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/routes/review-operations.routes.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Every non-cron route uses requireAuth (session JWT) — not
    // requireApiKey (Bearer service-account token).
    expect(src).not.toMatch(/requireApiKey/);
    expect(src).toMatch(/preHandler:\s*requireAuth/);
    // Cron route uses the cron secret only.
    expect(src).toMatch(/requireIntegrationCronSecret/);
  });

  it("notification template payload excludes private review fields", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/notifications/templates.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The renderReviewVariant body should NOT include the rejection
    // reason / escalation reason / decision note in the email body.
    const fn = src.match(/function renderReviewVariant[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    if (fn) {
      expect(fn[0]).not.toMatch(/rejectionReason/);
      expect(fn[0]).not.toMatch(/escalationReason/);
      expect(fn[0]).not.toMatch(/internalNote/);
    }
  });
});
