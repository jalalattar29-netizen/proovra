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
  it("loads memberships with status=ACTIVE only (excludes SUSPENDED / REVOKED)", () => {
    expect(BLOCK).toMatch(
      /prisma\.teamMember\.findMany\(\{\s*\n?\s*where:\s*\{[\s\S]{0,200}?status:\s*prismaPkg\.TeamMemberStatus\.ACTIVE/,
    );
  });

  it("loads the evidence with a read-access where clause (owner OR active team-member OR case-based)", () => {
    // The evidence query must AND the id with an OR over the three
    // accepted access paths. Source-pin the shape; this is the
    // anti-IDOR guard so the eligibility endpoint cannot leak the
    // existence of an evidence record the user can't see.
    expect(BLOCK).toMatch(
      /prisma\.evidence\.findFirst\(\{\s*\n?\s*where:\s*\{\s*\n?\s*id:\s*eligibleForEvidenceId,\s*\n?\s*OR:\s*\[\s*\n?\s*\{\s*ownerUserId\s*\}/,
    );
    // The team-member branch is gated on the ACTIVE list being
    // non-empty — proven by the `activeMemberTeamIds.length > 0`
    // conditional spread.
    expect(BLOCK).toMatch(
      /activeMemberTeamIds\.length > 0\s*\n?\s*\?\s*\[\{\s*teamId:\s*\{\s*in:\s*activeMemberTeamIds\s*\}\s*\}\]/,
    );
    // Track 1B closure — case-based access is expressed via the
    // canonical caseLinks relation over the pre-computed
    // `accessibleCaseIds` list.
    expect(BLOCK).toMatch(
      /accessibleCaseIds\.length > 0\s*\n?\s*\?\s*\[\{\s*caseLinks:\s*\{\s*some:\s*\{\s*caseId:\s*\{\s*in:\s*accessibleCaseIds\s*\}\s*\}\s*\}\s*\}\]/,
    );
  });

  it("pre-computes accessibleCaseIds via the same OR-union used by the eligibility case query", () => {
    expect(BLOCK).toMatch(
      /const accessibleCases = await prisma\.case\.findMany\(\{\s*\n?\s*where:\s*\{\s*\n?\s*OR:\s*\[\s*\n?\s*\{\s*ownerUserId\s*\},\s*\n?\s*\{\s*access:\s*\{\s*some:\s*\{\s*userId:\s*ownerUserId\s*\}\s*\}\s*\}/,
    );
  });

  it("returns 404 EVIDENCE_NOT_FOUND when the read-access query returns null (anti-enumeration)", () => {
    expect(BLOCK).toMatch(/if \(!evidence\)/);
    expect(BLOCK).toMatch(
      /reply\.code\(404\)\.send\(\{\s*\n?\s*code:\s*"EVIDENCE_NOT_FOUND",/,
    );
  });

  it("case query: AND-narrowed by teamId equality + status NOT IN (ARCHIVED, CLOSED) + OR-union", () => {
    // The Case model has no `archivedAt` / `deletedAt` columns —
    // lifecycle is tracked via the `status` enum. The eligibility
    // filter excludes ARCHIVED and CLOSED so the dropdown can only
    // offer cases the attach gate would actually accept.
    expect(BLOCK).toMatch(
      /prisma\.case\.findMany\(\{\s*\n?\s*where:\s*\{\s*\n?\s*AND:\s*\[/,
    );
    expect(BLOCK).toMatch(/\{ teamId: evidence\.teamId \}/);
    expect(BLOCK).toMatch(/status:\s*\{[\s\S]{0,40}?notIn:\s*\[/);
    expect(BLOCK).toMatch(/prismaPkg\.CaseStatus\.ARCHIVED/);
    expect(BLOCK).toMatch(/prismaPkg\.CaseStatus\.CLOSED/);
    expect(BLOCK).toMatch(/\{ OR: eligibleOr \}/);
  });

  it("user-access OR-union in eligibility mode uses the SAME shape as the default branch but with ACTIVE memberships", () => {
    expect(BLOCK).toMatch(
      /const eligibleOr:\s*Array<Record<string, unknown>> = \[\s*\n?\s*\{ ownerUserId \},\s*\n?\s*\{ access:\s*\{ some:\s*\{ userId: ownerUserId \} \} \},\s*\n?\s*\];/,
    );
    // The team-member arm is added only when there ARE active teams.
    expect(BLOCK).toMatch(
      /if \(activeMemberTeamIds\.length > 0\) \{\s*\n?\s*eligibleOr\.push\(\{\s*\n?\s*teamId:\s*\{ in: activeMemberTeamIds \},\s*\n?\s*access:\s*\{ none: \{\} \},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
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
  it("default branch filters memberships to `status: ACTIVE` (suspended/revoked members are denied team-scoped visibility)", () => {
    // (P0 remediation 2026-07-21) — this test previously pinned the
    // status-blind back-compat behaviour. The Prisma schema mandates
    // that every access check MUST reject anything other than ACTIVE,
    // so the default branch now filters ACTIVE like the eligibility
    // branch does. The default branch's `prisma.teamMember.findMany`
    // is the SECOND such call in the route.
    const defaultMemberCall = BLOCK.slice(
      BLOCK.lastIndexOf("const memberTeams = await prisma.teamMember.findMany"),
    );
    // Status filter present in this where clause.
    const whereBlock =
      defaultMemberCall.slice(
        defaultMemberCall.indexOf("where:"),
        defaultMemberCall.indexOf("select:"),
      );
    expect(whereBlock).toMatch(/userId:\s*ownerUserId/);
    expect(whereBlock).toMatch(/status:\s*"ACTIVE"/);
  });

  it("default branch case findMany STILL has NO archivedAt / deletedAt exclusion (back-compat)", () => {
    // The eligibility-mode `prisma.case.findMany` comes first; the
    // default one is the second occurrence in the route.
    const lastCaseFindMany = BLOCK.slice(
      BLOCK.lastIndexOf("prisma.case.findMany"),
    );
    // Read the where block of THIS findMany call only.
    const whereStart = lastCaseFindMany.indexOf("where:");
    const orderByStart = lastCaseFindMany.indexOf("orderBy:");
    expect(orderByStart).toBeGreaterThan(whereStart);
    const whereSlice = lastCaseFindMany.slice(whereStart, orderByStart);
    expect(whereSlice).toMatch(/\{ OR: or \}/);
    // The forbidden additions:
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
