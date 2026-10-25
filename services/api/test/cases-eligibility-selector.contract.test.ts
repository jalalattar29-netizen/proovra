/**
 * Phase ASSIGN-CASE-ELIGIBILITY — GET /v1/cases?eligibleForEvidenceId contract.
 *
 * Source-pinned. Asserts every invariant the production bug audit
 * called out:
 *
 *   1. The endpoint accepts an optional `eligibleForEvidenceId`
 *      query parameter validated as a UUID. Invalid UUIDs (or
 *      missing) fall through to the existing default branch.
 *
 *   2. When the parameter is PRESENT:
 *
 *      a. Memberships are loaded with `status: ACTIVE` only —
 *         suspended / revoked members no longer see their old
 *         team's cases in the selector.
 *
 *      b. The evidence is loaded with a read-access guard that
 *         mirrors `getEvidenceWithReadAccess` (owner OR ACTIVE
 *         team-member OR case-based access). A miss returns 404
 *         EVIDENCE_NOT_FOUND (no enumeration).
 *
 *      c. The case-eligibility WHERE clause is
 *           AND[ {teamId: evidence.teamId},
 *                {archivedAt: null},
 *                {deletedAt: null},
 *                {OR: [user-access OR-union]} ]
 *
 *      d. The user-access OR-union inside eligibility mode uses
 *         the same shape as the default branch (owner / case_access
 *         / team-member-with-no-explicit-access) but keyed off
 *         ACTIVE memberships only.
 *
 *      e. Response includes a `mode: "eligibility"` marker in the
 *         audit metadata for forensic correlation.
 *
 *   3. When the parameter is ABSENT the existing behaviour is
 *      preserved verbatim:
 *
 *      a. NO `status: ACTIVE` filter on memberships (back-compat —
 *         no behaviour change for any existing client).
 *
 *      b. NO `archivedAt` / `deletedAt` exclusion (back-compat).
 *
 *      c. Same `OR-union` shape as before.
 *
 *   4. The attach gate (`evaluateCrossTeamAttach`) is unchanged —
 *      the source-pinned check from a prior phase still holds. The
 *      eligibility selector is additive narrowing; the gate stays
 *      authoritative if any client bypasses the UI.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROUTES = readFileSync(
  resolve(__dirname, "..", "src", "routes", "cases.routes.ts"),
  "utf8",
);
const PERMISSION_SVC = readFileSync(
  resolve(
    __dirname,
    "..",
    "src",
    "services",
    "cases",
    "case-permission.service.ts",
  ),
  "utf8",
);

// Find the bounds of the GET /v1/cases route handler so the regex
// assertions only see the eligibility code (not the unrelated POST
// or :id routes further down the file).
function casesListRouteBlock(): string {
  const start = ROUTES.indexOf('app.get("/v1/cases", { preHandler:');
  expect(start).toBeGreaterThan(0);
  // The route closes before the next `/v1/cases/:id` GET route.
  // `indexOf` ignores whitespace so we anchor on the path literal
  // which is stable across formatting changes.
  const end = ROUTES.indexOf('"/v1/cases/:id"', start);
  expect(end).toBeGreaterThan(start);
  return ROUTES.slice(start, end);
}

const BLOCK = casesListRouteBlock();

describe("GET /v1/cases?eligibleForEvidenceId — parsing + dispatch", () => {
  it("validates the parameter as an optional UUID via Zod (invalid input falls through to default)", () => {
    expect(BLOCK).toMatch(
      /z\s*\.object\(\{\s*eligibleForEvidenceId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)\s*\}\)\s*\.safeParse/,
    );
  });

  it("branches into eligibility mode only when the parsed UUID is present", () => {
    expect(BLOCK).toMatch(/if \(eligibleForEvidenceId\) \{/);
  });
});

describe("Eligibility branch — memberships, evidence guard, case query", () => {
  /*
   * MEMBERS AUDIT ACC-03 / ACC-04 (2026-10-25). These cases pinned the old
   * shape — an OR of "evidence I own", "my ACTIVE workspaces" and "cases I own
   * or was granted" — and that shape WAS the defect: its owner and case arms
   * carried no membership condition, so a removed or suspended member kept
   * reaching those records. The branch now asks the two canonical authorities:
   * which workspaces (accessible-workspace authority: ACTIVE, unexpired, live
   * organization) and which records inside them (the restricted-case rule,
   * which Evidence inherits). The pins below hold it to that.
   */
  it("derives its workspaces from the canonical accessible-workspace authority", () => {
    expect(BLOCK).toMatch(/const accessibleWorkspaceIds = await accessibleWorkspaceIdsFor\(ownerUserId\);/);
    expect(BLOCK).not.toMatch(/activeMemberTeamIds/);
  });

  it("loads the evidence only through the canonical evidence reach (anti-IDOR)", () => {
    expect(BLOCK).toMatch(
      /prisma\.evidence\.findFirst\(\{\s*where:\s*\{\s*AND:\s*\[\{ id: eligibleForEvidenceId \}, evidenceReachWhere\(ownerUserId, accessibleWorkspaceIds\)\]/,
    );
    // No arm may stand in for membership.
    expect(BLOCK).not.toMatch(/OR:\s*\[\s*\n?\s*\{\s*ownerUserId\s*\}/);
  });

  it("returns 404 EVIDENCE_NOT_FOUND when the read-access query returns null (anti-enumeration)", () => {
    expect(BLOCK).toMatch(/if \(!evidence\)/);
    expect(BLOCK).toMatch(
      /reply\.code\(404\)\.send\(\{\s*\n?\s*code:\s*"EVIDENCE_NOT_FOUND",/,
    );
  });

  it("case query: AND-narrowed by teamId equality + status NOT IN (ARCHIVED, CLOSED) + the canonical case reach", () => {
    expect(BLOCK).toMatch(/prisma\.case\.findMany\(\{\s*\n?\s*where:\s*\{\s*\n?\s*AND:\s*\[/);
    expect(BLOCK).toMatch(/\{ teamId: evidence\.teamId \}/);
    expect(BLOCK).toMatch(/status:\s*\{[\s\S]{0,40}?notIn:\s*\[/);
    expect(BLOCK).toMatch(/prismaPkg\.CaseStatus\.ARCHIVED/);
    expect(BLOCK).toMatch(/prismaPkg\.CaseStatus\.CLOSED/);
    expect(BLOCK).toMatch(/caseReachWhere\(ownerUserId, accessibleWorkspaceIds\)/);
  });

  it("audit log records the eligibility mode for forensic correlation", () => {
    expect(BLOCK).toMatch(/mode:\s*"eligibility"/);
    // The success metadata must include the eligibleForEvidenceId so
    // any cross-workspace 403 toast can be traced back to a selector
    // request that did/did not narrow correctly.
    expect(BLOCK).toMatch(
      /metadata:\s*\{\s*\n?\s*count:\s*eligibleItems\.length,\s*\n?\s*mode:\s*"eligibility",\s*\n?\s*eligibleForEvidenceId,/,
    );
  });
});

describe("Default branch — ACTIVE-only membership (P0 remediation 2026-07-21)", () => {
  it("default branch scopes through the canonical authorities (no status-blind arm)", () => {
    // Members audit ACC-04 — the same two authorities as the eligibility branch.
    const lastCaseFindMany = BLOCK.slice(BLOCK.lastIndexOf("prisma.case.findMany"));
    const whereSlice = lastCaseFindMany.slice(
      lastCaseFindMany.indexOf("where:"),
      lastCaseFindMany.indexOf("orderBy:"),
    );
    expect(whereSlice).toMatch(/caseReachWhere\(ownerUserId, accessibleWorkspaceIds\)/);
    expect(whereSlice).not.toMatch(/archivedAt/);
    expect(whereSlice).not.toMatch(/deletedAt/);
  });

  it("default branch still returns up to 200 cases (Phase 37.95 cap preserved)", () => {
    const lastCaseFindMany = BLOCK.slice(
      BLOCK.lastIndexOf("prisma.case.findMany"),
    );
    expect(lastCaseFindMany).toMatch(/take:\s*200/);
  });
});

describe("Backend attach gate — NOT weakened by the selector change", () => {
  it("evaluateCrossTeamAttach still uses strict caseTeamId === evidenceTeamId equality", () => {
    expect(PERMISSION_SVC).toMatch(
      /if \(input\.caseTeamId === input\.evidenceTeamId\) \{\s*\n?\s*return \{ allowed: true \};/,
    );
  });

  it("evaluateCrossTeamAttach still emits the CROSS_TEAM_ATTACH_BLOCKED code on mismatch", () => {
    expect(PERMISSION_SVC).toMatch(/code:\s*"CROSS_TEAM_ATTACH_BLOCKED"/);
  });

  it("POST /v1/cases/:id/evidence still calls evaluateCrossTeamAttach + returns the 403 cross-workspace error on mismatch", () => {
    expect(ROUTES).toMatch(/evaluateCrossTeamAttach\(\{[\s\S]{0,200}?caseTeamId: caseItem\.teamId,[\s\S]{0,200}?evidenceTeamId: evidence\.teamId,/);
    expect(ROUTES).toMatch(/reply\.code\(403\)\.send\(\{\s*\n?\s*message:\s*"Cross-workspace attach is not permitted\."/);
  });
});
