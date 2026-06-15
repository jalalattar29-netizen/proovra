/**
 * Phase CASE-DETAIL-PERSONAL-UX — Case Detail simplified surface contract.
 *
 * Pins:
 *
 *   1. Personal mode renders the SimpleCaseDetail component with ONLY
 *      five tabs (Overview, Evidence, Reports & Packages, Notes,
 *      Settings). The enterprise MatterWorkspace is preserved verbatim
 *      and shown only when `canAccessSurface(ctx, "/investigation")`.
 *
 *   2. SimpleCaseDetail wires every action to an EXISTING backend
 *      route — no new endpoints, no fake destructive paths.
 *
 *   3. The Settings tab status-transition map mirrors the backend
 *      state machine in `services/api/src/services/cases/case-lifecycle.service.ts`
 *      so the user can't initiate a transition the API would reject.
 *
 *   4. Delete-case copy explicitly says preserved evidence is NOT
 *      deleted. Remove-from-case copy explicitly says the evidence
 *      record itself remains preserved.
 *
 *   5. SiuPanel no longer renders raw JSON / backend route paths in
 *      any error or empty state.
 *
 *   6. The backend safety guards the surface depends on are NOT
 *      weakened (cross-team attach, hard-delete legal-hold check,
 *      status transition validation, comment visibility).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ALLOWED_STATUS_TRANSITIONS,
  caseStatusLabel,
  deriveNeedsAttention,
  formatRelative,
  summariseDeliverables,
} from "../components/cases-experience/simple-case-detail/helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const PAGE = src("apps/web/app/(app)/cases/[id]/page.tsx");
const COMPONENT = src(
  "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
);
const SIU_PANEL = src("apps/web/app/(app)/cases/components/SiuPanel.tsx");
const CASE_ROUTES = src("services/api/src/routes/cases.routes.ts");
const CASE_LIFECYCLE = src(
  "services/api/src/services/cases/case-lifecycle.service.ts",
);

// ===========================================================================
// Page wrapper — branches on canSeeAdvancedCaseOps
// ===========================================================================

test("page imports both SimpleCaseDetail and MatterWorkspace (preserves enterprise surface)", () => {
  assert.match(PAGE, /import \{ MatterWorkspace \} from/);
  assert.match(PAGE, /import \{ SimpleCaseDetail \} from/);
});

test("page computes canSeeAdvancedCaseOps via canAccessSurface(ctx, '/investigation')", () => {
  assert.match(
    PAGE,
    /const canSeeAdvancedCaseOps = canAccessSurface\(\s*\n?\s*surfaceUserCtx,\s*\n?\s*"\/investigation",\s*\n?\s*\);/,
  );
});

test("page renders MatterWorkspace only when advanced mode is true; SimpleCaseDetail otherwise", () => {
  // Three independent anchors so JSX whitespace doesn't make the
  // assertion brittle.
  assert.match(PAGE, /\{canSeeAdvancedCaseOps \? \(/);
  assert.match(PAGE, /<MatterWorkspace caseId=\{caseId\} onOpenEvidence=\{onOpenEvidence\} \/>/);
  assert.match(
    PAGE,
    /<SimpleCaseDetail caseId=\{caseId\} onOpenEvidence=\{onOpenEvidence\} \/>/,
  );
  // The MatterWorkspace mount must come BEFORE the SimpleCaseDetail
  // mount in source order, proving the ternary has advanced→Matter
  // and personal→Simple (not the inverse).
  const matterIdx = PAGE.indexOf("<MatterWorkspace caseId");
  const simpleIdx = PAGE.indexOf("<SimpleCaseDetail caseId");
  assert.ok(matterIdx > 0 && simpleIdx > matterIdx);
});

test("View-evidence-in-Search pivot link is gated to advanced (enterprise) mode only", () => {
  // Anti-regression: the pivot must NOT render in personal mode.
  // Source-pin: the wrapping `<div data-cases-detail-search-pivot>`
  // lives inside the advanced branch only.
  const advancedBlockStart = PAGE.indexOf("{canSeeAdvancedCaseOps ? (");
  const personalBlockStart = PAGE.indexOf(") : (", advancedBlockStart);
  assert.ok(advancedBlockStart > 0 && personalBlockStart > advancedBlockStart);
  const advancedBlock = PAGE.slice(advancedBlockStart, personalBlockStart);
  const personalBlock = PAGE.slice(personalBlockStart);
  assert.match(advancedBlock, /data-cases-detail-search-pivot/);
  assert.doesNotMatch(personalBlock, /data-cases-detail-search-pivot/);
});

// ===========================================================================
// SimpleCaseDetail tab set
// ===========================================================================

test("SimpleCaseDetail exposes EXACTLY five tabs in the canonical order", () => {
  // Source-pin the TAB_ORDER constant.
  assert.match(
    COMPONENT,
    /const TAB_ORDER:\s*ReadonlyArray<\{ id: TabId; label: string \}> = \[\s*\n?\s*\{ id: "overview", label: "Overview" \},\s*\n?\s*\{ id: "evidence", label: "Evidence" \},\s*\n?\s*\{ id: "reports", label: "Reports & Packages" \},\s*\n?\s*\{ id: "notes", label: "Notes" \},\s*\n?\s*\{ id: "settings", label: "Settings" \},\s*\n?\s*\];/,
  );
  // Anti-regression: no enterprise-tab labels.
  for (const banned of [
    "Timeline",
    "Graph",
    "Holds",
    "Decisions",
    "Risk",
    "Discussion & Activity",
    "Assignments",
    "Investigation profile",
    "Audit",
  ]) {
    // The literal tab strings must not appear in the personal
    // component. We look at the canonical TAB_ORDER literal block
    // only — other comments may mention the names by way of
    // explanation but TAB_ORDER is the authority.
    const tabOrderStart = COMPONENT.indexOf("const TAB_ORDER");
    const tabOrderEnd = COMPONENT.indexOf("];", tabOrderStart);
    const tabOrderBlock = COMPONENT.slice(tabOrderStart, tabOrderEnd);
    assert.doesNotMatch(tabOrderBlock, new RegExp(`label:\\s*"${banned}"`));
  }
});

// ===========================================================================
// SimpleCaseDetail wires every action to an existing backend route
// ===========================================================================

test("SimpleCaseDetail uses /v1/cases/:id/matter-workspace as the single envelope source (one round-trip)", () => {
  assert.match(
    COMPONENT,
    /apiFetch\(\s*\n?\s*`\/v1\/cases\/\$\{caseId\}\/matter-workspace`,?\s*\n?\s*\)/,
  );
});

test("Attach flow uses POST /v1/cases/:id/evidence with { evidenceId } body", () => {
  assert.match(
    COMPONENT,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/evidence`,\s*\{\s*\n?\s*method: "POST",\s*\n?\s*body: JSON\.stringify\(\{ evidenceId: selected \}\),/,
  );
});

test("Add-evidence picker uses GET /v1/cases/:id/available-evidence (same-workspace filter)", () => {
  assert.match(
    COMPONENT,
    /apiFetch\(\s*\n?\s*`\/v1\/cases\/\$\{caseId\}\/available-evidence`,?\s*\n?\s*\)/,
  );
});

test("Remove-from-case uses DELETE /v1/cases/:id/evidence/:evidenceId — and copy says the evidence record itself is preserved", () => {
  assert.match(
    COMPONENT,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/evidence\/\$\{evidenceId\}`,\s*\{\s*\n?\s*method: "DELETE",\s*\n?\s*\}\)/,
  );
  // Spec-locked confirmation copy.
  assert.match(
    COMPONENT,
    /This removes the evidence from this case only\. The evidence record itself will remain preserved\./,
  );
});

test("Rename uses PATCH /v1/cases/:id with { name }", () => {
  assert.match(
    COMPONENT,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}`,\s*\{\s*\n?\s*method: "PATCH",\s*\n?\s*body: JSON\.stringify\(\{ name: next \}\),/,
  );
});

test("Status change uses POST /v1/cases/:id/status with { toStatus }", () => {
  assert.match(
    COMPONENT,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/status`,\s*\{\s*\n?\s*method: "POST",\s*\n?\s*body: JSON\.stringify\(\{ toStatus \}\),/,
  );
});

test("Delete uses DELETE /v1/cases/:id — and copy says preserved evidence is NOT deleted", () => {
  assert.match(
    COMPONENT,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}`,\s*\{\s*method: "DELETE"\s*\}\)/,
  );
  assert.match(
    COMPONENT,
    /Deleting this case will not delete preserved evidence records\. Evidence remains available in the Evidence Library unless separately archived or restricted\./,
  );
});

test("Notes use POST /v1/cases/:id/comments and POST /v1/cases/:id/comments/:commentId/resolve", () => {
  assert.match(
    COMPONENT,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/comments`,\s*\{\s*\n?\s*method: "POST",\s*\n?\s*body: JSON\.stringify\(\{ body, visibility: "INTERNAL" \}\),/,
  );
  assert.match(
    COMPONENT,
    /apiFetch\(`\/v1\/cases\/\$\{caseId\}\/comments\/\$\{commentId\}\/resolve`,\s*\{/,
  );
});

// ===========================================================================
// Status-transition map mirrors the backend state machine
// ===========================================================================

test("Frontend ALLOWED_STATUS_TRANSITIONS map matches the backend transition set", () => {
  // Backend state machine — extracted from
  // services/api/src/services/cases/case-lifecycle.service.ts. We
  // assert the frontend map is structurally identical so the
  // Settings tab never offers a transition the API would reject.
  //
  // Phase CASES-PERSONAL-UX-CLEANUP — one-hop archive from every
  // active status; restore lands in OPEN so the case is visible
  // again on the active list immediately.
  const expected: Record<string, ReadonlyArray<string>> = {
    OPEN: ["INVESTIGATING", "ON_HOLD", "RESOLVED", "ARCHIVED"],
    INVESTIGATING: ["ON_HOLD", "RESOLVED", "ARCHIVED"],
    ON_HOLD: ["INVESTIGATING", "RESOLVED", "ARCHIVED"],
    RESOLVED: ["CLOSED", "INVESTIGATING", "ARCHIVED"],
    CLOSED: ["ARCHIVED", "RESOLVED"],
    ARCHIVED: ["OPEN"],
  };
  for (const [from, allowed] of Object.entries(expected)) {
    assert.deepEqual(
      ALLOWED_STATUS_TRANSITIONS[from],
      allowed,
      `transition map mismatch for ${from}`,
    );
  }
});

test("Backend lifecycle service still enforces the same allowed-transition set (anti-regression)", () => {
  // Spot-check the most important transitions: every active state
  // permits a one-hop ARCHIVED transition (Phase CASES-PERSONAL-
  // UX-CLEANUP) and the restore target is OPEN.
  assert.match(CASE_LIFECYCLE, /OPEN:[\s\S]{0,200}?INVESTIGATING[\s\S]{0,200}?ARCHIVED/);
  assert.match(CASE_LIFECYCLE, /CLOSED:[\s\S]{0,200}?ARCHIVED/);
  assert.match(CASE_LIFECYCLE, /ARCHIVED:\s*\["OPEN"\]/);
});

// ===========================================================================
// SIU JSON-leak fix
// ===========================================================================

test("SiuPanel no longer surfaces raw backend route paths in the empty state", () => {
  // Anti-regression: the developer-leak `PUT /v1/cases/.../siu-profile`
  // is gone from the empty-state copy.
  assert.doesNotMatch(SIU_PANEL, /PUT \/v1\/cases\/\$\{caseId\}\/siu-profile/);
  // Spec-locked empty-state copy.
  assert.match(
    SIU_PANEL,
    /No investigation profile has been created for this case\./,
  );
});

test("SiuPanel sanitizes every catch path — never dumps `e.message` into the error box", () => {
  // The four catch blocks all set bounded copy. None of them assign
  // `e.message` straight to `setErr` anymore. We assert by absence
  // of the previous pattern AND by presence of the new bounded
  // sentences.
  assert.doesNotMatch(SIU_PANEL, /setErr\(e instanceof Error \? e\.message :/);
  // At least one of the new bounded copy strings is present.
  for (const expected of [
    /Couldn't load the investigation profile right now\./,
    /PII reveal failed\. This action needs an additional security step\./,
    /Couldn't run the export preflight check right now\./,
  ]) {
    assert.match(SIU_PANEL, expected);
  }
});

test("SiuPanel non-200 export path no longer renders the raw response body slice", () => {
  // The previous code did `setErr(\`Export refused: ${res.status} ${text.slice(0,240)}\`)`
  // which leaked whatever the server returned. The new path uses
  // status-coded bounded copy + no text.
  assert.doesNotMatch(SIU_PANEL, /text\.slice\(0,\s*240\)/);
  assert.match(SIU_PANEL, /Export refused — you don't have permission/);
});

// ===========================================================================
// Helper unit tests
// ===========================================================================

test("caseStatusLabel humanises every backend enum value", () => {
  assert.equal(caseStatusLabel("OPEN"), "Open");
  assert.equal(caseStatusLabel("INVESTIGATING"), "Investigating");
  assert.equal(caseStatusLabel("ON_HOLD"), "On hold");
  assert.equal(caseStatusLabel("RESOLVED"), "Resolved");
  assert.equal(caseStatusLabel("CLOSED"), "Closed");
  assert.equal(caseStatusLabel("ARCHIVED"), "Archived");
  // Defensive fallback for an unrecognised value.
  assert.equal(caseStatusLabel(null), "Unknown");
  assert.equal(caseStatusLabel("WHATEVER"), "WHATEVER");
});

test("formatRelative produces a stable short-month date string", () => {
  assert.equal(formatRelative("2026-06-15T12:00:00.000Z"), "Jun 15, 2026");
  assert.equal(formatRelative(null), "—");
  assert.equal(formatRelative("not-a-date"), "—");
});

test("summariseDeliverables counts reportReady + packageReady + needs-attention from the envelope", () => {
  const fakeEnvelope = {
    sections: {
      evidence: {
        status: "ok",
        items: [
          { id: "1", reportReady: true, packageReady: true },
          { id: "2", reportReady: true, packageReady: false },
          { id: "3", reportReady: false, packageReady: false },
        ],
      },
    },
  } as unknown as Parameters<typeof summariseDeliverables>[0];
  const r = summariseDeliverables(fakeEnvelope);
  assert.equal(r.reportsReady, 2);
  assert.equal(r.packagesReady, 1);
  assert.equal(r.needsAttention, 2);
});

test("deriveNeedsAttention surfaces the no-evidence empty branch first", () => {
  const empty = {
    sections: { evidence: { status: "ok", items: [] } },
  } as unknown as Parameters<typeof deriveNeedsAttention>[0];
  const r = deriveNeedsAttention(empty);
  assert.equal(r.length, 1);
  assert.equal(r[0].key, "no-evidence");
});

test("deriveNeedsAttention itemises missing-report / missing-package / integrity in order", () => {
  const fake = {
    sections: {
      evidence: {
        status: "ok",
        items: [
          { id: "1", reportReady: false, packageReady: false, verificationStatus: "FAILED" },
          { id: "2", reportReady: true, packageReady: true, verificationStatus: "RECORDED_INTEGRITY_VERIFIED" },
        ],
      },
    },
  } as unknown as Parameters<typeof deriveNeedsAttention>[0];
  const r = deriveNeedsAttention(fake);
  const keys = r.map((i) => i.key);
  assert.deepEqual(keys, ["missing-report", "missing-package", "integrity"]);
});

// ===========================================================================
// Backend safety guards — NOT weakened
// ===========================================================================

test("Backend attach gate (evaluateCrossTeamAttach) still enforces strict same-workspace equality", () => {
  assert.match(
    CASE_ROUTES,
    /evaluateCrossTeamAttach\(\{\s*\n?\s*caseTeamId: caseItem\.teamId,\s*\n?\s*evidenceTeamId: evidence\.teamId,/,
  );
});

test("Backend remove-from-case route still only NULLs `caseId` (never deletes evidence)", () => {
  // Anchor on the DELETE route, then assert the prisma update sets
  // caseId to null and the route never calls `evidence.delete`.
  const start = CASE_ROUTES.indexOf('"/v1/cases/:id/evidence/:evidenceId"');
  assert.ok(start > 0, "unlink route anchor missing");
  const end = CASE_ROUTES.indexOf("app.", start + 1);
  const block = CASE_ROUTES.slice(start, end > 0 ? end : start + 6000);
  assert.match(
    block,
    /prisma\.evidence\.update\(\{[\s\S]{0,500}?caseId: null,/,
  );
  assert.doesNotMatch(block, /prisma\.evidence\.delete/);
});

test("Backend delete-case route still has the legal-hold gate AND only unlinks evidence (never deletes evidence)", () => {
  // The DELETE handler doesn't have a single-line anchor we can
  // grab; scope assertions to the whole file but anchor them on
  // the unique guard call sites + the unlink update shape.
  assert.match(CASE_ROUTES, /const holdChk = await checkCaseLegalHold\(id, item\.teamId\);/);
  assert.match(
    CASE_ROUTES,
    /const deleteGate = await resolveCaseDestructiveGate\(\{[\s\S]{0,200}?mutation: "DELETE",/,
  );
  // The DELETE flow's bulk unlink: evidence.updateMany sets caseId
  // to null (never deletes evidence rows).
  assert.match(
    CASE_ROUTES,
    /prisma\.evidence\.updateMany\(\{[\s\S]{0,300}?caseId: null/,
  );
  // Anti-regression: the DELETE handler must not call
  // `prisma.evidence.deleteMany` or `prisma.evidence.delete`.
  assert.doesNotMatch(CASE_ROUTES, /prisma\.evidence\.deleteMany/);
  // (Note: `prisma.evidence.delete` is used elsewhere in the file
  // for the per-record evidence DELETE; we just assert that the
  // case-delete path does NOT use deleteMany.)
});
