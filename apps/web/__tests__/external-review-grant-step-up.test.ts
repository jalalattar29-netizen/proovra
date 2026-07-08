/**
 * Phase 3 (Blocker 1) — External review console must wire the SENSITIVE
 * mutations (bulk issue + break-glass token reveal) to the EXISTING
 * step-up flow.
 *
 * External reviewer tokens can expose sensitive workspace evidence to an
 * OUTSIDE reviewer. The backend now answers 401 STEP_UP_REQUIRED
 * (purpose EXTERNAL_REVIEW_GRANT_ISSUE) on grant/invitation issue, bulk
 * issue, and break-glass reveal. The operator console must therefore run
 * those calls through `runStepUpAction` so the modal is prompted and the
 * exact request is resumed after step-up — reusing the same
 * `useStepUpAction` + `<StepUpModal>` used by admin/provisioning. No
 * parallel step-up implementation, no new portal, no re-pointed endpoint.
 *
 * Source-contract pins (node:test style, matching the sibling
 * legal-hold-create-step-up web test).
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

const PAGE = resolve(APP_ROOT, "app/(app)/review/external/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — external review console page exists", () => {
  it("app/(app)/review/external/page.tsx exists", () => {
    assert.ok(existsSync(PAGE), "review/external page.tsx missing");
  });

  it("is a client component with a default export", () => {
    const src = read(PAGE);
    assert.match(src, /^"use client";/);
    assert.match(src, /export default function ExternalInvitationsPage/);
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

describe("Pin 3 — sensitive mutations run INSIDE runStepUpAction with resumed request", () => {
  it("wraps the bulk-issue apiFetch in runStepUpAction with injected headers", () => {
    const src = read(PAGE);
    // The bulk issue call must be inside runStepUpAction and thread the
    // injected headers so the resumed request carries the challenge.
    assert.match(
      src,
      /runStepUpAction\(\s*async\s*\(\s*headers\s*\)\s*=>[\s\S]*?\/v1\/external-review\/invitations\/bulk/,
    );
    assert.match(src, /headers:\s*\{[^}]*\.\.\.\(headers\s*\?\?\s*\{\}\)/s);
  });

  it("wraps the break-glass reveal-token apiFetch in runStepUpAction", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /runStepUpAction\(\s*async\s*\(\s*headers\s*\)\s*=>[\s\S]*?\/v1\/external-review\/invitations\/\$\{grantId\}\/reveal-token/,
    );
  });
});

describe("Pin 4 — cancel does NOT issue / reveal", () => {
  it("handles STEP_UP_CANCEL distinctly from a real error", () => {
    const src = read(PAGE);
    assert.match(src, /STEP_UP_CANCEL/);
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

describe("Pin 6 — targets the REAL endpoints (no re-point, no parallel path)", () => {
  it("bulk issue still POSTs /v1/external-review/invitations/bulk", () => {
    const src = read(PAGE);
    assert.match(src, /apiFetch\(\s*["']\/v1\/external-review\/invitations\/bulk["']/);
  });

  it("break-glass reveal still POSTs the reveal-token endpoint", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /apiFetch\(\s*[`]\/v1\/external-review\/invitations\/\$\{grantId\}\/reveal-token[`]/,
    );
  });

  it("does NOT create a second reviewer portal or a new step-up endpoint", () => {
    const src = read(PAGE);
    assert.doesNotMatch(src, /identity-security\/step-up\//);
  });
});

describe("Pin 7 — the external reviewer admin surface is enterprise-only", () => {
  const SURFACE_PATH = "/review/external";

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
      canAccessSurface(ctx({ plan: "FREE", role: "OWNER" }), SURFACE_PATH),
      false,
    );
  });

  it("pro users cannot access it", () => {
    assert.equal(
      canAccessSurface(ctx({ plan: "PRO", role: "OWNER" }), SURFACE_PATH),
      false,
    );
  });

  it("team-plan admins cannot access it (role alone never unlocks)", () => {
    assert.equal(
      canAccessSurface(ctx({ plan: "TEAM", role: "ADMIN" }), SURFACE_PATH),
      false,
    );
  });

  it("enterprise workspaces CAN access it", () => {
    assert.equal(
      canAccessSurface(ctx({ isEnterpriseWorkspace: true }), SURFACE_PATH),
      true,
    );
  });
});
