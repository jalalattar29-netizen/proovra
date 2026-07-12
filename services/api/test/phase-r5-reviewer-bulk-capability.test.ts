/**
 * Phase R5 — Reviewer engine RBAC consolidation (finding F38).
 *
 * Confirmed authority divergence: `POST /v1/reviewer-ops/reviews/bulk`
 * (Engine A, reviewer-ops) gated bulk operations — including the ASSIGN
 * action in `executeBulkTriage` — on ONLY the boolean
 * `evidence_request.review` reviewer flag (`requireReviewerCapable`). That
 * let a plain reviewer (MEMBER → REVIEWER role) bulk-ASSIGN workflows they
 * could NOT single-assign (the single-assign routes here already require
 * the granular `review.assign`), and it diverged from the parallel
 * reviewer-workspace bulk surface (Engine C), which requires `review.bulk`.
 *
 * R5 fix: reviewer-ops bulk now also requires the granular `review.bulk`
 * capability, making the authority identical across the single-assign
 * route, the reviewer-ops bulk route, and the reviewer-workspace bulk
 * route — a TIGHTENING that never grants a previously-denied action.
 *
 * Also pins the A ≡ B invariant: reviewer-ops (`evaluateMemberAccess`) and
 * review-operations (`requirePermission`) both derive the boolean reviewer
 * permission from the SAME shared catalog (`roleHasPermission`), so those
 * two engines cannot diverge on it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { REVIEWER_ROLE_CAPABILITIES } from "@proovra/shared";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const reviewerOpsSrc = read("../src/routes/reviewer-ops.routes.ts");
const reviewerWorkspaceSrc = read("../src/routes/reviewer-workspace.routes.ts");
const governanceSrc = read("../src/services/governance.service.ts");
const accessPolicySrc = read("../src/services/identity/access-policy.service.ts");

describe("Phase R5 — reviewer bulk capability consolidation (F38)", () => {
  it("canonical model: REVIEWER lacks review.bulk/review.assign; SUPERVISOR & REVIEW_ADMIN hold review.bulk", () => {
    // This is the invariant that makes the fix meaningful — bulk is a
    // supervisor-tier capability, not a base reviewer flag.
    expect(REVIEWER_ROLE_CAPABILITIES.REVIEWER).not.toContain("review.bulk");
    expect(REVIEWER_ROLE_CAPABILITIES.REVIEWER).not.toContain("review.assign");
    expect(REVIEWER_ROLE_CAPABILITIES.SUPERVISOR).toContain("review.bulk");
    expect(REVIEWER_ROLE_CAPABILITIES.REVIEW_ADMIN).toContain("review.bulk");
  });

  it("reviewer-ops bulk route enforces the granular review.bulk gate", () => {
    // The helper exists and checks review.bulk...
    expect(reviewerOpsSrc).toContain("requireReviewerBulkCapable");
    expect(reviewerOpsSrc).toMatch(
      /callerHasCapability\(resolution,\s*"review\.bulk"\)/,
    );
    // ...and the bulk handler invokes it.
    const bulkIdx = reviewerOpsSrc.indexOf('"/v1/reviewer-ops/reviews/bulk"');
    expect(bulkIdx).toBeGreaterThan(-1);
    const handler = reviewerOpsSrc.slice(bulkIdx, bulkIdx + 900);
    expect(handler).toContain("requireReviewerBulkCapable");
  });

  it("reviewer-workspace bulk routes require the same review.bulk capability (cross-engine consistency)", () => {
    for (const path of [
      "/v1/reviewer/bulk/assign",
      "/v1/reviewer/bulk/decide",
      "/v1/reviewer/bulk/code",
    ]) {
      const idx = reviewerWorkspaceSrc.indexOf(`"${path}"`);
      expect(idx).toBeGreaterThan(-1);
      const handler = reviewerWorkspaceSrc.slice(idx, idx + 400);
      expect(handler).toMatch(/requireCap\(ctx,\s*"review\.bulk"\)/);
    }
  });

  it("A ≡ B: both engines derive the reviewer permission from the same roleHasPermission catalog", () => {
    // review-operations (Engine B) via requirePermission → roleHasPermission
    expect(governanceSrc).toContain("roleHasPermission");
    // reviewer-ops (Engine A) via evaluateMemberAccess → evaluateAccess → roleHasPermission
    expect(accessPolicySrc).toContain("roleHasPermission");
  });
});
