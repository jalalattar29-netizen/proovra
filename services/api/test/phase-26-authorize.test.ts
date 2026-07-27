/**
 * Phase 26 — Centralized authorize() helper source-contract tests.
 *
 * The existing identity infrastructure (permission catalog, SSO, SCIM,
 * adaptive auth, audit chain, admin/identity UI) was already shipped
 * across Phase 17 / 26.5 / 26.75. The Phase 26 GAP this turn fills is
 * the canonical route-side `authorize()` helper that wraps
 * `evaluateMemberAccess` with:
 *
 *   - A bounded `AuthorizationDenialCode` catalog (operators never see
 *     free-text errors).
 *   - The canonical 401/403/404/503 response shapes.
 *   - Anti-enumeration semantics: opt-in 404 for non-members.
 *   - Fail-closed behaviour: any unexpected exception → 503 deny,
 *     never a 500 leak.
 *   - Audit emission delegated to the access-policy engine (no
 *     duplicate audit row).
 *   - Metric counters for allow / deny / fail-closed.
 *
 * Pure source-contract tests — no DB, no Fastify runtime. The helper
 * itself is exercised via its pure `evaluateAuthorize` export in
 * behaviour-style assertions where appropriate.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUTHORIZATION_DENIAL_CODES,
  type AuthorizationDenialCode,
  evaluateAuthorize,
} from "../src/middleware/authorize.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Bounded denial-code catalog
// =============================================================================

describe("Phase 26 — bounded authorization denial codes", () => {
  it("exports the bounded catalog (operators see only these codes)", () => {
    expect(Array.isArray(AUTHORIZATION_DENIAL_CODES)).toBe(true);
    expect(AUTHORIZATION_DENIAL_CODES.length).toBeGreaterThan(0);
  });

  it("includes every AccessDenyReason from the access-policy engine (no drift)", () => {
    // The catalog must be a strict superset of AccessDenyReason — if
    // the access-policy engine adds a new deny reason, the
    // route-side catalog must be extended in lockstep.
    for (const reason of [
      "no_actor",
      "member_not_active",
      "member_access_expired",
      // PHASE 1 (2026-07-21) — org-lifecycle + workspace-kind deny reasons.
      "organization_not_active",
      "workspace_kind_unresolved",
      "service_account_revoked",
      "service_account_disabled",
      "service_account_expired",
      "service_account_scope_missing",
      "contributor_session_revoked",
      "contributor_session_expired",
      "contributor_unsupported_permission",
      "permission_not_granted",
    ] as const) {
      expect(
        (AUTHORIZATION_DENIAL_CODES as ReadonlyArray<string>).includes(reason),
      ).toBe(true);
    }
  });

  it("includes route-side codes the access engine does not emit", () => {
    expect(
      (AUTHORIZATION_DENIAL_CODES as ReadonlyArray<string>).includes(
        "missing_team_id",
      ),
    ).toBe(true);
    expect(
      (AUTHORIZATION_DENIAL_CODES as ReadonlyArray<string>).includes(
        "missing_actor",
      ),
    ).toBe(true);
    expect(
      (AUTHORIZATION_DENIAL_CODES as ReadonlyArray<string>).includes(
        "authorization_unavailable",
      ),
    ).toBe(true);
  });

  it("every code is a stable snake_case identifier — no PII / no workspace identifiers", () => {
    for (const code of AUTHORIZATION_DENIAL_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
      // Defensive: no email / no uuid / no team_id leak.
      expect(code).not.toMatch(/@|-[0-9a-f]{8}/);
    }
  });
});

// =============================================================================
// PART 2 — evaluateAuthorize behaviour (pure, no Fastify runtime)
// =============================================================================

function makeReq(actorUserId: string | null): {
  ip: string | undefined;
  id: string;
  headers: Record<string, string>;
} {
  // The `getAuthUserId` helper reads from `req.user.sub` (set by the
  // requireAuth preHandler) so we mimic that shape directly.
  return {
    ip: "127.0.0.1",
    id: "test-request",
    headers: {},
    ...(actorUserId ? { user: { sub: actorUserId } } : {}),
  } as never;
}

describe("Phase 26 — evaluateAuthorize behaviour", () => {
  it("returns 'missing_actor' when no session is attached", async () => {
    const outcome = await evaluateAuthorize(makeReq(null) as never, {
      teamId: "11111111-1111-1111-1111-111111111111",
      permission: "audit.read",
    });
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.reasonCode).toBe("missing_actor");
    expect(outcome.httpStatus).toBe(401);
  });

  it("returns 'missing_team_id' when teamId is empty (400 by default)", async () => {
    const outcome = await evaluateAuthorize(makeReq("u1") as never, {
      teamId: null,
      permission: "audit.read",
    });
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.reasonCode).toBe("missing_team_id");
    expect(outcome.httpStatus).toBe(400);
  });

  it("antiEnumeration: true coerces missing-team to 404 (anti-enum)", async () => {
    const outcome = await evaluateAuthorize(makeReq("u1") as never, {
      teamId: undefined,
      permission: "audit.read",
      antiEnumeration: true,
    });
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.reasonCode).toBe("missing_team_id");
    expect(outcome.httpStatus).toBe(404);
  });
});

// =============================================================================
// PART 3 — Source-contract assertions on the helper itself
// =============================================================================

describe("Phase 26 — authorize helper source contract", () => {
  const src = readSource("../../../services/api/src/middleware/authorize.ts");

  it("delegates audit emission to evaluateMemberAccess (no duplicate audit row)", () => {
    // The helper must NOT *invoke* recordPermissionDecision or
    // appendPlatformAuditLog directly — the access-policy engine
    // already calls recordPermissionDecision inside
    // evaluateMemberAccess. Strip comments before the assertion so
    // doc-header references to the API contract don't trip it.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/recordPermissionDecision\s*\(/);
    expect(noComments).not.toMatch(/appendPlatformAuditLog\s*\(/);
  });

  it("never sends a free-text reason on a 403 deny (bounded vocabulary only)", () => {
    // The 403 branch sends `{ code: "permission_denied", reason: reasonCode }`
    // — reasonCode is the bounded enum, not a free-text string.
    expect(src).toMatch(
      /reply\.code\(403\)\.send\(\{\s*error:\s*\{\s*code:\s*"permission_denied",\s*reason:\s*reasonCode\s*,?\s*\}\s*,?\s*\}\)/,
    );
  });

  it("404 anti-enumeration response shape never carries a reason field (no info leak)", () => {
    expect(src).toMatch(
      /reply\.code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"\s*\}\s*\}\)/,
    );
  });

  it("401 unauthenticated response shape carries only the bounded code", () => {
    expect(src).toMatch(
      /reply\.code\(401\)\.send\(\{\s*error:\s*\{\s*code:\s*"unauthenticated"\s*\}\s*\}\)/,
    );
  });

  it("503 fail-closed response never leaks Prisma / exception messages", () => {
    expect(src).toMatch(
      /reply\.code\(503\)\.send\(\{\s*error:\s*\{[\s\S]*?code:\s*"authorization_unavailable"/,
    );
    // The fail-closed branch must not include `err.message` or
    // anything that could leak internals.
    const slice503 = src.slice(src.indexOf("503"));
    expect(slice503).not.toMatch(/err\.message/);
    expect(slice503).not.toMatch(/error\.message/);
  });

  it("wraps every evaluateMemberAccess call in try/catch (fail-closed contract)", () => {
    expect(src).toMatch(
      /try\s*\{\s*decision\s*=\s*await\s+evaluateMemberAccess/,
    );
    expect(src).toMatch(
      /catch\s*\{[\s\S]*?bump\("authorize_failed_closed_total"\)/,
    );
  });

  it("bumps allow / deny / fail-closed counters for every code path", () => {
    expect(src).toMatch(/bump\("authorize_allowed_total"\)/);
    expect(src).toMatch(/bump\("authorize_denied_total"\)/);
    expect(src).toMatch(/bump\("authorize_failed_closed_total"\)/);
  });

  it("attaches the resolved (actorUserId, teamId) to the request so handlers can re-use without re-fetching", () => {
    expect(src).toMatch(
      /\(req as FastifyRequest & \{[\s\S]*?authorized\?:\s*\{[\s\S]*?actorUserId:\s*string;\s*teamId:\s*string/,
    );
  });

  it("imports the canonical Permission type from @proovra/shared (no string-typed permissions)", () => {
    expect(src).toMatch(
      /import\s+type\s*\{\s*Permission\s*\}\s+from\s+"@proovra\/shared"/,
    );
  });

  it("antiEnumeration only coerces membership-class denials, not permission-not-granted", () => {
    // Permission-not-granted means "you ARE a member but lack the
    // permission" — that's a 403, not a 404, regardless of
    // anti-enumeration.
    expect(src).toMatch(
      /isMembershipFailure\s*=[\s\S]*?"no_actor"[\s\S]*?"member_not_active"[\s\S]*?"member_access_expired"/,
    );
    // PHASE 1 (2026-07-21) — an unavailable parent organization is a
    // "context you cannot enter" failure and must conceal as 404 too.
    expect(src).toMatch(
      /isMembershipFailure\s*=[\s\S]*?"organization_not_active"/,
    );
    // A workspace whose kind cannot be proven is also a membership-class
    // (context-you-cannot-enter) failure and conceals as 404.
    expect(src).toMatch(
      /isMembershipFailure\s*=[\s\S]*?"workspace_kind_unresolved"/,
    );
    expect(src).toMatch(
      /options\.antiEnumeration && isMembershipFailure\s*\?\s*404\s*:\s*403/,
    );
  });
});

// =============================================================================
// PART 4 — Compile-time enum guard: the catalog is the source of truth
// =============================================================================

describe("Phase 26 — type-level invariants", () => {
  it("AuthorizationDenialCode is exactly the keyof the bounded array", () => {
    // Compile-time guard — runtime check just confirms the catalog
    // is non-empty and well-formed.
    const sample: AuthorizationDenialCode = "permission_not_granted";
    expect(AUTHORIZATION_DENIAL_CODES).toContain(sample);
  });
});

// =============================================================================
// PART 5 — Privacy + governance invariants
// =============================================================================

describe("Phase 26 — privacy + governance invariants", () => {
  const src = readSource("../../../services/api/src/middleware/authorize.ts");

  it("never references private notes / storage keys / signed URLs / GPS / OTPs", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "privateReviewerNote",
      "legalNoteBody",
      "storageKey",
      "signed_url",
      "raw_gps",
      "gpsCoordinates",
      "otp",
      "OTP",
    ]) {
      expect(noComments).not.toContain(forbidden);
    }
  });

  it("no banned wording (tamper / forged / altered content)", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    const literals = src.match(/"[^"\n]+"/g) ?? [];
    expect(literals.join(" ")).not.toMatch(banned);
  });

  it("metric catalogue registers the three new Phase 26 counters", () => {
    const metricSrc = readSource(
      "../../../packages/shared-runtime/src/ops/metrics.service.ts",
    );
    expect(metricSrc).toContain('"authorize_allowed_total"');
    expect(metricSrc).toContain('"authorize_denied_total"');
    expect(metricSrc).toContain('"authorize_failed_closed_total"');
  });
});
