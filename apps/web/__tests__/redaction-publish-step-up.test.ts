/**
 * Phase 3A (Redaction closure) — the redaction project workspace must wire
 * the SENSITIVE publish mutation to the EXISTING step-up flow.
 *
 * Publishing a redacted derivative is the irreversible, disclosure-shaping
 * step of the redaction lifecycle. The backend now answers 401
 * STEP_UP_REQUIRED (purpose REDACTION_PUBLISH) on
 * POST /v1/redaction/versions/:id/publish. The operator workspace must
 * therefore run the PUBLISH call through `runStepUpAction` so the modal is
 * prompted and the exact publish request is resumed after step-up — reusing
 * the same `useStepUpAction` + `<StepUpModal>` used by legal-holds /
 * admin-provisioning. No parallel step-up implementation, no hand-rolled
 * challenge header, and VIEWING / authoring / submit / approve are NEVER
 * gated.
 *
 * Source-contract pins (node:test style, matching the sibling
 * legal-hold-create-step-up + external-review-grant-step-up web tests).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const APP_ROOT = resolve(REPO_ROOT, "apps/web");

const PAGE = resolve(
  APP_ROOT,
  "app/(app)/redaction/[projectId]/page.tsx",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — redaction project workspace page exists", () => {
  it("app/(app)/redaction/[projectId]/page.tsx exists", () => {
    assert.ok(existsSync(PAGE), "redaction project page.tsx missing");
  });

  it("is a client component with a default export", () => {
    const src = read(PAGE);
    assert.match(src, /^"use client";/);
    assert.match(src, /export default function RedactionProjectPage/);
  });
});

describe("Pin 2 — reuses the EXISTING step-up flow (no parallel impl)", () => {
  it("imports useStepUpAction + StepUpModal from the shared module", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /import\s+\{[^}]*useStepUpAction[^}]*\}\s+from\s+["'][^"']*identity-security\/StepUpModal["']/s,
    );
    assert.match(
      src,
      /import\s+\{[^}]*StepUpModal[^}]*\}\s+from\s+["'][^"']*identity-security\/StepUpModal["']/s,
    );
  });

  it("instantiates the hook with the active workspace teamId", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /import\s+\{[^}]*useTeamId[^}]*\}\s+from\s+["'][^"']*platform-context["']/s,
    );
    assert.match(src, /useStepUpAction\(\{\s*teamId\s*\}\)/);
  });

  it("renders <StepUpModal control={stepUp} /> so the modal can be prompted", () => {
    const src = read(PAGE);
    assert.match(src, /<StepUpModal\s+control=\{stepUp\}\s*\/>/);
  });

  it("does NOT hand-roll the step-up header or a parallel step-up flow", () => {
    const src = read(PAGE);
    // The header is injected by the hook's retry (see StepUpModal.tsx),
    // never spelled out literally in this page.
    assert.doesNotMatch(src, /x-proovra-step-up-challenge-id/i);
    assert.doesNotMatch(src, /step-up\/start/);
    assert.doesNotMatch(src, /step-up\/check/);
  });
});

describe("Pin 3 — publish runs INSIDE runStepUpAction and resumes the exact request", () => {
  it("wraps the publish apiFetch in runStepUpAction with injected headers", () => {
    const src = read(PAGE);
    assert.match(src, /runStepUpAction/);
    // The publish closure must accept the injected headers and thread them
    // into the POST so the resumed request carries the challenge header.
    assert.match(
      src,
      /runStepUpAction\(\s*async\s*\(\s*headers\s*\)\s*=>/,
    );
    assert.match(src, /headers:\s*\{[^}]*\.\.\.\(headers\s*\?\?\s*\{\}\)/s);
  });

  it("only the publish action goes through step-up (submit/approve stay direct)", () => {
    const src = read(PAGE);
    // The step-up wrapper is scoped to the publish branch.
    assert.match(src, /if\s*\(\s*action\s*===\s*["']publish["']\s*\)\s*\{/);
    // The publish URL is the redaction versions publish endpoint.
    assert.match(src, /\/v1\/redaction\/versions\/\$\{versionId\}\/\$\{action\}/);
  });
});

describe("Pin 4 — cancel does NOT publish", () => {
  it("handles STEP_UP_CANCEL distinctly (no error banner as a failure)", () => {
    const src = read(PAGE);
    assert.match(src, /STEP_UP_CANCEL/);
    assert.match(
      src,
      /if\s*\(\s*code\s*===\s*["']STEP_UP_CANCEL["']\s*\)\s*\{/,
    );
  });
});

describe("Pin 5 — sanctioned error path only", () => {
  it("uses toSafeUserError for unexpected errors", () => {
    const src = read(PAGE);
    assert.match(src, /toSafeUserError/);
  });

  it("never renders a raw error.message / err.message passthrough", () => {
    const src = read(PAGE);
    assert.doesNotMatch(src, /\{[^{}]*\berr(?:or)?\.message\b[^{}]*\}/);
  });
});

describe("Pin 6 — targets the redaction publish endpoint (no re-point, no parallel path)", () => {
  it("the transition call POSTs /v1/redaction/versions/:id/:action", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /apiFetch\(\s*url\s*,\s*\{[\s\S]*method:\s*["']POST["']/,
    );
  });

  it("does NOT introduce a second redaction publish surface", () => {
    const src = read(PAGE);
    // The publish endpoint remains the canonical versions/:id/publish path
    // built from the `url` template — no hardcoded alternate publish route.
    assert.doesNotMatch(src, /\/v1\/redaction\/publish/);
  });
});

// ============================================================================
// PHASE 12B (Evidence Operations, 2026-07-29) — redaction administration
// surfaces. Five ops that previously had no reachable caller are now wired
// to the project workspace and the Policy console.
// ============================================================================

describe("Phase 12B — redaction administration wiring", () => {
  const REGION_PANEL = resolve(
    APP_ROOT,
    "components/redaction/RegionListPanel.tsx",
  );
  const MANIFEST_PANEL = resolve(
    APP_ROOT,
    "components/redaction/DetectionManifestPanel.tsx",
  );
  const SCOPE_PANEL = resolve(
    APP_ROOT,
    "components/redaction/PolicyScopePanel.tsx",
  );
  const POLICY_PAGE = resolve(APP_ROOT, "app/(app)/redaction/policy/page.tsx");

  it("the project workspace mounts the region list + detection manifest panels", () => {
    const src = read(PAGE);
    assert.match(src, /<RegionListPanel/);
    assert.match(src, /regions=\{version\.regions \?\? \[\]\}/);
    assert.match(src, /<DetectionManifestPanel evidenceId=\{project\.evidenceId\}/);
  });

  it("region removal calls DELETE /v1/redaction/regions/:id with confirm + bounded denials", () => {
    const src = read(REGION_PANEL);
    assert.match(src, /apiFetch\(`\/v1\/redaction\/regions\/\$\{encodeURIComponent\(regionId\)\}`/);
    assert.match(src, /method: "DELETE"/);
    // Explicit confirm step before an irreversible removal.
    assert.match(src, /data-redaction-region-remove-confirm/);
    // Server denial codes rendered as the server's decision, never ours.
    assert.match(src, /VERSION_LOCKED/);
    assert.match(src, /NOT_PERMITTED/);
    // Empty + stale-context + safe-error coverage.
    assert.match(src, /data-redaction-region-empty/);
    assert.match(src, /isStale\(captured\)/);
    assert.match(src, /toSafeUserError/);
  });

  it("detection manifest panel reads the workspace-anchored manifest op", () => {
    const src = read(MANIFEST_PANEL);
    assert.match(
      src,
      /\/v1\/redaction\/evidence\/\$\{encodeURIComponent\(\s*evidenceId,?\s*\)\}\/detection-manifest/,
    );
    assert.match(src, /manifest\.evidenceId !== evidenceId/);
    assert.match(src, /data-redaction-detection-manifest-loading/);
    assert.match(src, /data-redaction-detection-manifest-empty/);
    assert.match(src, /data-redaction-detection-manifest-denied/);
    assert.match(src, /data-redaction-detection-manifest-error/);
    assert.match(src, /isStale\(captured\)/);
  });

  it("policy console mounts the scope panel that reads effective policy + assignments", () => {
    assert.match(read(POLICY_PAGE), /<PolicyScopePanel/);
    const src = read(SCOPE_PANEL);
    assert.match(src, /\/v1\/redaction\/policy\/assignments\?/);
    assert.match(src, /\/v1\/redaction\/policy\/effective/);
    // Precedence is resolved SERVER-side; the panel only renders it.
    assert.match(src, /effective\.resolution/);
  });

  it("withdrawing a policy assignment is step-up gated AND version-concurrency guarded", () => {
    const src = read(SCOPE_PANEL);
    assert.match(src, /useStepUpAction/);
    assert.match(src, /<StepUpModal control=\{stepUp\} \/>/);
    assert.match(src, /stepUp\.runStepUpAction/);
    assert.match(
      src,
      /\/v1\/redaction\/policy-assignments\/\$\{encodeURIComponent\(\s*row\.id,?\s*\)\}\?expectedPolicyVersionId=/,
    );
    assert.match(src, /method: "DELETE"/);
    // Cancelling step-up must not revoke, and a superseded assignment
    // must surface the stale-view message instead of a silent revoke.
    assert.match(src, /STEP_UP_CANCEL/);
    assert.match(src, /INVALID_TRANSITION/);
    // Denial + safe error + stale-context coverage.
    assert.match(src, /data-redaction-policy-scope-denied/);
    assert.match(src, /data-redaction-policy-scope-error/);
    assert.match(src, /isStale\(captured\)/);
    assert.match(src, /toSafeUserError/);
  });
});
