/**
 * Phase 3 (Blocker 3) — Legal-hold CREATE must be wired to the existing
 * step-up flow.
 *
 * Background — the TWO-SURFACE situation (see the source pins below):
 *
 *   * The canonical create UI
 *     (app/(app)/evidence-lifecycle/legal-holds/page.tsx) calls
 *     POST /v1/lifecycle/legal-holds  (product-and-lifecycle.routes.ts).
 *   * The step-up gate (purpose LEGAL_HOLD_PLACE) was added to a DIFFERENT
 *     endpoint, POST /v1/governance/legal-holds  (governance.routes.ts).
 *
 * The correct, non-duplicating fix is to route the UI's ACTUAL create call
 * through `runStepUpAction`. The wrapper is a harmless no-op when the
 * server does not demand a challenge, and it transparently opens the modal
 * + resumes the exact request when the server DOES answer STEP_UP_REQUIRED
 * (i.e. once the backend gate is moved/added to the lifecycle route). No
 * second Legal Hold surface is created; the Phase-2 `kind` enum is intact.
 *
 * Source-contract pins (node:test style, matching the sibling web tests):
 *
 *   1. The page exists and is a client component with a default export.
 *   2. It reuses the EXISTING step-up flow (`useStepUpAction` +
 *      `<StepUpModal>`) imported from the shared module — no parallel
 *      step-up implementation, no hand-rolled challenge header.
 *   3. The CREATE call runs INSIDE runStepUpAction and threads the
 *      injected headers into the apiFetch POST — so a step-up-required
 *      response opens the modal and, after step-up, the EXACT request is
 *      resumed.
 *   4. Cancel does not create a hold (STEP_UP_CANCEL is handled distinctly
 *      from a real error, with no error toast / no denial).
 *   5. Errors flow through the sanctioned path (`toSafeUserError` /
 *      `notifyApiError`) — never a raw error.message passthrough.
 *   6. The create call still targets POST /v1/lifecycle/legal-holds (the
 *      UI's real endpoint) — the fix does NOT re-point the UI at the
 *      governance route or create a parallel path.
 *   7. The Phase-2 `kind` enum stays EVIDENCE/CASE/WORKSPACE/ORGANIZATION.
 *   8. The legal-hold admin surface is enterprise-only — personal / pro /
 *      team workspaces cannot access it (via canAccessSurface); an
 *      enterprise workspace can.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  canAccessSurface,
  type SurfaceUserContext,
} from "../lib/surface/access";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const APP_ROOT = resolve(REPO_ROOT, "apps/web");

const PAGE = resolve(
  APP_ROOT,
  "app/(app)/evidence-lifecycle/legal-holds/page.tsx",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — legal-hold create page exists", () => {
  it("app/(app)/evidence-lifecycle/legal-holds/page.tsx exists", () => {
    assert.ok(existsSync(PAGE), "legal-holds page.tsx missing");
  });

  it("is a client component with a default export", () => {
    const src = read(PAGE);
    assert.match(src, /^"use client";/);
    assert.match(src, /export default function LegalHoldsPage/);
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

describe("Pin 3 — create runs INSIDE runStepUpAction and resumes the exact request", () => {
  it("wraps the create apiFetch in runStepUpAction with injected headers", () => {
    const src = read(PAGE);
    assert.match(src, /runStepUpAction/);
    // The create closure must accept the injected headers and thread them
    // into the POST so the resumed request carries the challenge header.
    assert.match(
      src,
      /runStepUpAction\(\s*async\s*\(\s*headers\s*\)\s*=>/,
    );
    assert.match(src, /headers:\s*\{[^}]*\.\.\.\(headers\s*\?\?\s*\{\}\)/s);
  });
});

describe("Pin 4 — cancel does NOT create a hold", () => {
  it("handles STEP_UP_CANCEL distinctly (no error toast / no denial)", () => {
    const src = read(PAGE);
    assert.match(src, /STEP_UP_CANCEL/);
    // The cancel branch must be an explicit, separate arm from the real
    // error branch.
    assert.match(
      src,
      /if\s*\(\s*code\s*===\s*["']STEP_UP_CANCEL["']\s*\)\s*\{/,
    );
  });
});

describe("Pin 5 — sanctioned error path only", () => {
  it("uses toSafeUserError / notifyApiError", () => {
    const src = read(PAGE);
    assert.match(src, /toSafeUserError/);
    assert.match(src, /notifyApiError/);
  });

  it("never renders a raw error.message / err.message passthrough", () => {
    const src = read(PAGE);
    assert.doesNotMatch(src, /\{[^{}]*\berr(?:or)?\.message\b[^{}]*\}/);
  });
});

describe("Pin 6 — targets the UI's REAL endpoint (no re-point, no parallel path)", () => {
  it("the create call POSTs /v1/lifecycle/legal-holds", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /apiFetch\(\s*["']\/v1\/lifecycle\/legal-holds["']/,
    );
    assert.match(src, /method:\s*["']POST["']/);
  });

  it("does NOT call the governance legal-holds endpoint from the UI", () => {
    const src = read(PAGE);
    assert.doesNotMatch(src, /\/v1\/governance\/legal-holds/);
  });
});

describe("Pin 7 — Phase-2 kind enum is intact", () => {
  it("HOLD_KINDS stays EVIDENCE/CASE/WORKSPACE/ORGANIZATION", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /HOLD_KINDS\s*=\s*\[\s*"EVIDENCE"\s*,\s*"CASE"\s*,\s*"WORKSPACE"\s*,\s*"ORGANIZATION"\s*\]/,
    );
    // The litigation basis must NOT leak back into the enum values.
    assert.doesNotMatch(
      src,
      /HOLD_KINDS\s*=\s*\[[^\]]*(?:LITIGATION|REGULATORY)/,
    );
  });
});

describe("Pin 8 — legal-hold admin surface is enterprise-only", () => {
  const HOLD_PATH = "/evidence-lifecycle/legal-holds";

  function ctx(over: Partial<SurfaceUserContext>): SurfaceUserContext {
    return {
      plan: null,
      role: null,
      isPlatformAdmin: false,
      isEnterpriseWorkspace: false,
      ...over,
    };
  }

  it("personal (free) users cannot access it", () => {
    assert.equal(
      canAccessSurface(ctx({ plan: "FREE", role: "OWNER" }), HOLD_PATH),
      false,
    );
  });

  it("pro users cannot access it", () => {
    assert.equal(
      canAccessSurface(ctx({ plan: "PRO", role: "OWNER" }), HOLD_PATH),
      false,
    );
  });

  it("team-plan admins cannot access it (role alone never unlocks)", () => {
    assert.equal(
      canAccessSurface(ctx({ plan: "TEAM", role: "ADMIN" }), HOLD_PATH),
      false,
    );
  });

  it("enterprise workspaces CAN access it", () => {
    assert.equal(
      canAccessSurface(ctx({ isEnterpriseWorkspace: true }), HOLD_PATH),
      true,
    );
  });
});
