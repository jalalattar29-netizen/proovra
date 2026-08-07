/**
 * Phase 3 (Blocker 1) — External reviewer grant issuance / rotation /
 * reveal must require STEP-UP.
 *
 * External reviewer tokens can expose sensitive workspace evidence to an
 * OUTSIDE reviewer. Previously the issue / bulk-issue / break-glass
 * reveal (token rotate) endpoints were only permission-gated. This
 * closure adds a dedicated step-up purpose `EXTERNAL_REVIEW_GRANT_ISSUE`
 * and gates the sensitive mutations with
 * `requireStepUpForSensitiveAction`, placed AFTER the permission check
 * and BEFORE the mutation.
 *
 * Contract pins (source-contract style, matching the sibling
 * phase-2b-closure-external-portal + phase-closure-integration-step-up
 * tests). They read the canonical source without a DB so they stay fast
 * and never depend on a populated dev database.
 *
 * What is gated (SENSITIVE — token issuance / re-issuance):
 *   * POST /v1/external-review/grants                        (grant issue)
 *   * POST /v1/external-review/invitations                   (invitation issue)
 *   * POST /v1/external-review/invitations/bulk              (bulk issue)
 *   * POST /v1/external-review/invitations/:id/reveal-token  (break-glass rotate/reveal)
 *
 * What is NOT gated (the external reviewer's own flow / read-only /
 * revoke-stays-allowed):
 *   * POST /v1/external-review/access/:token                 (reviewer accept)
 *   * GET  /v1/external-review/access/:token/context         (reviewer context)
 *   * POST /v1/portal/auth                                   (reviewer portal auth)
 *   * POST /v1/external-review/grants/:id/revoke             (revoke — audited)
 *   * POST /v1/external-review/invitations/:id/revoke        (revoke — audited)
 *
 * Historical reviewer access + audit records are preserved: the token
 * rotate/revoke paths use COALESCE and never erase invited_by_user_id or
 * prior access counters (verified in the grant service source pins).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  STEP_UP_PURPOSES,
  StepUpPurposeSchema,
  type StepUpPurpose,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SHARED_IDENTITY = readSource(
  "../../../packages/shared/src/identity-security.ts",
);
const MFA_POLICY = readSource(
  "../../../services/api/src/services/identity-security/mfa-policy.service.ts",
);
const ROUTES_REVIEW = readSource(
  "../../../services/api/src/routes/external-review.routes.ts",
);
const ROUTES_PORTAL = readSource(
  "../../../services/api/src/routes/external-portal.routes.ts",
);
const SVC_GRANT = readSource(
  "../../../services/api/src/services/external-review/external-review-grant.service.ts",
);
const SVC_INVITE = readSource(
  "../../../services/api/src/services/external-review/portal-invitation.service.ts",
);

const PURPOSE = "EXTERNAL_REVIEW_GRANT_ISSUE";

// =============================================================================
// PART 1 — Shared step-up purpose
// =============================================================================

describe("Phase 3 — EXTERNAL_REVIEW_GRANT_ISSUE step-up purpose", () => {
  it("is a member of the canonical STEP_UP_PURPOSES enum", () => {
    expect((STEP_UP_PURPOSES as readonly string[]).includes(PURPOSE)).toBe(
      true,
    );
  });

  it("is accepted by StepUpPurposeSchema (runtime validator)", () => {
    expect(StepUpPurposeSchema.safeParse(PURPOSE).success).toBe(true);
    // The schema still rejects ad-hoc strings — the enum is exhaustive.
    expect(StepUpPurposeSchema.safeParse("EXTERNAL_REVIEW_ANYTHING").success).toBe(
      false,
    );
  });

  it("is typed as a StepUpPurpose", () => {
    const p: StepUpPurpose = PURPOSE;
    expect(p).toBe(PURPOSE);
  });

  it("is declared in the shared identity-security source", () => {
    expect(SHARED_IDENTITY).toMatch(/"EXTERNAL_REVIEW_GRANT_ISSUE"/);
  });

  it("is in the canonical MFA force-list (always forces step-up)", () => {
    // ACTIONS_FORCING_MFA is the source of truth for sensitive actions;
    // the new purpose must be present so org policy can never waive it.
    expect(MFA_POLICY).toMatch(
      /ACTIONS_FORCING_MFA[\s\S]*"EXTERNAL_REVIEW_GRANT_ISSUE"[\s\S]*\];/,
    );
  });
});

// =============================================================================
// PART 2 — Sensitive routes are gated (AFTER permission, BEFORE mutation)
// =============================================================================

describe("Phase 3 — grant ISSUE route is step-up gated", () => {
  it("external-review.routes imports requireStepUpForSensitiveAction", () => {
    expect(ROUTES_REVIEW).toMatch(
      /import\s+\{\s*requireStepUpForSensitiveAction\s*\}\s+from\s+["'][^"']*step-up-middleware\.js["']/,
    );
  });

  it("POST /grants gates on EXTERNAL_REVIEW_GRANT_ISSUE after authorizeOrFail, before issue", () => {
    // Order pin: authorizeOrFail (permission) → requireStepUp → issue.
    const issueBlock = ROUTES_REVIEW.slice(
      ROUTES_REVIEW.indexOf('"/v1/external-review/grants"'),
      ROUTES_REVIEW.indexOf("issueExternalReviewGrant({"),
    );
    expect(issueBlock).toMatch(/authorizeOrFail\(/);
    expect(issueBlock).toMatch(/requireStepUpForSensitiveAction\(/);
    expect(issueBlock).toMatch(/purpose:\s*"EXTERNAL_REVIEW_GRANT_ISSUE"/);
    // authorizeOrFail must come BEFORE the step-up gate.
    expect(issueBlock.indexOf("authorizeOrFail(")).toBeLessThan(
      issueBlock.indexOf("requireStepUpForSensitiveAction("),
    );
    // The mutation must be guarded by an early-return on gate.sent.
    expect(issueBlock).toMatch(/if\s*\(\s*gate\.sent\s*\)\s*return;/);
  });
});

describe("Phase 3 — invitation ISSUE / bulk / reveal routes are step-up gated", () => {
  it("external-portal.routes imports requireStepUpForSensitiveAction", () => {
    expect(ROUTES_PORTAL).toMatch(
      /import\s+\{\s*requireStepUpForSensitiveAction\s*\}\s+from\s+["'][^"']*step-up-middleware\.js["']/,
    );
  });

  it("single invitation issue gates after requireCap, before issueInvitation", () => {
    const block = ROUTES_PORTAL.slice(
      ROUTES_PORTAL.indexOf('"/v1/external-review/invitations"'),
      ROUTES_PORTAL.indexOf("const res = await issueInvitation("),
    );
    // PHASE 12 REMEDIATION — SEC-001 (2026-08-06). INTENTIONAL CONTRACT
    // CHANGE. The RBAC gate is no longer the local, status-blind
    // `requireCap(ctx, …)` helper — that helper was deleted along with
    // `resolveInternalTeam`, the audit's CRITICAL finding. It is now the
    // canonical primitive plus the administrative-tier floor read from the
    // PROVEN canonical role, which admits exactly the same ADMIN+OWNER set.
    //
    // THE ORDERING PROPERTY THIS TEST EXISTS FOR IS UNCHANGED and still
    // asserted below: RBAC completes BEFORE the step-up challenge, which
    // completes before the mutation.
    expect(block).toMatch(/authorizeCurrentWorkspaceOrFail\(/);
    expect(block).toMatch(/isAdministrativeTier\(ctx, ctx\.workspaceId\)/);
    expect(block).toMatch(/requireStepUpForSensitiveAction\(/);
    expect(block).toMatch(/purpose:\s*"EXTERNAL_REVIEW_GRANT_ISSUE"/);
    expect(block.indexOf("isAdministrativeTier(ctx, ctx.workspaceId)")).toBeLessThan(
      block.indexOf("requireStepUpForSensitiveAction("),
    );
  });

  it("bulk invitation issue gates before bulkIssueInvitations", () => {
    const block = ROUTES_PORTAL.slice(
      ROUTES_PORTAL.indexOf('"/v1/external-review/invitations/bulk"'),
      ROUTES_PORTAL.indexOf("bulkIssueInvitations({"),
    );
    expect(block).toMatch(/requireStepUpForSensitiveAction\(/);
    expect(block).toMatch(/purpose:\s*"EXTERNAL_REVIEW_GRANT_ISSUE"/);
  });

  it("break-glass reveal-token (rotate) gates before rotateExternalReviewGrantToken", () => {
    const block = ROUTES_PORTAL.slice(
      ROUTES_PORTAL.indexOf('"/v1/external-review/invitations/:id/reveal-token"'),
      ROUTES_PORTAL.indexOf("rotateExternalReviewGrantToken({"),
    );
    // PHASE 12 REMEDIATION — SEC-001 (2026-08-06). Same intentional change.
    // The break-glass tier is preserved EXACTLY: `review.sla.configure` is
    // the canonical Permission held by OWNER only — ADMIN does not hold it —
    // and `isOwnerTier` re-asserts it from the proven role, matching the
    // former REVIEW_ADMIN-only `review.sampling.policy` capability. The
    // ordering property is unchanged: RBAC before step-up, step-up before
    // the rotation.
    expect(block).toMatch(/permission:\s*"review\.sla\.configure"/);
    expect(block).toMatch(/isOwnerTier\(ctx, ctx\.workspaceId\)/);
    expect(block).toMatch(/requireStepUpForSensitiveAction\(/);
    expect(block).toMatch(/purpose:\s*"EXTERNAL_REVIEW_GRANT_ISSUE"/);
    expect(block.indexOf("isOwnerTier(ctx, ctx.workspaceId)")).toBeLessThan(
      block.indexOf("requireStepUpForSensitiveAction("),
    );
  });
});

// =============================================================================
// PART 3 — Reviewer-side flow + revoke are NOT step-up gated
// =============================================================================

describe("Phase 3 — reviewer-side + revoke NOT gated", () => {
  it("reviewer accept-by-token route does NOT require operator step-up", () => {
    const acceptBlock = ROUTES_REVIEW.slice(
      ROUTES_REVIEW.indexOf('"/v1/external-review/access/:token"'),
      ROUTES_REVIEW.indexOf('"/v1/external-review/access/:token/context"'),
    );
    expect(acceptBlock).not.toMatch(/requireStepUpForSensitiveAction\(/);
  });

  it("operator grant revoke stays allowed (no step-up gate on revoke)", () => {
    const revokeBlock = ROUTES_REVIEW.slice(
      ROUTES_REVIEW.indexOf('"/v1/external-review/grants/:id/revoke"'),
      ROUTES_REVIEW.indexOf('"/v1/external-review/access/:token"'),
    );
    expect(revokeBlock).toMatch(/transitionExternalReviewGrant\(/);
    expect(revokeBlock).not.toMatch(/requireStepUpForSensitiveAction\(/);
  });

  it("portal reviewer auth route does NOT require operator step-up", () => {
    const authBlock = ROUTES_PORTAL.slice(
      ROUTES_PORTAL.indexOf('"/v1/portal/auth"'),
      ROUTES_PORTAL.indexOf('"/v1/portal/logout"'),
    );
    expect(authBlock).not.toMatch(/requireStepUpForSensitiveAction\(/);
  });
});

// =============================================================================
// PART 4 — Audit coverage + history preservation
// =============================================================================

describe("Phase 3 — gated actions are audited + history preserved", () => {
  it("grant issue emits a SecurityEvent (external_review_invited)", () => {
    expect(SVC_GRANT).toMatch(/eventType:\s*"external_review_invited"/);
  });

  it("token rotate/reveal emits an audited break-glass SecurityEvent", () => {
    expect(SVC_GRANT).toMatch(/eventType:\s*"external_review_token_revealed"/);
    expect(SVC_GRANT).toMatch(/breakGlass:\s*true/);
  });

  it("revoke emits an audited SecurityEvent (external_review_revoked)", () => {
    expect(SVC_GRANT).toMatch(/eventType:\s*"external_review_revoked"/);
  });

  it("invitation issue + revoke emit portal activity (audit timeline)", () => {
    expect(SVC_INVITE).toMatch(/code:\s*"GRANT_REVOKED"/);
    expect(SVC_INVITE).toMatch(/emitPortalActivity\(/);
  });

  it("transition preserves prior custody: COALESCE on revoked_by_user_id, never overwrites invited_by_user_id", () => {
    // The UPDATE must COALESCE so a revoke never erases who issued the
    // grant or a prior revocation actor — historical access is intact.
    expect(SVC_GRANT).toMatch(
      /"revoked_by_user_id"\s*=\s*COALESCE\("revoked_by_user_id"/,
    );
    // invited_by_user_id is never in the SET clause of the transition
    // UPDATE (it is set once at INSERT and preserved thereafter).
    const transitionUpdate = SVC_GRANT.slice(
      SVC_GRANT.indexOf('UPDATE "external_review_grants"'),
      SVC_GRANT.indexOf("RETURNING"),
    );
    expect(transitionUpdate).not.toMatch(/SET[\s\S]*"invited_by_user_id"\s*=/);
  });
});
