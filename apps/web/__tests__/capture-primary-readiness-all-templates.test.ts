/**
 * Phase CAPTURE-PRIMARY-CANONICAL-FIX — universal primary-readiness
 * regression lock.
 *
 * The "primary evidence captured" criterion is a UNIVERSAL operational
 * concept. Marking ANY staged item as primary must satisfy the
 * criterion REGARDLESS of which template is selected. This file pins
 * that promise for every shipping template AND the user-flow edge
 * cases the original bug report called out:
 *
 *   1. General Evidence Record + primary item satisfies primary readiness.
 *   2. Insurance Claim + primary item satisfies primary readiness.
 *   3. Legal Matter + primary item satisfies primary readiness.
 *   4. Incident / Investigation + primary item satisfies primary readiness.
 *   5. Compliance Audit + primary item satisfies primary readiness.
 *   6. Journalism / Field Capture + primary item satisfies primary readiness.
 *   7. Switching templates preserves primary readiness when the item's
 *      step is still in the new template's step list.
 *   8. Removing the primary item clears primary readiness.
 *   9. Template-specific required-checklist items are NOT falsely marked
 *      complete by primary role (those are SEPARATE concepts — primary
 *      readiness lives in computeCaptureReadiness; required-step
 *      coverage lives in buildSessionReadiness's finalize gate).
 *  10. The canonical helper `hasPrimaryEvidence` is the SAME for every
 *      template — no template-specific branch exists anywhere.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCaptureReadiness,
  hasPrimaryEvidence,
  isPrimaryChecklistStepId,
  isSupportingChecklistStepId,
} from "../app/(app)/capture/_lib/captureReadiness";
import { COLLECTION_PLAN_TEMPLATES } from "../app/(app)/capture/_lib/templates";
import { buildSessionReadiness } from "../app/(app)/capture/_lib/session-readiness";
import type { SessionItem } from "../app/(app)/capture/_lib/types";

const PROFILE = "VERIFICATION_DOCUMENTATION" as const;

function makeItem(overrides: Partial<SessionItem>): SessionItem {
  return {
    id: overrides.id ?? "item-1",
    file: new File([new Uint8Array([0])], "x.jpg", { type: "image/jpeg" }),
    previewUrl: null,
    mimeType: overrides.mimeType ?? "image/jpeg",
    relativePath: null,
    uploadProgress: 100,
    uploading: false,
    error: null,
    role: overrides.role ?? "",
    checklistStepId: overrides.checklistStepId ?? null,
    privateNote: overrides.privateNote ?? "",
    sourceLabel: overrides.sourceLabel ?? "",
    clientSignals: overrides.clientSignals ?? {
      captureTimeUtc: new Date().toISOString(),
      browserMediaCaptureAvailable: true,
      folderPathPresent: false,
      locationIncluded: false,
    },
  } as SessionItem;
}

/**
 * Faithful simulation of what the Capture page's dropdown writes when
 * the operator clicks a step in the mapping menu. Mirrors page.tsx
 * lines ~1254-1258:
 *   updateSessionItem(item.id, {
 *     checklistStepId: step.id,
 *     role: `${getRoleFromChecklistStep(step)} evidence`,
 *   });
 *
 * `getRoleFromChecklistStep` now delegates to the canonical predicate,
 * so this fixture is the exact same shape the production dropdown
 * produces for every template.
 */
function simulateDropdownMapPrimary(item: SessionItem, stepId: string): SessionItem {
  return {
    ...item,
    checklistStepId: stepId,
    role: "Primary evidence",
  };
}

// ---------------------------------------------------------------------------
// 1-6: Per-template primary-readiness — the bug-report matrix
// ---------------------------------------------------------------------------

const TEMPLATE_PRIMARY_STEPS: Array<{ template: string; stepId: string }> = [
  { template: "general-evidence-record", stepId: "primary_evidence" },
  { template: "insurance-claim", stepId: "primary_overview_media" },
  { template: "insurance-claim", stepId: "primary_damage_close_up" },
  { template: "legal-matter", stepId: "primary_document_media" },
  { template: "incident-investigation", stepId: "primary_scene_overview" },
  { template: "incident-investigation", stepId: "primary_close_up_detail" },
  { template: "compliance-audit", stepId: "primary_policy_document" },
  { template: "compliance-audit", stepId: "primary_export_supporting_evidence" },
  { template: "journalism-field-capture", stepId: "primary_media" },
];

for (const { template, stepId } of TEMPLATE_PRIMARY_STEPS) {
  test(`primary readiness — ${template} (${stepId}): dropdown-mapped primary item satisfies has_primary`, () => {
    const item = simulateDropdownMapPrimary(makeItem({ id: "i1" }), stepId);
    assert.equal(hasPrimaryEvidence([item]), true);
    const readiness = computeCaptureReadiness({ items: [item], workflow: PROFILE });
    const c = readiness.criteria.find((c) => c.id === "has_primary");
    assert.ok(c);
    assert.equal(c.satisfied, true, `${template}/${stepId} must satisfy has_primary`);
  });
}

// ---------------------------------------------------------------------------
// 7. Switching templates preserves primary readiness when the item's
//    checklistStepId still references a valid primary slug in the
//    canonical-prefix sense. (The page's own useEffect clears
//    checklistStepId when the new template doesn't contain that exact
//    step id — that's a different code path, separately tested.)
// ---------------------------------------------------------------------------

test("primary readiness — switching templates preserves readiness when the item retains a primary-prefixed checklistStepId", () => {
  // Start: General + primary_evidence
  let item = simulateDropdownMapPrimary(makeItem({ id: "i1" }), "primary_evidence");
  assert.equal(hasPrimaryEvidence([item]), true);
  // Switch: imagine we set the item's slug to an Insurance Claim primary.
  item = { ...item, checklistStepId: "primary_overview_media" };
  assert.equal(
    hasPrimaryEvidence([item]),
    true,
    "any primary_* slug must satisfy regardless of which template authored it",
  );
});

// ---------------------------------------------------------------------------
// 8. Removing the primary item clears primary readiness.
// ---------------------------------------------------------------------------

test("primary readiness — removing the primary item clears the criterion", () => {
  const item = simulateDropdownMapPrimary(makeItem({ id: "i1" }), "primary_overview_media");
  assert.equal(hasPrimaryEvidence([item]), true);
  // Operator deletes the item.
  assert.equal(hasPrimaryEvidence([]), false);
  // Operator demotes via the dropdown's "Context · Unmapped" first item
  // (which clears checklistStepId + sets role = "Context / supplemental").
  const demoted: SessionItem = {
    ...item,
    checklistStepId: null,
    role: "Context / supplemental",
  };
  assert.equal(
    hasPrimaryEvidence([demoted]),
    false,
    "unmapping must drop the criterion immediately",
  );
});

// ---------------------------------------------------------------------------
// 9. Template-specific required-checklist coverage stays SEPARATE from
//    primary-readiness. Marking one primary item must NOT mark the
//    other required steps as covered.
// ---------------------------------------------------------------------------

test("primary readiness ≠ required-checklist coverage (Insurance Claim with 3 required steps)", () => {
  const insurance = COLLECTION_PLAN_TEMPLATES.find((t) => t.id === "insurance-claim")!;
  // Map one primary item only.
  const items: SessionItem[] = [
    simulateDropdownMapPrimary(makeItem({ id: "i1" }), "primary_overview_media"),
  ];

  // Universal primary-readiness IS satisfied.
  assert.equal(hasPrimaryEvidence(items), true);
  assert.equal(
    computeCaptureReadiness({ items, workflow: PROFILE }).criteria.find(
      (c) => c.id === "has_primary",
    )!.satisfied,
    true,
  );

  // BUT the finalize-gate "all required steps mapped" check is NOT
  // satisfied — the other two required steps of Insurance Claim are
  // still unmapped. The two concepts are independent on purpose.
  const finalizeReadiness = buildSessionReadiness({
    items,
    selectedPlan: insurance,
    planMode: "CHECKLIST_REQUIRED",
    useLocation: false,
  });
  assert.equal(
    finalizeReadiness.canFinalize,
    false,
    "CHECKLIST_REQUIRED mode must still demand all required steps be mapped",
  );
  assert.ok(
    finalizeReadiness.missingRequiredSteps.length >= 2,
    "the other two Insurance Claim required steps remain unmapped",
  );
});

// ---------------------------------------------------------------------------
// 10. Hydrated draft: an item restored from localStorage with
//     checklistStepId set still satisfies the criterion (no rehydration
//     transform drops the field).
// ---------------------------------------------------------------------------

test("primary readiness — hydrated draft item retains primary readiness across template ids", () => {
  for (const { stepId } of TEMPLATE_PRIMARY_STEPS) {
    const hydratedDraftItem = makeItem({
      id: `draft-${stepId}`,
      checklistStepId: stepId,
      role: "Primary evidence",
    });
    assert.equal(
      hasPrimaryEvidence([hydratedDraftItem]),
      true,
      `hydrated draft for ${stepId} must satisfy has_primary`,
    );
  }
});

// ---------------------------------------------------------------------------
// 11. Canonical helper anti-divergence — every template's primary
//     step IDs are recognised by the SAME prefix predicate. No
//     template-specific branch may exist.
// ---------------------------------------------------------------------------

test("canonical isPrimaryChecklistStepId recognises EVERY template's primary step id by prefix only", () => {
  for (const template of COLLECTION_PLAN_TEMPLATES) {
    for (const step of template.steps) {
      const isPrimaryByPrefix = step.id.startsWith("primary_");
      assert.equal(
        isPrimaryChecklistStepId(step.id),
        isPrimaryByPrefix,
        `${template.id}/${step.id}: predicate vs prefix mismatch`,
      );
    }
  }
});

test("canonical isSupportingChecklistStepId recognises every template's supporting/context step id by prefix only", () => {
  for (const template of COLLECTION_PLAN_TEMPLATES) {
    for (const step of template.steps) {
      const isSupportingByPrefix =
        step.id.startsWith("supporting_") ||
        step.id.startsWith("context_") ||
        step.id.startsWith("witness_");
      assert.equal(
        isSupportingChecklistStepId(step.id),
        isSupportingByPrefix,
        `${template.id}/${step.id}: supporting predicate vs prefix mismatch`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 12. Multipart / multiple items — ANY primary item satisfies even when
//     other items are unmapped or mapped to supporting roles.
// ---------------------------------------------------------------------------

test("primary readiness — multipart session with one primary + two unmapped items still satisfies", () => {
  const items: SessionItem[] = [
    simulateDropdownMapPrimary(makeItem({ id: "primary-1" }), "primary_damage_close_up"),
    makeItem({ id: "unmapped-1" }),
    makeItem({ id: "unmapped-2" }),
  ];
  assert.equal(hasPrimaryEvidence(items), true);
});

test("primary readiness — switching the primary FROM one item TO another preserves the criterion", () => {
  let items: SessionItem[] = [
    simulateDropdownMapPrimary(makeItem({ id: "a" }), "primary_overview_media"),
    makeItem({ id: "b" }),
  ];
  assert.equal(hasPrimaryEvidence(items), true);

  // Operator demotes A and promotes B.
  items = items.map((it) => {
    if (it.id === "a") return { ...it, checklistStepId: null, role: "Context / supplemental" };
    if (it.id === "b") return simulateDropdownMapPrimary(it, "primary_damage_close_up");
    return it;
  });
  assert.equal(
    hasPrimaryEvidence(items),
    true,
    "swapping which item carries primary keeps the criterion satisfied",
  );
});

// ---------------------------------------------------------------------------
// 13. Source contract — page.tsx delegates to the canonical helpers.
//     If this is ever reverted to a hardcoded allowlist, this test fires.
// ---------------------------------------------------------------------------

test("source contract — page.tsx imports the canonical role-label helper from _lib/captureReadiness (no hardcoded allowlist)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const PAGE = readFileSync(
    resolve(__dirname, "..", "app", "(app)", "capture", "page.tsx"),
    "utf8",
  );
  const READINESS = readFileSync(
    resolve(
      __dirname,
      "..",
      "app",
      "(app)",
      "capture",
      "_lib",
      "captureReadiness.ts",
    ),
    "utf8",
  );
  // The canonical role-label helper now lives in _lib/captureReadiness
  // alongside isPrimaryChecklistStepId / isSupportingChecklistStepId.
  // page.tsx must IMPORT it from there — never re-implement the
  // template-aware role logic locally.
  assert.match(
    PAGE,
    /getRoleFromChecklistStep[\s\S]{0,200}from\s+"\.\/_lib\/captureReadiness"/,
    "page.tsx must import getRoleFromChecklistStep from _lib/captureReadiness",
  );
  // The canonical helper file MUST export the role-label function and
  // both prefix predicates so any future consumer reads from one place.
  assert.match(READINESS, /export function getRoleFromChecklistStep\b/);
  assert.match(READINESS, /export function isPrimaryChecklistStepId\b/);
  assert.match(READINESS, /export function isSupportingChecklistStepId\b/);
  // The old hardcoded allowlists must NOT come back in page.tsx.
  assert.doesNotMatch(
    PAGE,
    /const\s+primaryStepIds\s*=\s*\[/,
    "the brittle primaryStepIds allowlist must not return",
  );
  assert.doesNotMatch(
    PAGE,
    /const\s+supportingStepIds\s*=\s*\[/,
    "the brittle supportingStepIds allowlist must not return",
  );
  // And page.tsx must not redefine the canonical role-label function
  // locally — the helper now lives in the _lib module.
  assert.doesNotMatch(
    PAGE,
    /(const|function)\s+getRoleFromChecklistStep\s*[=(]/,
    "page.tsx must NOT redefine getRoleFromChecklistStep locally",
  );
});
