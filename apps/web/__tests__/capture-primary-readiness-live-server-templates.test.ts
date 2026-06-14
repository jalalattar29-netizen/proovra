/**
 * Phase CAPTURE-PRIMARY-LIVE-FIX — live-browser regression lock.
 *
 * The prior fix (capture-primary-readiness-all-templates.test.ts) tested
 * the readiness predicate against the IN-BUNDLE COLLECTION_PLAN_TEMPLATES
 * step ids (which use the `primary_*` naming convention). But the
 * live Capture page fetches its template catalog from the API at
 * `/v1/capture/intake-templates`, and the SERVER's step ids do NOT
 * use the `primary_*` prefix for most templates:
 *
 *   server (services/api/src/services/capture-intake-templates.ts):
 *     insurance-claim:         overview_media, damage_close_up, ownership_document, optional_audio
 *     incident-investigation:  scene_overview, close_up_detail, witness_statement, supporting_file
 *     compliance-audit:        policy_document, screenshot_export, supporting_evidence, reviewer_context
 *     legal-matter:            primary_media, supporting_exhibit, source_context, optional_timeline
 *     journalism-field-capture:primary_media, scene_context, source_safe_note, supporting_document
 *     general-evidence-record: primary_evidence, supporting_context, optional_statement
 *
 *   bundle (apps/web/app/(app)/capture/_lib/templates.ts):
 *     insurance-claim:         primary_overview_media, primary_damage_close_up, ...
 *     incident-investigation:  primary_scene_overview, primary_close_up_detail, ...
 *     etc.
 *
 * Because the predicate matched only on `^primary[_-]` step-id prefix,
 * the live browser saw a non-primary verdict for every non-General /
 * non-Journalism / non-Legal template even after the operator clicked
 * a "Primary" option in the dropdown. The user reported this as a P0
 * regression after the helper-level tests appeared to pass.
 *
 * THE FIX: `hasPrimaryEvidence` now also recognises the canonical
 * ROLE STRING `"Primary evidence"` (case-insensitive prefix on
 * "primary") that the dropdown's onClick writes for every primary
 * mapping — regardless of which step-id naming convention the server
 * template happens to ship.
 *
 * THIS TEST: feeds the predicate the EXACT (role, checklistStepId)
 * pairs that the live dropdown produces when the server-fetched
 * templates are in play. If the prior bug returned, every Insurance
 * Claim / Incident / Compliance step would fail this test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCaptureReadiness,
  hasPrimaryEvidence,
  getRoleFromChecklistStep,
} from "../app/(app)/capture/_lib/captureReadiness";
import type { SessionItem, ChecklistStep } from "../app/(app)/capture/_lib/types";

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
 * Faithful simulation of what the live Capture page writes when the
 * operator clicks a step in the dropdown. The shape is identical to
 * what `page.tsx` produces:
 *
 *   updateSessionItem(item.id, {
 *     checklistStepId: step.id,
 *     role: `${getRoleFromChecklistStep(step)} evidence`,
 *   });
 *
 * We compose it from the actual `getRoleFromChecklistStep` helper
 * (now exported) so any divergence between the role-label builder and
 * the readiness predicate would surface here.
 */
function simulateLiveDropdownClick(item: SessionItem, step: ChecklistStep): SessionItem {
  return {
    ...item,
    checklistStepId: step.id,
    role: `${getRoleFromChecklistStep(step)} evidence`,
  };
}

// ---------------------------------------------------------------------------
// The actual server step shapes — copied verbatim from
// services/api/src/services/capture-intake-templates.ts.
// ---------------------------------------------------------------------------
const SERVER_PRIMARY_STEPS: Array<{
  template: string;
  step: ChecklistStep;
}> = [
  // general-evidence-record — server step id `primary_evidence`
  {
    template: "general-evidence-record",
    step: {
      id: "primary_evidence",
      title: "Primary evidence file",
      description: "",
      purposeLabel: "Primary evidence",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
    },
  },
  // insurance-claim — bare-slug ids (NO primary_ prefix)
  {
    template: "insurance-claim",
    step: {
      id: "overview_media",
      title: "Overview photo/video",
      description: "",
      purposeLabel: "Overview media",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO"],
    },
  },
  {
    template: "insurance-claim",
    step: {
      id: "damage_close_up",
      title: "Damage close-up",
      description: "",
      purposeLabel: "Damage close-up",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO"],
    },
  },
  // legal-matter — server ships `primary_media`
  {
    template: "legal-matter",
    step: {
      id: "primary_media",
      title: "Primary document/media",
      description: "",
      purposeLabel: "Primary document/media",
      required: true,
      acceptedKinds: ["DOCUMENT", "PHOTO", "VIDEO", "AUDIO"],
    },
  },
  // incident-investigation — bare-slug ids
  {
    template: "incident-investigation",
    step: {
      id: "scene_overview",
      title: "Scene overview",
      description: "",
      purposeLabel: "Scene overview",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO"],
    },
  },
  {
    template: "incident-investigation",
    step: {
      id: "close_up_detail",
      title: "Close-up detail",
      description: "",
      purposeLabel: "Close-up detail",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO"],
    },
  },
  // compliance-audit — bare-slug ids
  {
    template: "compliance-audit",
    step: {
      id: "policy_document",
      title: "Policy / compliance document",
      description: "",
      purposeLabel: "Policy / compliance document",
      required: true,
      acceptedKinds: ["DOCUMENT"],
    },
  },
  {
    template: "compliance-audit",
    step: {
      id: "screenshot_export",
      title: "Screenshot / export",
      description: "",
      purposeLabel: "Screenshot / export",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
    },
  },
  // journalism-field-capture — `primary_media`
  {
    template: "journalism-field-capture",
    step: {
      id: "primary_media",
      title: "Primary media",
      description: "",
      purposeLabel: "Primary media",
      required: true,
      acceptedKinds: ["PHOTO", "VIDEO"],
    },
  },
];

for (const { template, step } of SERVER_PRIMARY_STEPS) {
  test(`live flow — ${template} (server step '${step.id}'): dropdown click satisfies has_primary`, () => {
    const item = simulateLiveDropdownClick(makeItem({ id: "live-1" }), step);
    // The role label must come back as "Primary" — the dropdown
    // writes "Primary evidence" via the fallback when the step lacks
    // the `primary_*` prefix.
    assert.equal(
      getRoleFromChecklistStep(step),
      "Primary",
      `getRoleFromChecklistStep must return "Primary" for ${step.id}`,
    );
    assert.equal(item.role, "Primary evidence");
    assert.equal(item.checklistStepId, step.id);

    // The predicate must satisfy.
    assert.equal(
      hasPrimaryEvidence([item]),
      true,
      `hasPrimaryEvidence must return TRUE for live-flow ${template}/${step.id}`,
    );

    // The readiness panel's has_primary criterion must satisfy.
    const readiness = computeCaptureReadiness({
      items: [item],
      workflow: PROFILE,
    });
    const hp = readiness.criteria.find((c) => c.id === "has_primary");
    assert.ok(hp, "has_primary criterion exists");
    assert.equal(
      hp.satisfied,
      true,
      `Readiness has_primary must be satisfied for live ${template}/${step.id}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Negative controls — make sure the new role-prefix branch doesn't
// false-positive on Supporting / Context / Unmapped.
// ---------------------------------------------------------------------------

test("negative — Supporting evidence role does NOT satisfy has_primary", () => {
  const item = makeItem({
    id: "neg-supporting",
    role: "Supporting evidence",
    checklistStepId: "supporting_exhibit",
  });
  assert.equal(hasPrimaryEvidence([item]), false);
});

test("negative — Context / supplemental role does NOT satisfy has_primary", () => {
  const item = makeItem({
    id: "neg-context",
    role: "Context / supplemental",
    checklistStepId: null,
  });
  assert.equal(hasPrimaryEvidence([item]), false);
});

test("negative — empty role + null checklistStepId does NOT satisfy", () => {
  const item = makeItem({ id: "neg-empty", role: "", checklistStepId: null });
  assert.equal(hasPrimaryEvidence([item]), false);
});

// ---------------------------------------------------------------------------
// Anti-regression — the predicate now COVERS all three branches.
// ---------------------------------------------------------------------------

test("predicate covers (1) role-prefix, (2) checklistStepId-prefix, (3) legacy literal slug", () => {
  // (1) Role prefix only — server-style bare slug.
  assert.equal(
    hasPrimaryEvidence([
      makeItem({ id: "r1", role: "Primary evidence", checklistStepId: "overview_media" }),
    ]),
    true,
  );
  // (2) checklistStepId prefix only — empty role.
  assert.equal(
    hasPrimaryEvidence([
      makeItem({ id: "r2", role: "", checklistStepId: "primary_evidence" }),
    ]),
    true,
  );
  // (3) Legacy literal slug role.
  assert.equal(
    hasPrimaryEvidence([makeItem({ id: "r3", role: "primary_evidence" })]),
    true,
  );
});

// ---------------------------------------------------------------------------
// Source contract — the canonical predicate file MUST contain the
// role-prefix check so a future refactor can't remove the load-bearing
// branch.
// ---------------------------------------------------------------------------

test("source contract — captureReadiness.ts contains the role-prefix branch", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const SRC = readFileSync(
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
  // The role string is normalised + checked with startsWith("primary").
  assert.match(SRC, /role\.startsWith\(\s*"primary"\s*\)/);
  // The check is performed AGAINST a lowercased trimmed role.
  assert.match(SRC, /\(i\.role\s*\?\?\s*""\)\.trim\(\)\.toLowerCase\(\)/);
});
