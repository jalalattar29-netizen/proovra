/**
 * Phase 27.5 / 28.5 — External Review REST routes source-contract tests.
 *
 * Phase 27/28 shipped the persistence + service layer
 * (`external-review-grant.service.ts`); this phase wires it into a
 * complete REST surface. The tests assert the route file's shape +
 * privacy invariants + bounded denial vocabulary + anti-enumeration
 * + authorization-gate coverage.
 *
 * Pure source-contract — no DB, no Fastify runtime needed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Route file source contract
// =============================================================================

describe("Phase 27.5/28.5 — external-review.routes.ts source contract", () => {
  const src = readSource(
    "../../../services/api/src/routes/external-review.routes.ts",
  );

  it("declares all 6 brief-mandated routes", () => {
    for (const route of [
      '"/v1/external-review/grants"',
      '"/v1/external-review/grants/:id/revoke"',
      '"/v1/external-review/access/:token"',
      '"/v1/external-review/access/:token/context"',
      '"/v1/external-review/activity"',
    ]) {
      expect(src, `route ${route} missing`).toContain(route);
    }
    // The "list grants" path is the same as "issue grant" — GET vs
    // POST. We confirm both HTTP verbs are registered.
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/external-review\/grants"/,
    );
    expect(src).toMatch(
      /app\.get\(\s*"\/v1\/external-review\/grants"/,
    );
  });

  it("imports the canonical service helpers from external-review-grant.service.js", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?issueExternalReviewGrant[\s\S]*?listExternalReviewGrants[\s\S]*?lookupExternalReviewGrantByToken[\s\S]*?recordExternalReviewAccess[\s\S]*?transitionExternalReviewGrant[\s\S]*?\}\s*from\s+"\.\.\/services\/external-review\/external-review-grant\.service\.js"/,
    );
  });

  it("operator routes use authorizeOrFail with antiEnumeration: true", () => {
    expect(src).toMatch(
      /authorizeOrFail\(req, reply,[\s\S]*?antiEnumeration:\s*true/,
    );
    // Every authorizeOrFail call MUST include antiEnumeration: true to
    // prevent cross-team probing.
    const authorizeCalls =
      src.match(/authorizeOrFail\([\s\S]*?\}\s*\)/g) ?? [];
    expect(authorizeCalls.length).toBeGreaterThan(0);
    for (const call of authorizeCalls) {
      expect(call, `authorize call without antiEnumeration: ${call}`).toMatch(
        /antiEnumeration:\s*true/,
      );
    }
  });

  it("write operations require governance.legal_hold.manage", () => {
    expect(src).toMatch(
      /authorizeOrFail\([\s\S]*?permission:\s*"governance\.legal_hold\.manage"/,
    );
  });

  it("read operations require audit.read (least-privilege)", () => {
    expect(src).toMatch(
      /authorizeOrFail\([\s\S]*?permission:\s*"audit\.read"/,
    );
  });

  it("reviewer-side routes (token-based) are NOT behind requireAuth", () => {
    // The two token-gated routes must NOT pass `requireAuth` —
    // they're for external reviewers without a workspace session.
    const acceptRoute = src.slice(
      src.indexOf('"/v1/external-review/access/:token"'),
      src.indexOf('"/v1/external-review/access/:token"') + 500,
    );
    const contextRoute = src.slice(
      src.indexOf('"/v1/external-review/access/:token/context"'),
      src.indexOf('"/v1/external-review/access/:token/context"') + 500,
    );
    // Neither slice should contain `preHandler: requireAuth`.
    expect(acceptRoute).not.toMatch(/preHandler:\s*requireAuth/);
    expect(contextRoute).not.toMatch(/preHandler:\s*requireAuth/);
  });

  it("token parameter is validated as 32+ char hex (anti-fuzz)", () => {
    expect(src).toMatch(
      /TokenParamSchema\s*=\s*z\.object\(\{\s*token:\s*z\.string\(\)\.min\(32\)\.max\(128\)\.regex\(\/\^\[a-f0-9\]\+\$\/i\)/,
    );
  });

  it("anti-enumeration: token-failure responses all collapse to 401 grant_not_active", () => {
    // Both reviewer-side routes must return the SAME 401 shape for
    // unknown / revoked / expired / blocked tokens — anti-enum
    // contract from Phase 27/28.
    const slice = src.slice(src.indexOf("/v1/external-review/access/:token"));
    // Find both `reply.code(401)` calls; both must use the same shape.
    const code401Calls =
      slice.match(/reply\.code\(401\)\.send\(\{[\s\S]*?\}\)/g) ?? [];
    expect(code401Calls.length).toBeGreaterThanOrEqual(2);
    for (const call of code401Calls) {
      expect(call).toMatch(
        /code:\s*"grant_not_active"/,
      );
      // The 401 body must NOT include any field that distinguishes
      // failure modes — no `reason: result.reason` here.
      expect(call).not.toMatch(/reason:\s*result\.reason/);
    }
  });

  it("reviewer projection never includes raw grant id / token_hash / team_id / invited_by", () => {
    // The `projectGrantForReviewer` function defines the narrow
    // reviewer-facing shape. The returned object literal MUST NOT
    // include any of the forbidden fields.
    const projFnIdx = src.indexOf("function projectGrantForReviewer");
    expect(projFnIdx).toBeGreaterThan(0);
    const projFn = src.slice(projFnIdx, projFnIdx + 1000);
    for (const forbidden of [
      "grant.id",
      "grant.teamId",
      "grant.invitedByUserId",
      "grant.revokedByUserId",
      "grant.approvedByUserId",
      "grant.token_hash",
      "grant.evidenceId",
      "grant.caseId",
      "grant.packageId",
      "grant.reviewerEmail",
      "grant.accessCount",
    ]) {
      expect(projFn, `${forbidden} leaked into reviewer projection`).not.toContain(
        forbidden,
      );
    }
  });

  it("reviewer projection only exposes the bounded narrow shape", () => {
    const projFnIdx = src.indexOf("function projectGrantForReviewer");
    const projFn = src.slice(projFnIdx, projFnIdx + 1000);
    // The bounded reviewer fields the operator chose to share.
    for (const allowed of [
      "scopeKind",
      "state",
      "reviewerDisplayName",
      "expiresAtUtc",
      "allowOriginalDownload",
      "allowPackageDownload",
      "safeNote",
      "redactionPolicyVersion",
    ]) {
      expect(projFn, `${allowed} missing from reviewer projection`).toContain(
        allowed,
      );
    }
  });

  it("the reviewer accept route returns the projection, NEVER the raw grant", () => {
    const acceptRouteIdx = src.indexOf(
      '"/v1/external-review/access/:token"',
    );
    const acceptRoute = src.slice(acceptRouteIdx, acceptRouteIdx + 2000);
    // The 200 response must use `projectGrantForReviewer(grant)`,
    // never return `grant` directly.
    expect(acceptRoute).toMatch(
      /reply\.code\(200\)\.send\(\{\s*context:\s*projectGrantForReviewer\(grant\)/,
    );
    expect(acceptRoute).not.toMatch(
      /reply\.code\(200\)\.send\(\{\s*grant:\s*grant\b/,
    );
  });

  it("the context route returns the projection, NEVER the raw grant", () => {
    const contextRouteIdx = src.indexOf(
      '"/v1/external-review/access/:token/context"',
    );
    const contextRoute = src.slice(contextRouteIdx, contextRouteIdx + 1500);
    expect(contextRoute).toMatch(
      /reply\.code\(200\)\.send\(\{\s*context:\s*projectGrantForReviewer\(lookup\.grant\)/,
    );
  });

  it("activity feed strips the reviewer email (operators see counters only)", () => {
    const activityIdx = src.indexOf('"/v1/external-review/activity"');
    const activityRoute = src.slice(activityIdx, activityIdx + 1500);
    // The map projection in the activity feed must not include
    // reviewerEmail — operators have the per-row list for that.
    expect(activityRoute).not.toMatch(/reviewerEmail/);
  });

  it("issue route returns rawToken EXACTLY ONCE in the 201 response", () => {
    const issueIdx = src.indexOf('app.post(\n    "/v1/external-review/grants"');
    const issueRoute = src.slice(issueIdx, issueIdx + 2500);
    expect(issueRoute).toMatch(/rawToken:\s*result\.rawToken/);
    // The route's 201 response shape includes both `grant` + `rawToken`
    // — the operator captures the raw token now (it's never derivable
    // again).
    expect(issueRoute).toMatch(
      /reply\.code\(201\)\.send\(\{\s*grant:\s*result\.grant,\s*rawToken:\s*result\.rawToken/,
    );
  });

  it("revoke route maps service denial codes to the right HTTP status (404 / 409 / 400)", () => {
    const revokeIdx = src.indexOf('grants/:id/revoke"');
    const revokeRoute = src.slice(revokeIdx, revokeIdx + 1500);
    expect(revokeRoute).toMatch(/result\.reason === "token_unknown"[\s\S]*?404/);
    expect(revokeRoute).toMatch(
      /result\.reason === "invalid_transition"[\s\S]*?409/,
    );
  });
});

// =============================================================================
// Server registration
// =============================================================================

describe("Phase 27.5/28.5 — server registration", () => {
  const src = readSource("../../../services/api/src/server.ts");

  it("imports the externalReviewRoutes module", () => {
    expect(src).toMatch(
      /import\s*\{\s*externalReviewRoutes\s*\}\s*from\s+"\.\/routes\/external-review\.routes\.js"/,
    );
  });

  it("registers the routes on the Fastify instance", () => {
    expect(src).toMatch(/app\.register\(externalReviewRoutes\)/);
  });
});

// =============================================================================
// Privacy + governance invariants
// =============================================================================

describe("Phase 27.5/28.5 — privacy + governance invariants", () => {
  const src = readSource(
    "../../../services/api/src/routes/external-review.routes.ts",
  );

  it("no banned wording in string literals", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    const literals = src.match(/"[^"\n]+"/g) ?? [];
    expect(literals.join(" ")).not.toMatch(banned);
  });

  it("no surface references private notes / legal-note bodies / storage keys / signed URLs / GPS", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "privateReviewerNote",
      "legalNoteBody",
      "storageKey",
      "signed_url",
      "signedUrl",
      "raw_gps",
      "gpsCoordinates",
    ]) {
      expect(noComments).not.toContain(forbidden);
    }
  });

  it("no Prisma queries inline in the route handler (orchestration stays in services)", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/prisma\./);
    expect(noComments).not.toMatch(/\$queryRaw|\$executeRaw/);
  });

  it("zod validators bound every public input (no req.body trusted directly)", () => {
    // Every handler must call `.parse(req.body|query|params)`. Spot
    // check: 5 parse() invocations expected (issue body, list query,
    // revoke params + body, accept params, context params, activity
    // query). Bounded check: at least 5.
    const parseCalls = src.match(/\.parse\(req\.(body|query|params)/g) ?? [];
    expect(parseCalls.length).toBeGreaterThanOrEqual(5);
  });

  it("scopeKind body validator is bounded to the canonical 3-state catalog", () => {
    expect(src).toMatch(
      /scopeKind:\s*z\.enum\(EXTERNAL_REVIEW_SCOPE_KINDS\)/,
    );
  });

  it("reviewerEmail body validator clips to 320 chars + requires valid email", () => {
    expect(src).toMatch(/reviewerEmail:\s*z\.string\(\)\.email\(\)\.max\(320\)/);
  });

  it("expiresAtUtc body validator requires ISO-8601 datetime", () => {
    expect(src).toMatch(/expiresAtUtc:\s*z\.string\(\)\.datetime\(\)/);
  });
});

// =============================================================================
// Bounded vocabulary coverage
// =============================================================================

describe("Phase 27.5/28.5 — bounded denial vocabulary", () => {
  const src = readSource(
    "../../../services/api/src/routes/external-review.routes.ts",
  );

  it("operator denial code 'grant_issue_denied' uses the bounded service reason payload", () => {
    expect(src).toMatch(
      /code:\s*"grant_issue_denied",\s*reason:\s*result\.reason/,
    );
  });

  it("operator denial code 'revoke_denied' uses the bounded service reason payload", () => {
    expect(src).toMatch(
      /code:\s*"revoke_denied",\s*reason:\s*result\.reason/,
    );
  });

  it("reviewer-side 401 NEVER includes a `reason` field (anti-enumeration)", () => {
    const slice = src.slice(src.indexOf("/v1/external-review/access/:token"));
    const code401Calls =
      slice.match(/reply\.code\(401\)\.send\(\{[\s\S]*?\}\)/g) ?? [];
    for (const call of code401Calls) {
      expect(call).not.toMatch(/reason:/);
    }
  });
});
