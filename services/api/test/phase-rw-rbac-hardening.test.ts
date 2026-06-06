/**
 * Phase 5 — Reviewer-workspace + external-portal RBAC hardening.
 *
 * Locks the canonical requireCap gating wired in Phase 5:
 *
 *   - GET /v1/reviewer/metrics                                      → review.assign
 *   - POST /v1/external-review/invitations                          → review.assign
 *   - POST /v1/external-review/invitations/:id/revoke               → review.assign
 *   - POST /v1/external-review/invitations/:id/resend               → review.assign
 *   - POST /v1/external-review/invitations/:id/sessions/revoke      → review.assign
 *   - POST /v1/external-review/invitations/bulk                     → review.bulk + review.assign
 *   - POST /v1/external-review/invitations/bulk/revoke              → review.bulk + review.assign
 *   - POST /v1/external-review/invitations/:id/reveal-token         → review.sampling.policy (REVIEW_ADMIN-only)
 *
 * Hard rules pinned here:
 *
 *   1. No new permission is introduced. Every gate uses an existing
 *      `ReviewerCapability` already in the canonical reviewer-workspace
 *      registry (`packages/shared/src/reviewer-workspace.ts`).
 *
 *   2. The break-glass reveal-token route is gated to the strongest
 *      capability that workspace ADMIN (SUPERVISOR) does NOT have:
 *      `review.sampling.policy`. Only OWNER (REVIEW_ADMIN) — or a
 *      member explicitly elevated to REVIEW_ADMIN via reviewerRoleOverride
 *      — can hit it.
 *
 *   3. requireCap is additive, not a replacement: the existing
 *      `requireAuth` preHandler + `resolveInternalTeam` /
 *      `resolveTeam` continue to run first. Personal workspaces /
 *      missing membership still produce `WORKSPACE_NOT_FOUND`, not
 *      `NOT_PERMITTED`.
 *
 *   4. The bounded denial reason for a permission failure is
 *      `NOT_PERMITTED` (already in REVIEWER_DENIAL_REASONS).
 *
 *   5. Source-text contract: external-portal.routes.ts reuses the
 *      canonical `callerHasCapability` + `resolveReviewerRole`
 *      helpers from
 *      `services/api/src/services/reviewer-workspace/reviewer-roles.ts`
 *      — i.e. there is exactly one capability matrix.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REVIEWER_CAPABILITIES,
  REVIEWER_DENIAL_REASONS,
  REVIEWER_ROLE_CAPABILITIES,
} from "@proovra/shared";

import {
  callerHasCapability,
  resolveReviewerRole,
} from "../src/services/reviewer-workspace/reviewer-roles.js";

// ---------------------------------------------------------------------------
// Source text
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const REVIEWER_ROUTES = readSource(
  "../src/routes/reviewer-workspace.routes.ts",
);
const EXTERNAL_ROUTES = readSource("../src/routes/external-portal.routes.ts");

// ---------------------------------------------------------------------------
// Part 1 — Capability registry remains canonical
// ---------------------------------------------------------------------------

describe("Phase 5 RBAC — uses existing capabilities only", () => {
  it("review.assign is a canonical ReviewerCapability", () => {
    expect(REVIEWER_CAPABILITIES).toContain("review.assign");
  });

  it("review.bulk is a canonical ReviewerCapability", () => {
    expect(REVIEWER_CAPABILITIES).toContain("review.bulk");
  });

  it("review.sampling.policy is a canonical ReviewerCapability", () => {
    expect(REVIEWER_CAPABILITIES).toContain("review.sampling.policy");
  });

  it("NOT_PERMITTED is the canonical denial reason for cap failures", () => {
    expect(REVIEWER_DENIAL_REASONS).toContain("NOT_PERMITTED");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — Role → capability matrix (verifies the chosen gates land
// in the correct tiers).
// ---------------------------------------------------------------------------

describe("Phase 5 RBAC — role / capability tiers (runtime helper)", () => {
  function rolesWithCap(cap: (typeof REVIEWER_CAPABILITIES)[number]): string[] {
    return Object.entries(REVIEWER_ROLE_CAPABILITIES)
      .filter(([, caps]) => (caps as ReadonlyArray<string>).includes(cap))
      .map(([role]) => role)
      .sort();
  }

  it("review.assign is granted to SUPERVISOR + REVIEW_ADMIN only", () => {
    expect(rolesWithCap("review.assign")).toEqual([
      "REVIEW_ADMIN",
      "SUPERVISOR",
    ]);
  });

  it("review.bulk is granted to SUPERVISOR + REVIEW_ADMIN only", () => {
    expect(rolesWithCap("review.bulk")).toEqual([
      "REVIEW_ADMIN",
      "SUPERVISOR",
    ]);
  });

  it("review.sampling.policy is REVIEW_ADMIN-only (break-glass tier)", () => {
    expect(rolesWithCap("review.sampling.policy")).toEqual(["REVIEW_ADMIN"]);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — Default workspace-role → ReviewerRole resolution.
//
// Pins the resolver behaviour the route layer relies on:
//   OWNER  → REVIEW_ADMIN (all caps, including review.sampling.policy)
//   ADMIN  → SUPERVISOR   (no review.sampling.policy, no review.schema.author)
//   MEMBER → REVIEWER     (no admin-tier caps)
//   VIEWER → null         (no caps)
// ---------------------------------------------------------------------------

describe("Phase 5 RBAC — default reviewer-role resolution", () => {
  it("VIEWER cannot pass any of the new gates", () => {
    const r = resolveReviewerRole({
      workspaceRole: "VIEWER",
      isPlatformAdmin: false,
    });
    expect(callerHasCapability(r, "review.assign")).toBe(false);
    expect(callerHasCapability(r, "review.bulk")).toBe(false);
    expect(callerHasCapability(r, "review.sampling.policy")).toBe(false);
  });

  it("MEMBER (default REVIEWER) cannot pass any of the new gates", () => {
    const r = resolveReviewerRole({
      workspaceRole: "MEMBER",
      isPlatformAdmin: false,
    });
    expect(callerHasCapability(r, "review.assign")).toBe(false);
    expect(callerHasCapability(r, "review.bulk")).toBe(false);
    expect(callerHasCapability(r, "review.sampling.policy")).toBe(false);
  });

  it("ADMIN (SUPERVISOR) can read metrics + manage invitations + bulk", () => {
    const r = resolveReviewerRole({
      workspaceRole: "ADMIN",
      isPlatformAdmin: false,
    });
    expect(callerHasCapability(r, "review.assign")).toBe(true);
    expect(callerHasCapability(r, "review.bulk")).toBe(true);
    // But the break-glass tier is intentionally OUT of reach for ADMIN.
    expect(callerHasCapability(r, "review.sampling.policy")).toBe(false);
  });

  it("OWNER (REVIEW_ADMIN) can additionally hit reveal-token", () => {
    const r = resolveReviewerRole({
      workspaceRole: "OWNER",
      isPlatformAdmin: false,
    });
    expect(callerHasCapability(r, "review.assign")).toBe(true);
    expect(callerHasCapability(r, "review.bulk")).toBe(true);
    expect(callerHasCapability(r, "review.sampling.policy")).toBe(true);
  });

  it("a missing membership (null workspaceRole) blocks every gate", () => {
    const r = resolveReviewerRole({
      workspaceRole: null,
      isPlatformAdmin: false,
    });
    expect(callerHasCapability(r, "review.assign")).toBe(false);
    expect(callerHasCapability(r, "review.bulk")).toBe(false);
    expect(callerHasCapability(r, "review.sampling.policy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — Reviewer-workspace metrics route is now gated.
// ---------------------------------------------------------------------------

describe("Phase 5 RBAC — /v1/reviewer/metrics gate", () => {
  it("declares the canonical path", () => {
    expect(REVIEWER_ROUTES).toContain('"/v1/reviewer/metrics"');
  });

  it("retains the requireAuth preHandler", () => {
    // The metrics route block continues to declare requireAuth.
    const sliceStart = REVIEWER_ROUTES.indexOf('"/v1/reviewer/metrics"');
    const sliceEnd = REVIEWER_ROUTES.indexOf(
      "// CODING SCHEMAS",
      sliceStart,
    );
    const block = REVIEWER_ROUTES.slice(sliceStart, sliceEnd);
    expect(block).toMatch(/preHandler:\s*requireAuth/);
  });

  it("adds requireCap('review.assign') inside the metrics handler", () => {
    const sliceStart = REVIEWER_ROUTES.indexOf('"/v1/reviewer/metrics"');
    const sliceEnd = REVIEWER_ROUTES.indexOf(
      "// CODING SCHEMAS",
      sliceStart,
    );
    const block = REVIEWER_ROUTES.slice(sliceStart, sliceEnd);
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.assign"\s*\)/);
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });
});

// ---------------------------------------------------------------------------
// Part 5 — External-portal admin routes are gated.
// ---------------------------------------------------------------------------

describe("Phase 5 RBAC — external-portal admin gates", () => {
  it("imports requireCap helpers from the reviewer-workspace registry", () => {
    expect(EXTERNAL_ROUTES).toMatch(
      /from\s+"\.\.\/services\/reviewer-workspace\/reviewer-roles\.js"/,
    );
    expect(EXTERNAL_ROUTES).toMatch(/callerHasCapability/);
    expect(EXTERNAL_ROUTES).toMatch(/resolveReviewerRole/);
  });

  it("defines a local requireCap helper that delegates to the registry", () => {
    expect(EXTERNAL_ROUTES).toMatch(
      /function requireCap\([\s\S]*?cap:\s*ReviewerCapability/,
    );
    expect(EXTERNAL_ROUTES).toMatch(/denyNoPermission\(reply\)/);
  });

  it("resolveInternalTeam now surfaces workspaceRole + isPlatformAdmin", () => {
    expect(EXTERNAL_ROUTES).toMatch(
      /workspaceRole:\s*"OWNER"\s*\|\s*"ADMIN"\s*\|\s*"MEMBER"\s*\|\s*"VIEWER"\s*\|\s*null/,
    );
    expect(EXTERNAL_ROUTES).toMatch(/isPlatformAdmin:\s*boolean/);
    expect(EXTERNAL_ROUTES).toMatch(/platformRole:\s*true/);
  });

  /**
   * Helper that extracts the source block for a given route + method
   * by locating the literal app.METHOD( "<path>" sentinel and slicing
   * to the next route declaration. This lets each assertion target a
   * single handler without false positives from neighbouring blocks.
   */
  function blockFor(method: "post" | "get", path: string): string {
    const sentinel = `app.${method}(\n    "${path}"`;
    const idx = EXTERNAL_ROUTES.indexOf(sentinel);
    expect(
      idx,
      `expected to find ${method.toUpperCase()} ${path} in external-portal.routes.ts`,
    ).toBeGreaterThanOrEqual(0);
    // Slice until the next `  app.` at column 2 or the file end.
    const tail = EXTERNAL_ROUTES.slice(idx);
    const nextIdx = tail.indexOf("\n  app.", 1);
    return nextIdx === -1 ? tail : tail.slice(0, nextIdx);
  }

  it("POST /v1/external-review/invitations requires review.assign", () => {
    const block = blockFor("post", "/v1/external-review/invitations");
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.assign"\s*\)/);
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });

  it("POST /v1/external-review/invitations/:id/revoke requires review.assign", () => {
    const block = blockFor(
      "post",
      "/v1/external-review/invitations/:id/revoke",
    );
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.assign"\s*\)/);
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });

  it("POST /v1/external-review/invitations/bulk requires review.bulk AND review.assign", () => {
    const block = blockFor("post", "/v1/external-review/invitations/bulk");
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.bulk"\s*\)/);
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.assign"\s*\)/);
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });

  it("POST /v1/external-review/invitations/bulk/revoke requires review.bulk AND review.assign", () => {
    const block = blockFor(
      "post",
      "/v1/external-review/invitations/bulk/revoke",
    );
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.bulk"\s*\)/);
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.assign"\s*\)/);
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });

  it("POST /v1/external-review/invitations/:id/resend requires review.assign", () => {
    const block = blockFor(
      "post",
      "/v1/external-review/invitations/:id/resend",
    );
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.assign"\s*\)/);
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });

  it("POST /v1/external-review/invitations/:id/sessions/revoke requires review.assign", () => {
    const block = blockFor(
      "post",
      "/v1/external-review/invitations/:id/sessions/revoke",
    );
    expect(block).toMatch(/requireCap\(\s*ctx\s*,\s*"review\.assign"\s*\)/);
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });

  it("POST /v1/external-review/invitations/:id/reveal-token requires the strongest cap (review.sampling.policy)", () => {
    const block = blockFor(
      "post",
      "/v1/external-review/invitations/:id/reveal-token",
    );
    expect(block).toMatch(
      /requireCap\(\s*ctx\s*,\s*"review\.sampling\.policy"\s*\)/,
    );
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });
});

// ---------------------------------------------------------------------------
// Part 6 — Negative: read-only GET listing is intentionally NOT gated
// (per task scope). If a future phase decides to gate it, this guard
// can be updated; for now we pin the audit decision.
// ---------------------------------------------------------------------------

describe("Phase 5 RBAC — read-only listing remains ungated", () => {
  it("GET /v1/external-review/invitations does NOT add requireCap", () => {
    // Find the GET listing block.
    const sentinel = 'app.get(\n    "/v1/external-review/invitations"';
    const idx = EXTERNAL_ROUTES.indexOf(sentinel);
    expect(idx).toBeGreaterThanOrEqual(0);
    const tail = EXTERNAL_ROUTES.slice(idx);
    const nextIdx = tail.indexOf("\n  app.", 1);
    const block = nextIdx === -1 ? tail : tail.slice(0, nextIdx);
    expect(block).not.toMatch(/requireCap\(/);
  });
});

// ---------------------------------------------------------------------------
// Part 7 — Reveal-token gate strictness — explicit role-by-role probe.
// Ensures that "break-glass" really is REVIEW_ADMIN-only at runtime.
// ---------------------------------------------------------------------------

describe("Phase 5 RBAC — reveal-token break-glass is REVIEW_ADMIN-only", () => {
  for (const role of [
    "OWNER",
    "ADMIN",
    "MEMBER",
    "VIEWER",
  ] as const) {
    it(`workspaceRole=${role} → reveal-token cap matches expectation`, () => {
      const r = resolveReviewerRole({
        workspaceRole: role,
        isPlatformAdmin: false,
      });
      const allowed = callerHasCapability(r, "review.sampling.policy");
      // OWNER → REVIEW_ADMIN → allowed.
      // Everyone else → denied.
      expect(allowed).toBe(role === "OWNER");
    });
  }
});
