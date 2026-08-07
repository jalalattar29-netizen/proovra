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
  // Normalize line endings so the route/cap CONTRACT is asserted independently
  // of CRLF vs LF. The sentinels below use `\n`; a CRLF-checked-out source file
  // would otherwise fail on formatting, not on any missing route or gate.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
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

// ===========================================================================
// PHASE 12 REMEDIATION — SEC-001 (2026-08-06). INTENTIONAL CONTRACT CHANGE.
//
// OLD CONTRACT (what Part 5 asserted until this date):
//   external-portal.routes.ts resolved its own workspace via
//   `resolveInternalTeam` — reading the `User.currentWorkspaceId` navigation
//   pointer and a STATUS-BLIND TeamMember row — surfaced
//   `workspaceRole: … | null` plus `isPlatformAdmin`, and gated each route
//   with a LOCAL `requireCap(ctx, <ReviewerCapability>)` helper delegating to
//   the reviewer-workspace capability registry.
//
// NEW CONTRACT:
//   every internal route composes the canonical
//   `authorizeCurrentWorkspaceOrFail` primitive, which treats the pointer as
//   an input CANDIDATE only and revalidates identity, workspace existence,
//   workspace kind, EXPLICIT membership, membership STATUS, access expiry,
//   parent-Organization lifecycle, the canonical Permission and the
//   support-access guard against the database. The administrative TIER the
//   reviewer matrix expressed is re-applied from `ctx.workspaceRole` — the
//   PROVEN canonical role carried on the authorization proof — via
//   `isAdministrativeTier` / `isOwnerTier`.
//
// WHY THE PRODUCTION ARCHITECTURE REQUIRES IT:
//   `resolveInternalTeam` was the audit's CRITICAL finding. It returned
//   SUCCESS for a caller with NO membership row (the role simply became
//   `null`) and for a SUSPENDED or REVOKED member (the stored role was
//   returned verbatim); four of the twelve routes never called `requireCap`
//   at all, so nothing downstream re-checked anything. A user removed from a
//   workspace could enumerate its external-reviewer invitations and trigger
//   an outbound invitation email on its behalf.
//
// NO BEHAVIOURAL PROPERTY IS WEAKENED. The admission set is preserved
// EXACTLY — ADMIN+OWNER for the management routes, OWNER-only for
// break-glass — the denial shape is still the bounded `NOT_PERMITTED`, and
// the previously-UNGATED read routes are now GATED on `review.queue.read`,
// which is strictly stronger than before. Two deliberate TIGHTENINGS are
// asserted below: the platform-admin bypass is removed, and
// `GET .../invitations` is no longer ungated (superseding the old Part 6).
//
// Parts 1-4 of this suite — the capability registry, the role→capability
// tiers, the resolver defaults and the reviewer-workspace metrics gate — are
// UNCHANGED and still pass. The reviewer-workspace surface still uses the
// registry, which remains the one capability matrix for THAT surface.
// ===========================================================================

describe("Phase 12 SEC-001 — external-portal admin gates (canonical primitive)", () => {
  it("no longer resolves its own workspace: resolveInternalTeam is DELETED", () => {
    // Gone, not merely unused: no declaration survives.
    expect(EXTERNAL_ROUTES).not.toMatch(/async function resolveInternalTeam\(/);
    // And the two shapes that made it unsafe are gone with it.
    expect(EXTERNAL_ROUTES).not.toMatch(
      /workspaceRole:\s*"OWNER"\s*\|\s*"ADMIN"\s*\|\s*"MEMBER"\s*\|\s*"VIEWER"\s*\|\s*null/,
    );
    expect(EXTERNAL_ROUTES).not.toMatch(/isPlatformAdmin:\s*boolean/);
  });

  it("composes the canonical authorization primitive instead of a local matrix", () => {
    expect(EXTERNAL_ROUTES).toMatch(/from\s+"\.\.\/middleware\/authorize\.js"/);
    expect(EXTERNAL_ROUTES).toMatch(/authorizeCurrentWorkspaceOrFail/);
    // The second capability vocabulary is no longer imported here.
    expect(EXTERNAL_ROUTES).not.toMatch(
      /from\s+"\.\.\/services\/reviewer-workspace\/reviewer-roles\.js"/,
    );
    expect(EXTERNAL_ROUTES).not.toMatch(/function requireCap\(/);
  });

  it("the platform-admin bypass is removed (deliberate tightening)", () => {
    // The former helper granted REVIEW_ADMIN to any session whose
    // User.platformRole was non-null, bypassing the workspace tier entirely.
    expect(EXTERNAL_ROUTES).not.toMatch(/platformRole:\s*true/);
  });

  it("preserves the administrative tier from the PROVEN canonical role", () => {
    // PHASE 12 CORRECTIVE PASS §1.2 (2026-08-06) — assertion UPDATED, coverage
    // WIDENED, not weakened.
    //
    // Old: /function isAdministrativeTier\(…ctx\.workspaceRole === "OWNER"…"ADMIN"/
    // New: the same two role comparisons, PLUS the runtime-provenance check
    //      that now precedes them.
    //
    // Why it had to change: the tier helpers no longer read `ctx.workspaceRole`
    // directly. They read `assertMintedContext(ctx).workspaceRole`, which
    // refuses any context this service's canonical chain did not mint — the
    // fix for the previous pass's compile-time-only brand. The old regex
    // pinned the literal text `ctx.workspaceRole === "OWNER"` in the FIRST
    // position, so it failed on the hardened source while the production
    // contract (OWNER or ADMIN is administrative; OWNER alone is owner tier)
    // was completely unchanged.
    //
    // The property this test protects — "the tier comes from the proven
    // canonical role, not from a re-derived or self-declared one" — is now
    // asserted MORE strictly, because provenance is asserted as well.
    expect(EXTERNAL_ROUTES).toMatch(
      /function isAdministrativeTier\([\s\S]*?assertMintedAuthorizedWorkspaceContext\(ctx, \{[\s\S]*?workspaceRole === "OWNER"[\s\S]*?workspaceRole === "ADMIN"/,
    );
    expect(EXTERNAL_ROUTES).toMatch(
      /function isOwnerTier\([\s\S]*?assertMintedAuthorizedWorkspaceContext\(ctx, \{[\s\S]*?workspaceRole === "OWNER"/,
    );
  });

  /**
   * Extracts the source block for a route + method by locating the literal
   * `app.METHOD(\n    "<path>"` sentinel and slicing to the next route
   * declaration, so each assertion targets exactly one handler.
   */
  function blockFor(method: "post" | "get", path: string): string {
    const sentinel = `app.${method}(\n    "${path}"`;
    const idx = EXTERNAL_ROUTES.indexOf(sentinel);
    expect(
      idx,
      `expected to find ${method.toUpperCase()} ${path} in external-portal.routes.ts`,
    ).toBeGreaterThanOrEqual(0);
    const tail = EXTERNAL_ROUTES.slice(idx);
    const nextIdx = tail.indexOf("\n  app.", 1);
    return nextIdx === -1 ? tail : tail.slice(0, nextIdx);
  }

  /** Every management route: canonical primitive + ADMIN/OWNER tier floor. */
  const MANAGEMENT_ROUTES: ReadonlyArray<["post" | "get", string]> = [
    ["post", "/v1/external-review/invitations"],
    ["post", "/v1/external-review/invitations/:id/revoke"],
    ["post", "/v1/external-review/invitations/bulk"],
    ["post", "/v1/external-review/invitations/bulk/revoke"],
    ["post", "/v1/external-review/invitations/:id/resend"],
    ["post", "/v1/external-review/invitations/:id/sessions/revoke"],
    ["post", "/v1/external-review/invitations/:id/send-email"],
  ];

  it.each(MANAGEMENT_ROUTES)(
    "%s %s is gated on the canonical primitive + the ADMIN/OWNER tier",
    (method, path) => {
      const block = blockFor(method, path);
      expect(block).toMatch(
        /authorizeCurrentWorkspaceOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?permission:\s*"review\.assign"/,
      );
      expect(block).toMatch(/isAdministrativeTier\(ctx, ctx\.workspaceId\)/);
      expect(block).toMatch(/denyNoPermission\(reply\)/);
    },
  );

  it("reveal-token keeps the strongest tier: OWNER-only break-glass", () => {
    const block = blockFor(
      "post",
      "/v1/external-review/invitations/:id/reveal-token",
    );
    // `review.sla.configure` is the canonical Permission held by OWNER ONLY —
    // ADMIN does not hold it — preserving exactly the split-of-duty the
    // former REVIEW_ADMIN-only `review.sampling.policy` cap expressed.
    expect(block).toMatch(
      /authorizeCurrentWorkspaceOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?permission:\s*"review\.sla\.configure"/,
    );
    expect(block).toMatch(/isOwnerTier\(ctx, ctx\.workspaceId\)/);
    expect(block).toMatch(/denyNoPermission\(reply\)/);
  });

  /** The read routes the audit found UNCAPPED are now explicitly gated. */
  const READ_ROUTES: ReadonlyArray<["post" | "get", string]> = [
    ["get", "/v1/external-review/invitations"],
    ["get", "/v1/external-review/invitations/:id/activity"],
    ["get", "/v1/external-review/invitations/:id/delivery"],
  ];

  it.each(READ_ROUTES)(
    "%s %s now carries an EXPLICIT read capability (was ungated)",
    (method, path) => {
      const block = blockFor(method, path);
      expect(block).toMatch(
        /authorizeCurrentWorkspaceOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?permission:\s*"review\.queue\.read"/,
      );
    },
  );

  it("no workspace data is read before authorization completes", () => {
    for (const [method, path] of MANAGEMENT_ROUTES) {
      const block = blockFor(method, path);
      const authAt = block.indexOf("authorizeCurrentWorkspaceOrFail");
      const prismaAt = block.indexOf("prisma.");
      expect(authAt).toBeGreaterThanOrEqual(0);
      if (prismaAt >= 0) expect(authAt).toBeLessThan(prismaAt);
    }
  });

  it("send-email no longer accepts a caller-supplied rawToken", () => {
    const block = blockFor(
      "post",
      "/v1/external-review/invitations/:id/send-email",
    );
    // The request schema must not carry a token field at all, and the handler
    // must delegate to the server-owned delivery authority, which mints a
    // successor token itself and persists only its hash.
    expect(block).not.toMatch(/rawToken:\s*z\.string\(\)/);
    expect(block).toMatch(/deliverInvitationEmail\(/);
  });
});

// ---------------------------------------------------------------------------
// Part 6 — SUPERSEDED by Phase 12 SEC-001 (2026-08-06).
//
// This part pinned the Phase-5 scoping decision that the read-only listing
// was "intentionally NOT gated". The Phase-12 focused-reachability audit
// showed that decision to BE the defect: GET /v1/external-review/invitations
// was one of the FOUR uncapped routes reachable off a stale
// `User.currentWorkspaceId` pointer, so a user removed from the workspace
// could enumerate its external-reviewer invitations.
//
// Its own comment anticipated this — "If a future phase decides to gate it,
// this guard can be updated". It is updated here in the STRICT direction:
// the route now requires the canonical `review.queue.read` permission, and
// that requirement is asserted POSITIVELY in the Phase-12 block above,
// alongside the same requirement on the activity and delivery reads.
//
// The negative assertion is retained in corrected form: the route must not
// reintroduce the DELETED local `requireCap` matrix — because it is gated by
// the canonical primitive instead, which is also asserted here.
// ---------------------------------------------------------------------------

describe("Phase 12 SEC-001 — read-only listing is gated by the canonical primitive", () => {
  it("GET /v1/external-review/invitations does not reintroduce a local requireCap", () => {
    const sentinel = 'app.get(\n    "/v1/external-review/invitations"';
    const idx = EXTERNAL_ROUTES.indexOf(sentinel);
    expect(idx).toBeGreaterThanOrEqual(0);
    const tail = EXTERNAL_ROUTES.slice(idx);
    const nextIdx = tail.indexOf("\n  app.", 1);
    const block = nextIdx === -1 ? tail : tail.slice(0, nextIdx);
    expect(block).not.toMatch(/requireCap\(/);
    expect(block).toMatch(/authorizeCurrentWorkspaceOrFail\(/);
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
