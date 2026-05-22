/**
 * Phase 32.8D-frontend-closure-2 — Cases final hardening.
 *
 * Pinned invariants:
 *
 *   1. Legacy `Evidence.caseId`-only unlink is implemented as a
 *      separate, audited backend action.
 *   2. Picker endpoints accept `cursor` + `limit` and return
 *      `nextCursor`. Limits are bounded at ≤ 50.
 *   3. Matter-workspace envelope.viewer carries per-case
 *      capabilities computed via the SAME canonical permission
 *      helper used by the route guards.
 *   4. Frontend gates action buttons on `envelope.viewer.*` (not on
 *      role-string equality, not on `ctx.can()` alone).
 *   5. Modal infrastructure has focus trap + focus return +
 *      aria-labelledby + aria-describedby + Escape close.
 *   6. No window.prompt / confirm / alert remains anywhere in the
 *      cases-experience surface.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateCaseMutationPermission,
  resolveCaseViewerCapabilities,
  type CaseAccessRole,
  type CaseAssignmentRole,
} from "../src/services/cases/case-permission.service.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ROUTES = readApi("src/routes/case-workspace.routes.ts");
const LIFECYCLE = readApi("src/services/cases/case-lifecycle.service.ts");
const PERMISSION_SVC = readApi(
  "src/services/cases/case-permission.service.ts",
);
const MATTER_WS_SVC = readApi(
  "src/services/cases/matter-workspace.service.ts",
);

const WS = readWeb("components/cases-experience/CaseWorkspace.tsx");
const WS_TYPES = readWeb("components/cases-experience/types.ts");
const MODAL = readWeb("components/cases-experience/matter-modals/Modal.tsx");
const ASSIGN_PICKER = readWeb(
  "components/cases-experience/matter-modals/AssignmentPickerModal.tsx",
);
const EV_PICKER = readWeb(
  "components/cases-experience/matter-modals/EvidenceLinkModal.tsx",
);

// ===========================================================================
// PART 1 — Legacy Evidence.caseId unlink
// ===========================================================================

describe("Phase 32.8D-frontend-closure-2 — legacy Evidence.caseId unlink", () => {
  it("registers DELETE /v1/cases/:id/legacy-evidence-link/:evidenceId", () => {
    expect(ROUTES).toMatch(
      /app\.delete\(\s*['"`]\/v1\/cases\/:id\/legacy-evidence-link\/:evidenceId['"`]/,
    );
  });

  it("legacy unlink route gates on EVIDENCE_UNLINK_LEGACY", () => {
    expect(ROUTES).toMatch(
      /gateCaseMutation\(\s*reply\s*,\s*['"]EVIDENCE_UNLINK_LEGACY['"]/,
    );
  });

  it("permission service handles EVIDENCE_UNLINK_LEGACY via the same matrix", () => {
    expect(PERMISSION_SVC).toMatch(/['"]EVIDENCE_UNLINK_LEGACY['"]/);
    // Same writers as EVIDENCE_LINK.
    const allowed = evaluateCaseMutationPermission({
      mutation: "EVIDENCE_UNLINK_LEGACY",
      accessRole: "MEMBER",
      assignmentRoles: [],
    });
    expect(allowed.allowed).toBe(true);
    const denied = evaluateCaseMutationPermission({
      mutation: "EVIDENCE_UNLINK_LEGACY",
      accessRole: "VIEWER",
      assignmentRoles: [],
    });
    expect(denied.allowed).toBe(false);
  });

  it("lifecycle service exports removeLegacyEvidenceCaseId", () => {
    expect(LIFECYCLE).toMatch(
      /export async function removeLegacyEvidenceCaseId\(/,
    );
  });

  it("legacy unlink refuses when evidence.caseId !== caseId (returns evidence_not_found)", () => {
    expect(LIFECYCLE).toMatch(/evidence\.caseId\s*!==\s*input\.caseId/);
    expect(LIFECYCLE).toMatch(/throw new CaseError\(\s*['"]evidence_not_found['"]/);
  });

  it("legacy unlink refuses when a canonical CaseEvidenceLink already exists", () => {
    expect(LIFECYCLE).toMatch(/caseEvidenceLink\.findFirst/);
    expect(LIFECYCLE).toMatch(/throw new CaseError\(\s*['"]evidence_link_exists['"]/);
  });

  it("legacy unlink sets Evidence.caseId to null (does not delete the row)", () => {
    expect(LIFECYCLE).toMatch(/evidence\.update[\s\S]*?caseId:\s*null/);
    // Explicit guard against a destructive delete.
    expect(LIFECYCLE).not.toMatch(
      /removeLegacyEvidenceCaseId[\s\S]{0,2000}prisma\.evidence\.delete/,
    );
  });

  it("legacy unlink emits an audit log with cases.legacy_evidence_unlinked", () => {
    expect(LIFECYCLE).toMatch(/cases\.legacy_evidence_unlinked/);
    expect(LIFECYCLE).toMatch(/category:\s*['"]cases\.lifecycle['"]/);
  });

  it("legacy unlink emits no custody/download events / no signed URLs / no generation", () => {
    // Bound the inspection to the legacy unlink function body.
    const start = LIFECYCLE.indexOf("removeLegacyEvidenceCaseId");
    expect(start).toBeGreaterThan(-1);
    const slice = LIFECYCLE.slice(start, start + 3000);
    expect(slice).not.toMatch(/custody[A-Z]\w*Event\(/);
    expect(slice).not.toMatch(/getSignedUrl\(/);
    expect(slice).not.toMatch(/generateReport\(/);
    expect(slice).not.toMatch(/generatePackage\(/);
    expect(slice).not.toMatch(/enqueue[A-Z]\w*\(/);
  });

  it("frontend wires a separate audited mutation for the legacy endpoint", () => {
    expect(WS).toMatch(/removeLegacyEvidenceLink/);
    expect(WS).toMatch(
      /apiFetch\([^)]+\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/legacy-evidence-link\/\$\{encodeURIComponent\(evidenceId\)\}/,
    );
  });

  it("Evidence Board routes legacy rows (linkId === null) through the legacy modal flow", () => {
    expect(WS).toMatch(/onOpenUnlinkLegacyConfirm\(/);
    // Disabled gate reads from envelope viewer (canonical).
    expect(WS).toMatch(/canUnlinkLegacyEvidence/);
  });

  it("legacy unlink confirm modal explains evidence is preserved", () => {
    // ConfirmModal renders `data-matter-modal={testid}` — assert the
    // testid is passed verbatim at the call site.
    expect(WS).toMatch(/testid="confirm-unlink-legacy-evidence"/);
    expect(WS).toMatch(
      /removes the legacy case association from[\s\S]{0,200}only\. The evidence/,
    );
  });
});

// ===========================================================================
// PART 2 — Picker pagination
// ===========================================================================

describe("Phase 32.8D-frontend-closure-2 — picker pagination", () => {
  it("assignment-candidates accepts cursor + bounded limit (max 50)", () => {
    expect(ROUTES).toMatch(/AssignmentCandidatesQuery\s*=\s*z\.object/);
    const block = ROUTES.match(
      /AssignmentCandidatesQuery\s*=\s*z\.object\([\s\S]{0,500}?\}\)/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/cursor:/);
    expect(block![0]).toMatch(/limit[\s\S]{0,80}\.max\(50\)/);
  });

  it("linkable-evidence accepts cursor + bounded limit (max 50)", () => {
    expect(ROUTES).toMatch(/LinkableEvidenceQuery\s*=\s*z\.object/);
    const block = ROUTES.match(
      /LinkableEvidenceQuery\s*=\s*z\.object\([\s\S]{0,500}?\}\)/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/cursor:/);
    expect(block![0]).toMatch(/limit[\s\S]{0,80}\.max\(50\)/);
  });

  it("both picker endpoints emit nextCursor in their responses", () => {
    // Find each response and check for nextCursor.
    const assignmentSlice = ROUTES.slice(
      ROUTES.indexOf("/v1/cases/:id/assignment-candidates"),
      ROUTES.indexOf("/v1/cases/:id/linkable-evidence"),
    );
    expect(assignmentSlice).toMatch(/nextCursor/);
    const evidenceSlice = ROUTES.slice(
      ROUTES.indexOf("/v1/cases/:id/linkable-evidence"),
      ROUTES.indexOf("Mutations (audited)"),
    );
    expect(evidenceSlice).toMatch(/nextCursor/);
  });

  it("both picker endpoints use take = limit + 1 to detect the next page", () => {
    const slice = ROUTES.slice(
      ROUTES.indexOf("/v1/cases/:id/assignment-candidates"),
      ROUTES.indexOf("Mutations (audited)"),
    );
    const takes = slice.match(/take:\s*limit\s*\+\s*1/g) ?? [];
    expect(takes.length).toBeGreaterThanOrEqual(2);
  });

  it("AssignmentPickerModal renders a Load more button + dedupes by userId", () => {
    expect(ASSIGN_PICKER).toMatch(/data-matter-assignment-picker-load-more\b/);
    expect(ASSIGN_PICKER).toMatch(/dedupeById/);
    expect(ASSIGN_PICKER).toMatch(/\(x\)\s*=>\s*x\.userId/);
  });

  it("EvidenceLinkModal renders a Load more button + dedupes by id", () => {
    expect(EV_PICKER).toMatch(/data-matter-evidence-link-load-more\b/);
    expect(EV_PICKER).toMatch(/dedupeById/);
    expect(EV_PICKER).toMatch(/\(x\)\s*=>\s*x\.id/);
  });

  it("picker search resets pagination (the reload effect fires on search change)", () => {
    // Reload effect is keyed on search; load-more does not call reload.
    expect(ASSIGN_PICKER).toMatch(/\[open,\s*search,\s*reload\]/);
    expect(EV_PICKER).toMatch(/\[open,\s*search,\s*reload\]/);
  });

  it("picker modals never make an unbounded fetch (no while-loop + no auto-pagination)", () => {
    for (const src of [stripComments(ASSIGN_PICKER), stripComments(EV_PICKER)]) {
      expect(src).not.toMatch(/while\s*\([\s\S]*?nextCursor/);
      // No auto-load on intersection.
      expect(src).not.toMatch(/IntersectionObserver/);
    }
  });
});

// ===========================================================================
// PART 3 — Per-case capability overrides
// ===========================================================================

describe("Phase 32.8D-frontend-closure-2 — per-case viewer capabilities", () => {
  it("permission service exports resolveCaseViewerCapabilities", () => {
    expect(PERMISSION_SVC).toMatch(
      /export function resolveCaseViewerCapabilities\(/,
    );
  });

  it("matter-workspace service calls resolveCaseViewerCapabilities (no duplicated logic)", () => {
    expect(MATTER_WS_SVC).toMatch(/resolveCaseViewerCapabilities\(/);
    // The old role-string equality drift is gone.
    const live = stripComments(MATTER_WS_SVC);
    expect(live).not.toMatch(/input\.role\s*===\s*['"]OPERATOR['"]/);
    expect(live).not.toMatch(/input\.role\s*===\s*['"]INVESTIGATOR['"]/);
    expect(live).not.toMatch(/input\.role\s*===\s*['"]AUDITOR['"]/);
  });

  it("envelope.viewer carries the new fine-grained capability fields", () => {
    for (const key of [
      "canAssign",
      "canChangeStatus",
      "canLinkEvidence",
      "canUnlinkEvidence",
      "canUnlinkLegacyEvidence",
      "canComment",
      "canResolveComment",
      "disabledReasons",
      "activeAssignmentRoles",
    ]) {
      expect(WS_TYPES).toContain(key);
    }
  });

  it("TEAM VIEWER + CaseAssignment INVESTIGATOR gets STATUS_CHANGE / EVIDENCE_LINK / COMMENT denied at the floor", () => {
    // VIEWER is the hard floor regardless of assignment.
    const caps = resolveCaseViewerCapabilities({
      accessRole: "VIEWER" as CaseAccessRole,
      assignmentRoles: ["INVESTIGATOR" as CaseAssignmentRole],
    });
    expect(caps.canChangeStatus).toBe(false);
    expect(caps.canLinkEvidence).toBe(false);
    expect(caps.canComment).toBe(false);
    expect(caps.canAssign).toBe(false);
  });

  it("TEAM MEMBER with no per-case assignment gets writer-tier capabilities", () => {
    const caps = resolveCaseViewerCapabilities({
      accessRole: "MEMBER" as CaseAccessRole,
      assignmentRoles: [],
    });
    expect(caps.canChangeStatus).toBe(true);
    expect(caps.canLinkEvidence).toBe(true);
    expect(caps.canUnlinkEvidence).toBe(true);
    expect(caps.canUnlinkLegacyEvidence).toBe(true);
    expect(caps.canComment).toBe(true);
    expect(caps.canResolveComment).toBe(true);
    // Plain MEMBER cannot assign without case OWNER role.
    expect(caps.canAssign).toBe(false);
  });

  it("MEMBER + CaseAssignment OWNER can assign", () => {
    const caps = resolveCaseViewerCapabilities({
      accessRole: "MEMBER" as CaseAccessRole,
      assignmentRoles: ["OWNER" as CaseAssignmentRole],
    });
    expect(caps.canAssign).toBe(true);
  });

  it("disabledReasons map populates ONLY denied actions", () => {
    const caps = resolveCaseViewerCapabilities({
      accessRole: "VIEWER" as CaseAccessRole,
      assignmentRoles: [],
    });
    expect(caps.disabledReasons.changeStatus).toBeTruthy();
    expect(caps.disabledReasons.linkEvidence).toBeTruthy();
    expect(caps.disabledReasons.assign).toBeTruthy();
    expect(caps.disabledReasons.comment).toBeTruthy();
    // Allowed paths never populate the reason map.
    const ok = resolveCaseViewerCapabilities({
      accessRole: "OWNER" as CaseAccessRole,
      assignmentRoles: [],
    });
    expect(ok.disabledReasons.changeStatus).toBeUndefined();
    expect(ok.disabledReasons.linkEvidence).toBeUndefined();
    expect(ok.disabledReasons.comment).toBeUndefined();
  });

  it("frontend reads from envelope.viewer.* — NOT from ctx.can() per-case", () => {
    const live = stripComments(WS);
    expect(live).toMatch(/viewer\.canChangeStatus/);
    expect(live).toMatch(/viewer\.canAssign/);
    expect(live).toMatch(/viewer\.canLinkEvidence/);
    expect(live).toMatch(/viewer\.canUnlinkEvidence/);
    expect(live).toMatch(/viewer\.canUnlinkLegacyEvidence/);
    expect(live).toMatch(/viewer\.canComment/);
    expect(live).toMatch(/viewer\.canResolveComment/);
    // Tooltip text comes from server-provided reasons map.
    expect(live).toMatch(/reasons\.changeStatus/);
    expect(live).toMatch(/reasons\.assign/);
    expect(live).toMatch(/reasons\.unlinkLegacyEvidence/);
    // No inline role-string equality drift.
    expect(live).not.toMatch(/role\s*===\s*['"]OWNER['"]/);
    expect(live).not.toMatch(/role\s*===\s*['"]ADMIN['"]/);
    expect(live).not.toMatch(/role\s*===\s*['"]MEMBER['"]/);
    expect(live).not.toMatch(/role\s*===\s*['"]VIEWER['"]/);
  });
});

// ===========================================================================
// PART 4 — Modal accessibility hardening
// ===========================================================================

describe("Phase 32.8D-frontend-closure-2 — modal accessibility", () => {
  it("Modal sets role=dialog + aria-modal=true + aria-labelledby (+ aria-describedby when supplied)", () => {
    expect(MODAL).toMatch(/role="dialog"/);
    expect(MODAL).toMatch(/aria-modal="true"/);
    expect(MODAL).toMatch(/aria-labelledby=\{titleId\}/);
    expect(MODAL).toMatch(/aria-describedby=\{description \? descriptionId : undefined\}/);
  });

  it("Modal traps focus (Tab + Shift-Tab wrap)", () => {
    expect(MODAL).toMatch(/FOCUSABLE_SELECTOR/);
    expect(MODAL).toMatch(/e\.key === "Tab"/);
    expect(MODAL).toMatch(/e\.shiftKey/);
    expect(MODAL).toMatch(/last\.focus\(\)/);
    expect(MODAL).toMatch(/first\.focus\(\)/);
  });

  it("Modal restores focus to the opener after close", () => {
    expect(MODAL).toMatch(/previouslyFocusedRef/);
    expect(MODAL).toMatch(/prev\.focus\(\)/);
  });

  it("Modal closes on Escape + overlay click (when not dismissDisabled)", () => {
    expect(MODAL).toMatch(/e\.key === "Escape"/);
    expect(MODAL).toMatch(/e\.target === e\.currentTarget/);
    expect(MODAL).toMatch(/dismissDisabled/);
  });

  it("Modal prevents background scroll while open", () => {
    expect(MODAL).toMatch(/document\.body\.style\.overflow\s*=\s*['"]hidden['"]/);
    expect(MODAL).toMatch(/document\.body\.style\.overflow\s*=\s*prevOverflow/);
  });

  it("Modal supports optional description (aria-describedby)", () => {
    expect(MODAL).toMatch(/description\?:\s*string/);
    expect(MODAL).toMatch(/data-matter-modal-description/);
  });
});

// ===========================================================================
// PART 5 — Regression invariants
// ===========================================================================

describe("Phase 32.8D-frontend-closure-2 — regressions", () => {
  it("zero window.prompt / confirm / alert in CaseWorkspace + pickers + modal infra", () => {
    for (const src of [
      stripComments(WS),
      stripComments(ASSIGN_PICKER),
      stripComments(EV_PICKER),
      stripComments(MODAL),
    ]) {
      expect(src).not.toMatch(/window\.prompt\(/);
      expect(src).not.toMatch(/window\.confirm\(/);
      expect(src).not.toMatch(/window\.alert\(/);
      expect(src).not.toMatch(/(?:^|[^.])alert\(\s*["'`]/);
    }
  });

  it("no useActiveWorkspaceId / /v1/users/me / /v1/teams authority fetches", () => {
    for (const src of [
      stripComments(WS),
      stripComments(ASSIGN_PICKER),
      stripComments(EV_PICKER),
      stripComments(MODAL),
    ]) {
      expect(src).not.toMatch(/useActiveWorkspaceId/);
      expect(src).not.toMatch(/apiFetch\(\s*['"`]\/v1\/users\/me/);
      expect(src).not.toMatch(/apiFetch\(\s*['"`]\/v1\/teams[^/]/);
    }
  });

  it("no signed URLs / report or package generation / custody events on render", () => {
    for (const src of [
      stripComments(WS),
      stripComments(ASSIGN_PICKER),
      stripComments(EV_PICKER),
    ]) {
      expect(src).not.toMatch(/getSignedUrl\(/);
      expect(src).not.toMatch(/generateReport\(/);
      expect(src).not.toMatch(/generatePackage\(/);
      expect(src).not.toMatch(/custody[A-Z]\w*Event\(/);
    }
  });

  it("no legal overclaiming in pickers / modal / workspace UI", () => {
    for (const src of [
      stripComments(WS),
      stripComments(ASSIGN_PICKER),
      stripComments(EV_PICKER),
      stripComments(MODAL),
    ]) {
      expect(src).not.toMatch(/\blegally admissible\b/i);
      expect(src).not.toMatch(/\bcourt-ready\b/i);
      expect(src).not.toMatch(/\bproves\b/i);
    }
  });

  it("no fake picker data (every render reads from the apiFetch response)", () => {
    // The pickers do not hardcode user/evidence id arrays anywhere.
    expect(stripComments(ASSIGN_PICKER)).not.toMatch(
      /const\s+(?:FAKE|MOCK|DEMO)/i,
    );
    expect(stripComments(EV_PICKER)).not.toMatch(
      /const\s+(?:FAKE|MOCK|DEMO)/i,
    );
  });

  it("no duplicate per-case permission logic — matter-workspace service + routes both call resolveCaseViewerCapabilities / evaluateCaseMutationPermission", () => {
    // The route layer uses `gateCaseMutation` (which calls
    // `evaluateCaseMutationPermission`). The matter-workspace
    // service uses `resolveCaseViewerCapabilities` (which calls the
    // SAME evaluator). Both surfaces use a single helper module.
    expect(ROUTES).toMatch(/gateCaseMutation\(/);
    expect(MATTER_WS_SVC).toMatch(/resolveCaseViewerCapabilities\(/);
    // The matter-workspace service no longer re-implements
    // role-string checks for canMutate/canManage.
    const live = stripComments(MATTER_WS_SVC);
    expect(live).not.toMatch(/canMutate\s*=\s*[\s\S]{0,200}role\s*===/);
    expect(live).not.toMatch(/canManage\s*=\s*[\s\S]{0,200}role\s*===/);
  });
});
