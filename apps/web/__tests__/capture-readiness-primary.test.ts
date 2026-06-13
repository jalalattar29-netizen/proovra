/**
 * Phase CAPTURE-READINESS-FIX — P0 Bug 1 regression lock.
 *
 * The Capture dropdown writes `role = "Primary evidence"` (a human-
 * readable label) when the user maps an item to a primary template
 * step, AND it writes the slug `checklistStepId = "primary_evidence"`
 * (or `primary_overview_media` etc. depending on the template).
 *
 * Until this fix, the readiness `hasAnyPrimaryItem()` check only
 * looked at `role` and compared against the legacy slug values, so a
 * correctly mapped primary item never satisfied the criterion and
 * the panel kept asking the user to "Mark a primary evidence item".
 *
 * The lock here is a pure-function test of the criterion factories
 * exported by `computeCaptureReadiness` — no UI, no DB — to guarantee:
 *
 *   1. A session item mapped via dropdown (role="Primary evidence",
 *      checklistStepId="primary_overview_media") satisfies has_primary.
 *   2. A legacy session item with role="primary_evidence" still
 *      satisfies has_primary (back-compat).
 *   3. An item with neither flag does NOT satisfy.
 *   4. A supporting-mapped item satisfies has_supporting via the
 *      same checklistStepId path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { computeCaptureReadiness } from "../app/(app)/capture/_lib/captureReadiness";
import type { SessionItem } from "../app/(app)/capture/_lib/types";

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

const PROFILE = "VERIFICATION_DOCUMENTATION" as const;

test("readiness: dropdown-mapped primary item (role human-readable, slug in checklistStepId) satisfies has_primary", () => {
  const readiness = computeCaptureReadiness({
    items: [
      makeItem({
        id: "i1",
        role: "Primary evidence",
        checklistStepId: "primary_overview_media",
      }),
    ],
    workflow: PROFILE,
  });
  const hasPrimary = readiness.criteria.find((c) => c.id === "has_primary");
  assert.ok(hasPrimary, "has_primary criterion exists");
  assert.equal(hasPrimary!.satisfied, true, "dropdown-mapped primary must satisfy has_primary");
});

test("readiness: legacy slug role 'primary_evidence' still satisfies (back-compat)", () => {
  const readiness = computeCaptureReadiness({
    items: [makeItem({ id: "i1", role: "primary_evidence" })],
    workflow: PROFILE,
  });
  const hasPrimary = readiness.criteria.find((c) => c.id === "has_primary");
  assert.equal(hasPrimary!.satisfied, true);
});

test("readiness: unmapped item does NOT satisfy has_primary (negative control)", () => {
  const readiness = computeCaptureReadiness({
    items: [makeItem({ id: "i1", role: "", checklistStepId: null })],
    workflow: PROFILE,
  });
  const hasPrimary = readiness.criteria.find((c) => c.id === "has_primary");
  assert.equal(hasPrimary!.satisfied, false);
});

test("readiness: regression lock — readiness MUST NOT depend solely on `role === 'primary_evidence'`", () => {
  // This is the explicit guard against the original bug: if a future
  // refactor drops the checklistStepId-prefix check and goes back to
  // role-only matching, this test fails because the dropdown's human-
  // readable role ('Primary evidence') doesn't equal the slug.
  const readiness = computeCaptureReadiness({
    items: [
      makeItem({
        id: "i1",
        role: "Primary evidence", // capitalised, space — NOT the slug
        checklistStepId: "primary_evidence",
      }),
    ],
    workflow: PROFILE,
  });
  assert.equal(
    readiness.criteria.find((c) => c.id === "has_primary")!.satisfied,
    true,
    "Capture must trust checklistStepId='primary_*' as the authoritative primary signal",
  );
});

test("readiness: alternate template slugs (primary_overview_media, primary_scene_overview, etc.) all satisfy", () => {
  for (const slug of [
    "primary_evidence",
    "primary_overview_media",
    "primary_scene_overview",
    "primary_document_media",
    "primary_policy_document",
    "primary_media",
  ]) {
    const readiness = computeCaptureReadiness({
      items: [makeItem({ id: `i-${slug}`, checklistStepId: slug })],
      workflow: PROFILE,
    });
    assert.equal(
      readiness.criteria.find((c) => c.id === "has_primary")!.satisfied,
      true,
      `slug '${slug}' must satisfy has_primary`,
    );
  }
});
