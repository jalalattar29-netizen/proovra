/**
 * Phase 32.8D-frontend-closure — Case action UX + permission alignment.
 *
 * Pinned invariants:
 *
 *   1. No window.prompt / window.confirm / window.alert remains in
 *      CaseWorkspace.
 *   2. Assignment picker + evidence link modal are wired to safe,
 *      bounded backend endpoints (no UUID prompts).
 *   3. Backend case mutation routes go through the canonical
 *      `gateCaseMutation` helper — no dead OPERATOR/INVESTIGATOR/
 *      AUDITOR references on TeamRole, no role-string equality
 *      drift.
 *   4. Matter-workspace evidence rows expose `linkId` so the
 *      Evidence Board can offer direct Unlink with audit; legacy
 *      Evidence.caseId-only attachments are clearly marked.
 *   5. New canonical case capability keys exist on both sides and
 *      are wired into the resolver.
 *   6. Deep-link section navigation: hash scroll on first load,
 *      active section tracking via IntersectionObserver, URL hash
 *      updates on click.
 *   7. Backend picker endpoints are read-only / audit-free /
 *      side-effect-safe.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";
import {
  CAPABILITY_KEYS,
  type CapabilityKey,
} from "../src/services/platform-context/types.js";
import {
  evaluateCaseMutationPermission,
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
const PERMISSION_SVC = readApi(
  "src/services/cases/case-permission.service.ts",
);
const MATTER_WS_SVC = readApi(
  "src/services/cases/matter-workspace.service.ts",
);
const CAP_TYPES = readApi("src/services/platform-context/types.ts");
const CAP_REGISTRY = readApi(
  "src/services/platform-context/capability-registry.ts",
);

const WS_COMPONENT = readWeb("components/cases-experience/CaseWorkspace.tsx");
const WS_TYPES = readWeb("components/cases-experience/types.ts");
const WEB_CAP_TYPES = readWeb("lib/platform-context/types.ts");
const MODAL_INDEX = readWeb(
  "components/cases-experience/matter-modals/index.ts",
);
const MODAL_BASE = readWeb(
  "components/cases-experience/matter-modals/Modal.tsx",
);
const ASSIGNMENT_PICKER = readWeb(
  "components/cases-experience/matter-modals/AssignmentPickerModal.tsx",
);
const EVIDENCE_PICKER = readWeb(
  "components/cases-experience/matter-modals/EvidenceLinkModal.tsx",
);
const STATUS_MODAL = readWeb(
  "components/cases-experience/matter-modals/StatusChangeModal.tsx",
);
const CONFIRM_MODAL = readWeb(
  "components/cases-experience/matter-modals/ConfirmModal.tsx",
);

// ===========================================================================
// PART 1 — No UUID prompts remain
// ===========================================================================

describe("Phase 32.8D-frontend-closure — no window.prompt / confirm / alert", () => {
  it("CaseWorkspace contains no window.prompt", () => {
    const live = stripComments(WS_COMPONENT);
    expect(live).not.toMatch(/window\.prompt\(/);
  });

  it("CaseWorkspace contains no window.confirm", () => {
    const live = stripComments(WS_COMPONENT);
    expect(live).not.toMatch(/window\.confirm\(/);
  });

  it("CaseWorkspace contains no window.alert", () => {
    const live = stripComments(WS_COMPONENT);
    expect(live).not.toMatch(/window\.alert\(/);
    expect(live).not.toMatch(/(?:^|[^.])alert\(\s*["`']/);
  });
});

// ===========================================================================
// PART 2 — Assignment picker
// ===========================================================================

describe("Phase 32.8D-frontend-closure — assignment picker", () => {
  it("AssignmentPickerModal is exported from the modal barrel", () => {
    expect(MODAL_INDEX).toMatch(/AssignmentPickerModal/);
    expect(MODAL_INDEX).toMatch(/type AssignmentRole/);
  });

  it("AssignmentPickerModal renders the bounded assignment-role select", () => {
    for (const role of [
      "OWNER",
      "INVESTIGATOR",
      "REVIEWER",
      "GOVERNANCE",
      "OBSERVER",
    ]) {
      expect(ASSIGNMENT_PICKER).toContain(`"${role}"`);
    }
    expect(ASSIGNMENT_PICKER).toMatch(/data-matter-assignment-picker-role/);
  });

  it("AssignmentPickerModal fetches candidates from the bounded endpoint", () => {
    expect(ASSIGNMENT_PICKER).toMatch(
      /apiFetch\([^)]+\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assignment-candidates/,
    );
    // No UUID input field — selection is via the list.
    expect(ASSIGNMENT_PICKER).not.toMatch(
      /name=['"]?(?:userId|assignedToUserId)['"]?[^>]*type=['"]?text['"]?/,
    );
  });

  it("AssignmentPickerModal renders the personal-mode notice when the backend reports PERSONAL scope", () => {
    expect(ASSIGNMENT_PICKER).toMatch(/workspaceScope === ['"]PERSONAL['"]/);
    expect(ASSIGNMENT_PICKER).toMatch(
      /data-matter-assignment-picker-personal-mode/,
    );
  });

  it("AssignmentPickerModal exposes existing-assignment chips to prevent silent duplicates", () => {
    expect(ASSIGNMENT_PICKER).toMatch(
      /data-matter-assignment-picker-row-existing/,
    );
    expect(ASSIGNMENT_PICKER).toMatch(/alreadyHasThisRole/);
  });

  it("CaseWorkspace mounts the AssignmentPickerModal and wires submit to POST /v1/cases/:id/assignments", () => {
    expect(WS_COMPONENT).toMatch(/<AssignmentPickerModal/);
    expect(WS_COMPONENT).toMatch(/addAssignment\(userId, role, note\)/);
  });
});

// ===========================================================================
// PART 3 — Evidence link modal
// ===========================================================================

describe("Phase 32.8D-frontend-closure — evidence link modal", () => {
  it("EvidenceLinkModal renders the bounded link-role select", () => {
    for (const role of [
      "PRIMARY",
      "SUPPORTING",
      "RELATED",
      "DUPLICATE",
      "DERIVED",
      "CONTEXT",
    ]) {
      expect(EVIDENCE_PICKER).toContain(`"${role}"`);
    }
  });

  it("EvidenceLinkModal fetches linkable evidence from the bounded endpoint", () => {
    expect(EVIDENCE_PICKER).toMatch(
      /apiFetch\([^)]+\/v1\/cases\/\$\{encodeURIComponent\(caseId\)\}\/linkable-evidence/,
    );
  });

  it("EvidenceLinkModal marks already-linked rows and disables linking them", () => {
    expect(EVIDENCE_PICKER).toMatch(/alreadyLinked/);
    expect(EVIDENCE_PICKER).toMatch(
      /data-matter-evidence-link-row-already-linked/,
    );
  });

  it("EvidenceLinkModal surfaces lifecycle / verification / report / package state", () => {
    expect(EVIDENCE_PICKER).toMatch(/lifecycleState/);
    expect(EVIDENCE_PICKER).toMatch(/verificationStatus/);
    expect(EVIDENCE_PICKER).toMatch(
      /data-matter-evidence-link-row-report-ready/,
    );
    expect(EVIDENCE_PICKER).toMatch(
      /data-matter-evidence-link-row-package-ready/,
    );
  });

  it("EvidenceLinkModal exposes no signed-URL/storage fields on the picker rows", () => {
    const live = stripComments(EVIDENCE_PICKER);
    expect(live).not.toMatch(/signedUrl/i);
    expect(live).not.toMatch(/presignedUrl/i);
    expect(live).not.toMatch(/storageKey/i);
    expect(live).not.toMatch(/storage_key/i);
  });

  it("CaseWorkspace mounts the EvidenceLinkModal and wires submit to POST /v1/cases/:id/evidence-links", () => {
    expect(WS_COMPONENT).toMatch(/<EvidenceLinkModal/);
    expect(WS_COMPONENT).toMatch(
      /addEvidenceLink\(evidenceId, role, reason\)/,
    );
  });
});

// ===========================================================================
// PART 4 — Backend picker endpoints
// ===========================================================================

describe("Phase 32.8D-frontend-closure — backend picker endpoints", () => {
  it("registers GET /v1/cases/:id/assignment-candidates", () => {
    expect(ROUTES).toMatch(
      /app\.get\(\s*['"`]\/v1\/cases\/:id\/assignment-candidates['"`]/,
    );
  });

  it("registers GET /v1/cases/:id/linkable-evidence", () => {
    expect(ROUTES).toMatch(
      /app\.get\(\s*['"`]\/v1\/cases\/:id\/linkable-evidence['"`]/,
    );
  });

  it("picker endpoints are side-effect free (no audit / signed URL / generation)", () => {
    // Extract just the picker section to avoid catching mutations
    // that legitimately audit elsewhere in the file.
    const start = ROUTES.indexOf("Picker endpoints");
    const end = ROUTES.indexOf("Mutations (audited)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const pickerSlice = ROUTES.slice(start, end);
    expect(pickerSlice).not.toMatch(/appendPlatformAuditLog\(/);
    expect(pickerSlice).not.toMatch(/getSignedUrl\(/);
    expect(pickerSlice).not.toMatch(/generateReport\(/);
    expect(pickerSlice).not.toMatch(/generatePackage\(/);
    expect(pickerSlice).not.toMatch(/enqueue[A-Z]\w*\(/);
  });

  it("assignment-candidates returns existing assignment roles per member", () => {
    expect(ROUTES).toMatch(/existingAssignmentRoles/);
  });

  it("assignment-candidates renders a PERSONAL workspaceScope branch with a reason", () => {
    expect(ROUTES).toMatch(/workspaceScope:\s*['"]PERSONAL['"]/);
    expect(ROUTES).toMatch(/Personal cases do not support assignments/);
  });

  it("linkable-evidence reports already-linked status per row", () => {
    expect(ROUTES).toMatch(/alreadyLinked/);
    expect(ROUTES).toMatch(/existingLinkRole/);
  });

  it("linkable-evidence exposes NO signed URLs or storage internals", () => {
    const start = ROUTES.indexOf("/v1/cases/:id/linkable-evidence");
    expect(start).toBeGreaterThan(-1);
    const slice = ROUTES.slice(start, start + 3000);
    expect(slice).not.toMatch(/getSignedUrl/);
    expect(slice).not.toMatch(/storageKey/);
    expect(slice).not.toMatch(/signedUrl/);
  });
});

// ===========================================================================
// PART 5 — Case permission alignment
// ===========================================================================

describe("Phase 32.8D-frontend-closure — case permission alignment", () => {
  it("backend route guards no longer reference dead OPERATOR/INVESTIGATOR/AUDITOR TeamRole values", () => {
    const live = stripComments(ROUTES);
    // The previous bug had `member.role !== "OPERATOR"` / `INVESTIGATOR`
    // / `AUDITOR` on `member.role` (TeamRole values). Those checks are
    // gone — the canonical helper consults CaseAssignment roles
    // separately, which is correct.
    expect(live).not.toMatch(/member\.role\s*!==\s*['"]OPERATOR['"]/);
    expect(live).not.toMatch(/member\.role\s*!==\s*['"]INVESTIGATOR['"]/);
    expect(live).not.toMatch(/member\.role\s*===\s*['"]OPERATOR['"]/);
    expect(live).not.toMatch(/member\.role\s*===\s*['"]INVESTIGATOR['"]/);
    expect(live).not.toMatch(/member\.role\s*===\s*['"]AUDITOR['"]/);
  });

  it("backend uses the canonical gateCaseMutation helper for all 7 audited routes", () => {
    const count = (ROUTES.match(/gateCaseMutation\(/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(7);
  });

  it("permission service enumerates the canonical mutation types", () => {
    for (const mut of [
      "STATUS_CHANGE",
      "ASSIGN",
      "COMMENT",
      "COMMENT_RESOLVE",
      "EVIDENCE_LINK",
    ]) {
      expect(PERMISSION_SVC).toMatch(new RegExp(`['"]${mut}['"]`));
    }
  });

  it("permission service consults active CaseAssignment roles (not TeamRole proxies)", () => {
    expect(PERMISSION_SVC).toMatch(/getCaseAssignmentRoles/);
    expect(PERMISSION_SVC).toMatch(/status:\s*['"]ACTIVE['"]/);
    // The role check is on the CaseAssignment row, not on TeamMember.
    expect(PERMISSION_SVC).toMatch(/assignedAsInvestigator/);
    expect(PERMISSION_SVC).toMatch(/assignedAsOwner/);
  });

  it("VIEWER cannot mutate (verified by the resolver unit-style)", () => {
    for (const mut of [
      "STATUS_CHANGE",
      "ASSIGN",
      "COMMENT",
      "COMMENT_RESOLVE",
      "EVIDENCE_LINK",
    ] as const) {
      const decision = evaluateCaseMutationPermission({
        mutation: mut,
        accessRole: "VIEWER" as CaseAccessRole,
        assignmentRoles: [],
      });
      expect(decision.allowed).toBe(false);
    }
  });

  it("Team MEMBER can change status / link evidence / comment (no per-case assignment needed)", () => {
    for (const mut of [
      "STATUS_CHANGE",
      "EVIDENCE_LINK",
      "COMMENT",
      "COMMENT_RESOLVE",
    ] as const) {
      const decision = evaluateCaseMutationPermission({
        mutation: mut,
        accessRole: "MEMBER" as CaseAccessRole,
        assignmentRoles: [],
      });
      expect(decision.allowed).toBe(true);
    }
  });

  it("Team MEMBER CANNOT add assignments unless given case OWNER assignment", () => {
    const denied = evaluateCaseMutationPermission({
      mutation: "ASSIGN",
      accessRole: "MEMBER",
      assignmentRoles: [],
    });
    expect(denied.allowed).toBe(false);
    const allowed = evaluateCaseMutationPermission({
      mutation: "ASSIGN",
      accessRole: "MEMBER",
      assignmentRoles: ["OWNER" as CaseAssignmentRole],
    });
    expect(allowed.allowed).toBe(true);
  });

  it("Assigned INVESTIGATOR may change status even when team role is below MEMBER (e.g., VIEWER-blocked)", () => {
    // VIEWER is the hard floor — even an assigned INVESTIGATOR cannot
    // bypass a viewer-only access role.
    const blocked = evaluateCaseMutationPermission({
      mutation: "STATUS_CHANGE",
      accessRole: "VIEWER",
      assignmentRoles: ["INVESTIGATOR" as CaseAssignmentRole],
    });
    expect(blocked.allowed).toBe(false);
  });

  it("canonical 7 capability keys exist on backend types", () => {
    for (const key of [
      "CASES_VIEW",
      "CASES_MANAGE",
      "CASE_ASSIGN",
      "CASE_STATUS_CHANGE",
      "CASE_EVIDENCE_LINK",
      "CASE_COMMENT",
      "CASE_COMMENT_RESOLVE",
    ]) {
      expect(CAP_TYPES).toContain(`"${key}"`);
      expect(WEB_CAP_TYPES).toContain(`"${key}"`);
      expect(CAPABILITY_KEYS).toContain(key as CapabilityKey);
    }
  });

  it("capability resolver grants CASE_STATUS_CHANGE / EVIDENCE_LINK / COMMENT to TEAM writers", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(caps.CASE_STATUS_CHANGE).toBe(true);
    expect(caps.CASE_EVIDENCE_LINK).toBe(true);
    expect(caps.CASE_COMMENT).toBe(true);
    expect(caps.CASE_COMMENT_RESOLVE).toBe(true);
    expect(caps.CASE_ASSIGN).toBe(false); // MEMBER cannot assign at workspace level.
  });

  it("capability resolver grants CASE_ASSIGN to OWNER / ADMIN only at the workspace level", () => {
    const admin = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(admin.CASE_ASSIGN).toBe(true);
    const owner = resolveCapabilities({
      scope: "TEAM",
      role: "OWNER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(owner.CASE_ASSIGN).toBe(true);
  });

  it("capability resolver grants personal-case caps to the personal owner (no CASE_ASSIGN)", () => {
    const personal = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    expect(personal.CASE_STATUS_CHANGE).toBe(true);
    expect(personal.CASE_EVIDENCE_LINK).toBe(true);
    expect(personal.CASE_COMMENT).toBe(true);
    expect(personal.CASE_COMMENT_RESOLVE).toBe(true);
    expect(personal.CASE_ASSIGN).toBe(false);
  });

  it("VIEWER on a team workspace gets no case-mutation capabilities", () => {
    const viewer = resolveCapabilities({
      scope: "TEAM",
      role: "VIEWER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(viewer.CASE_STATUS_CHANGE).toBe(false);
    expect(viewer.CASE_EVIDENCE_LINK).toBe(false);
    expect(viewer.CASE_COMMENT).toBe(false);
    expect(viewer.CASE_COMMENT_RESOLVE).toBe(false);
    expect(viewer.CASE_ASSIGN).toBe(false);
  });

  it("frontend uses canonical per-case capabilities from envelope.viewer (no inline role-string equality)", () => {
    // Phase 32.8D-frontend-closure-2 — the frontend now reads from
    // `envelope.viewer.canChangeStatus / canAssign / canLinkEvidence
    // / canComment / canResolveComment`, computed server-side by the
    // SAME helper that backs the route guards. `ctx.can("CASE_*")`
    // is retained only as a shell-level hint (verified by the new
    // closure-2 test file).
    const live = stripComments(WS_COMPONENT);
    expect(live).toMatch(/viewer\.canChangeStatus/);
    expect(live).toMatch(/viewer\.canAssign/);
    expect(live).toMatch(/viewer\.canLinkEvidence/);
    expect(live).toMatch(/viewer\.canComment/);
    expect(live).toMatch(/viewer\.canResolveComment/);
    // No role-string equality drift.
    expect(live).not.toMatch(/role\s*===\s*['"]OWNER['"]/);
    expect(live).not.toMatch(/role\s*===\s*['"]ADMIN['"]/);
    expect(live).not.toMatch(/role\s*===\s*['"]MEMBER['"]/);
    expect(live).not.toMatch(/role\s*===\s*['"]VIEWER['"]/);
  });
});

// ===========================================================================
// PART 6 — Direct unlink from Evidence Board
// ===========================================================================

describe("Phase 32.8D-frontend-closure — direct unlink from Evidence Board", () => {
  it("matter-workspace service includes the canonical linkId per evidence row", () => {
    expect(MATTER_WS_SVC).toMatch(/linkId:\s*byEv\.get/);
    expect(MATTER_WS_SVC).toMatch(/select:\s*\{\s*id:\s*true,\s*evidenceId/);
  });

  it("backend envelope type declares linkId on evidence items", () => {
    expect(MATTER_WS_SVC).toMatch(/linkId:\s*string\s*\|\s*null/);
  });

  it("frontend mirror declares linkId on evidence items", () => {
    expect(WS_TYPES).toMatch(/linkId:\s*string\s*\|\s*null/);
  });

  it("Evidence Board renders unlink with separate canonical vs legacy gates per row", () => {
    // Phase 32.8D-frontend-closure-2 — canonical rows gate on
    // `canUnlinkEvidence`; legacy rows (linkId === null) gate on
    // `canUnlinkLegacyEvidence`. Both come from envelope.viewer.
    expect(WS_COMPONENT).toMatch(/data-matter-section-evidence-link-id/);
    expect(WS_COMPONENT).toMatch(
      /e\.linkId\s*\?\s*!canUnlinkEvidence\s*:\s*!canUnlinkLegacyEvidence/,
    );
  });

  it("Legacy Evidence.caseId-only rows are clearly marked and not silently unlinkable", () => {
    expect(WS_COMPONENT).toMatch(
      /data-matter-section-evidence-legacy-attachment/,
    );
    expect(WS_COMPONENT).toMatch(/Legacy attachment/);
  });

  it("Unlink click opens the canonical confirm modal with the linkId", () => {
    expect(WS_COMPONENT).toMatch(/openUnlinkEvidenceConfirm/);
    expect(WS_COMPONENT).toMatch(/onOpenUnlinkConfirm\(e\.linkId/);
  });

  it("Confirm modal wires onConfirm to removeEvidenceLink(linkId)", () => {
    expect(WS_COMPONENT).toMatch(/removeEvidenceLink\(modal\.linkId\)/);
  });
});

// ===========================================================================
// PART 7 — Deep-link section navigation
// ===========================================================================

describe("Phase 32.8D-frontend-closure — deep-link section navigation", () => {
  it("SectionJumpNav defines all 11 canonical section anchors", () => {
    for (const id of [
      "section-command-summary",
      "section-evidence",
      "section-relationships",
      "section-workflows",
      "section-incidents",
      "section-reviewer",
      "section-governance",
      "section-custody",
      "section-timeline",
      "section-notes",
      "section-deliverables",
    ]) {
      expect(WS_COMPONENT).toContain(id);
    }
  });

  it("Performs an initial hash scroll after data is ready (gated on dataReady)", () => {
    expect(WS_COMPONENT).toMatch(/initialScrollDoneRef/);
    expect(WS_COMPONENT).toMatch(/window\.location\.hash/);
    expect(WS_COMPONENT).toMatch(/scrollIntoView/);
  });

  it("Uses IntersectionObserver to track the active section", () => {
    expect(WS_COMPONENT).toMatch(/IntersectionObserver/);
    expect(WS_COMPONENT).toMatch(/data-matter-workspace-active-section/);
    expect(WS_COMPONENT).toMatch(/data-matter-workspace-jump-active/);
  });

  it("Click handler updates URL hash via history.replaceState (no pushState clutter)", () => {
    expect(WS_COMPONENT).toMatch(/history\.replaceState/);
    expect(WS_COMPONENT).not.toMatch(/window\.history\.pushState\b/);
  });

  it("Only bounded section ids are accepted from a hash (no hostile fragments)", () => {
    expect(WS_COMPONENT).toMatch(/SECTIONS\.some\(\(s\)\s*=>\s*s\.id === raw\)/);
  });
});

// ===========================================================================
// PART 8 — Modal infrastructure
// ===========================================================================

describe("Phase 32.8D-frontend-closure — modal infrastructure", () => {
  it("Modal primitive supports Escape close, focus management, and aria-modal", () => {
    // Phase 32.8D-frontend-closure-2 hardened the modal with a
    // focus trap (Tab/Shift-Tab cycling), focus return to opener on
    // close, and explicit aria-describedby support. The exhaustive
    // assertions live in the closure-2 test file; here we only pin
    // the basic accessibility shape.
    expect(MODAL_BASE).toMatch(/aria-modal="true"/);
    expect(MODAL_BASE).toMatch(/role="dialog"/);
    expect(MODAL_BASE).toMatch(/Escape/);
    expect(MODAL_BASE).toMatch(/\.focus\(\)/);
  });

  it("ConfirmModal exists and exposes a bounded testid + tone hint", () => {
    expect(CONFIRM_MODAL).toMatch(/data-confirm-tone/);
    expect(CONFIRM_MODAL).toMatch(/data-matter-confirm-submit/);
    expect(CONFIRM_MODAL).toMatch(/data-matter-confirm-cancel/);
  });

  it("StatusChangeModal renders a reason textarea (replacing window.prompt)", () => {
    expect(STATUS_MODAL).toMatch(/data-matter-status-change-reason/);
    expect(STATUS_MODAL).toMatch(/data-matter-status-change-submit/);
  });

  it("Modal barrel re-exports the bounded set", () => {
    for (const name of [
      "Modal",
      "AssignmentPickerModal",
      "EvidenceLinkModal",
      "StatusChangeModal",
      "ConfirmModal",
    ]) {
      expect(MODAL_INDEX).toContain(name);
    }
  });
});

// ===========================================================================
// PART 9 — Safety invariants preserved
// ===========================================================================

describe("Phase 32.8D-frontend-closure — safety invariants", () => {
  it("No signed-URL generation on render of CaseWorkspace or any modal", () => {
    for (const src of [
      stripComments(WS_COMPONENT),
      stripComments(ASSIGNMENT_PICKER),
      stripComments(EVIDENCE_PICKER),
      stripComments(STATUS_MODAL),
      stripComments(CONFIRM_MODAL),
    ]) {
      expect(src).not.toMatch(/getSignedUrl\(/);
      expect(src).not.toMatch(/presignedUrl/);
      expect(src).not.toMatch(/signedUrl/);
    }
  });

  it("No report/package generation on render of CaseWorkspace or any modal", () => {
    for (const src of [
      stripComments(WS_COMPONENT),
      stripComments(ASSIGNMENT_PICKER),
      stripComments(EVIDENCE_PICKER),
    ]) {
      expect(src).not.toMatch(/generateReport\(/);
      expect(src).not.toMatch(/generatePackage\(/);
    }
  });

  it("No legal-admissibility / authenticity claims in pickers", () => {
    for (const src of [
      stripComments(ASSIGNMENT_PICKER),
      stripComments(EVIDENCE_PICKER),
      stripComments(STATUS_MODAL),
    ]) {
      expect(src).not.toMatch(/\blegally admissible\b/i);
      expect(src).not.toMatch(/\bcourt-ready\b/i);
      expect(src).not.toMatch(/\bauthentic\b/i);
      expect(src).not.toMatch(/\bproves\b/i);
    }
  });

  it("No useActiveWorkspaceId / /v1/users/me / /v1/teams authority fetches anywhere in this phase", () => {
    for (const src of [
      stripComments(WS_COMPONENT),
      stripComments(ASSIGNMENT_PICKER),
      stripComments(EVIDENCE_PICKER),
      stripComments(STATUS_MODAL),
      stripComments(CONFIRM_MODAL),
      stripComments(MODAL_BASE),
    ]) {
      expect(src).not.toMatch(/useActiveWorkspaceId/);
      expect(src).not.toMatch(/apiFetch\(\s*['"`]\/v1\/users\/me/);
      expect(src).not.toMatch(/apiFetch\(\s*['"`]\/v1\/teams[^/]/);
    }
  });

  it("Capability registry still enforces VIEWER-no-mutate / PERSONAL-no-team-act", () => {
    // Smoke: the new capability keys all default to false in the
    // base empty map (i.e., explicitly granted, not implicit).
    const noWorkspace = resolveCapabilities({
      scope: null,
      role: null,
      plan: null,
      isPlatformAdmin: false,
    });
    expect(noWorkspace.CASE_STATUS_CHANGE).toBe(false);
    expect(noWorkspace.CASE_ASSIGN).toBe(false);
    expect(noWorkspace.CASE_EVIDENCE_LINK).toBe(false);
    expect(noWorkspace.CASE_COMMENT).toBe(false);
    expect(noWorkspace.CASE_COMMENT_RESOLVE).toBe(false);
  });
});

// ===========================================================================
// PART 10 — Registry source-of-truth
// ===========================================================================

describe("Phase 32.8D-frontend-closure — registry source-of-truth", () => {
  it("capability registry source mentions the new keys (sanity check)", () => {
    for (const key of [
      "CASE_ASSIGN",
      "CASE_STATUS_CHANGE",
      "CASE_EVIDENCE_LINK",
      "CASE_COMMENT",
      "CASE_COMMENT_RESOLVE",
    ]) {
      expect(CAP_REGISTRY).toContain(`"${key}"`);
    }
  });
});
