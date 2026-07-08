/**
 * Phase 2 — Platform-admin "Provision Enterprise Customer" UI contract.
 *
 * Source-contract pins (matching the sibling web tests, node:test style):
 *
 *   1. The page exists at app/(app)/admin/provisioning/page.tsx.
 *   2. It is gated to platform-admin — both via the shared admin/layout
 *      `platform.admin` gate AND its own `platform.provisioning`
 *      PageRouteGate. It reuses the EXISTING platform-admin gate; it must
 *      not roll its own capability check.
 *   3. It reuses the EXISTING step-up flow (`useStepUpAction` +
 *      `StepUpModal`) — no parallel step-up implementation — and the
 *      challenge id reaches the backend through the hook's retry, which
 *      sets the `x-proovra-step-up-challenge-id` header.
 *   4. It calls exactly the two keystone endpoints:
 *        POST  /v1/admin/enterprise/provision
 *        PATCH /v1/admin/orgs/:id/plan
 *      and no other admin mutation endpoint.
 *   5. It sends `teamId` (the admin's active workspace) on both calls,
 *      read from platform-context (`useTeamId`).
 *   6. It handles BOTH provision response shapes — provisioned:true and
 *      pendingOwner:true (invite URL to copy) — with distinct UI.
 *   7. Errors flow through the sanctioned path (`toSafeUserError` /
 *      `notifyApiError`), never raw `error.message` passthrough.
 *   8. The route registry declares `platform.provisioning` with the same
 *      PLATFORM_ADMIN gating as `platform.admin`.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ROUTE_REGISTRY,
  getRouteDefinition,
} from "../lib/navigation/routeRegistry";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const APP_ROOT = resolve(REPO_ROOT, "apps/web");

const PAGE = resolve(
  APP_ROOT,
  "app/(app)/admin/provisioning/page.tsx",
);
const ADMIN_LAYOUT = resolve(APP_ROOT, "app/(app)/admin/layout.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — page exists", () => {
  it("app/(app)/admin/provisioning/page.tsx exists", () => {
    assert.ok(existsSync(PAGE), "provisioning page.tsx missing");
  });

  it("is a client component with a default export", () => {
    const src = read(PAGE);
    assert.match(src, /^"use client";/);
    assert.match(src, /export default function AdminProvisioningPage/);
  });
});

describe("Pin 2 — gated to platform-admin (reuses the existing gate)", () => {
  it("wraps its content in the canonical PageRouteGate", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /import\s+\{\s*PageRouteGate\s*\}\s+from\s+["'][^"']*navigation\/PageRouteGate["']/,
    );
    assert.match(src, /<PageRouteGate\s+routeId="platform\.provisioning"/);
  });

  it("does NOT roll its own capability / admin check", () => {
    const src = read(PAGE);
    // The gate is the single sanctioned mechanism — no ad-hoc
    // isPlatformAdmin branching in the page itself.
    assert.doesNotMatch(src, /isPlatformAdmin/);
  });

  it("the shared admin layout gates /admin/* with platform.admin", () => {
    const layout = read(ADMIN_LAYOUT);
    assert.match(layout, /routeId="platform\.admin"/);
  });
});

describe("Pin 3 — reuses the EXISTING step-up flow", () => {
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

  it("runs both mutations through runStepUpAction and renders StepUpModal", () => {
    const src = read(PAGE);
    const runs = src.match(/runStepUpAction/g) ?? [];
    assert.ok(
      runs.length >= 2,
      "both mutations must go through runStepUpAction",
    );
    const modals = src.match(/<StepUpModal\s+control=\{stepUp\}/g) ?? [];
    assert.ok(modals.length >= 2, "each panel must render its StepUpModal");
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

describe("Pin 4 — calls ONLY the two keystone endpoints", () => {
  it("POSTs /v1/admin/enterprise/provision", () => {
    const src = read(PAGE);
    assert.match(src, /apiFetch\(\s*["']\/v1\/admin\/enterprise\/provision["']/);
    assert.match(src, /method:\s*["']POST["']/);
  });

  it("PATCHes /v1/admin/orgs/:id/plan", () => {
    const src = read(PAGE);
    assert.match(src, /\/v1\/admin\/orgs\/\$\{encodeURIComponent\(/);
    assert.match(src, /\/plan`/);
    assert.match(src, /method:\s*["']PATCH["']/);
  });

  it("does not call any other /v1/admin mutation endpoint", () => {
    const src = read(PAGE);
    const adminCalls = [...src.matchAll(/["'`]\/v1\/admin\/[^"'`]*/g)].map(
      (m) => m[0].replace(/["'`]/g, ""),
    );
    for (const call of adminCalls) {
      const ok =
        call.startsWith("/v1/admin/enterprise/provision") ||
        call.startsWith("/v1/admin/orgs/");
      assert.ok(
        ok,
        `unexpected admin endpoint referenced by the page: ${call}`,
      );
    }
  });
});

describe("Pin 5 — sends teamId from platform-context on both calls", () => {
  it("reads the admin's active workspace via useTeamId", () => {
    const src = read(PAGE);
    assert.match(
      src,
      /import\s+\{[^}]*useTeamId[^}]*\}\s+from\s+["'][^"']*platform-context["']/s,
    );
    assert.match(src, /useTeamId\(\)/);
  });

  it("includes teamId in both request bodies", () => {
    const src = read(PAGE);
    // Both JSON.stringify bodies must carry teamId.
    const bodies = src.match(/JSON\.stringify\(\{[\s\S]*?\}\)/g) ?? [];
    const withTeamId = bodies.filter((b) => /\bteamId\b/.test(b));
    assert.ok(
      withTeamId.length >= 2,
      "teamId must be sent on both the provision and grant-plan calls",
    );
  });
});

describe("Pin 6 — handles both provision response shapes", () => {
  it("branches on provisioned:true vs pendingOwner", () => {
    const src = read(PAGE);
    assert.match(src, /provisioned:\s*true/);
    assert.match(src, /pendingOwner/);
  });

  it("renders the invite URL (copyable) for the pending-owner path", () => {
    const src = read(PAGE);
    assert.match(src, /inviteUrl/);
    assert.match(src, /provision-invite-url/);
    assert.match(src, /provision-invite-copy/);
  });

  it("renders a created-workspace state with workspaceId + ownerUserId", () => {
    const src = read(PAGE);
    assert.match(src, /provision-success-created/);
    assert.match(src, /workspaceId/);
    assert.match(src, /ownerUserId/);
  });

  it("surfaces the grant-plan result (workspacesUpdated + seats)", () => {
    const src = read(PAGE);
    assert.match(src, /workspacesUpdated/);
    assert.match(src, /grant-success/);
  });
});

describe("Pin 7 — sanctioned error path only", () => {
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

describe("Pin 8 — route registry declares platform.provisioning", () => {
  it("has a platform.provisioning entry pointing at /admin/provisioning", () => {
    const route = getRouteDefinition("platform.provisioning");
    assert.ok(route, "platform.provisioning missing from registry");
    assert.equal(route.href, "/admin/provisioning");
  });

  it("mirrors platform.admin gating (PLATFORM_ADMIN capability + space)", () => {
    const provisioning = getRouteDefinition("platform.provisioning");
    const admin = getRouteDefinition("platform.admin");
    assert.ok(provisioning && admin, "registry entries missing");
    assert.deepEqual(
      provisioning.requiredCapabilities,
      admin.requiredCapabilities,
    );
    assert.equal(
      provisioning.requiredActiveSpace,
      admin.requiredActiveSpace,
    );
    assert.equal(provisioning.requiredActiveSpace, "PLATFORM_ADMIN");
    assert.equal(provisioning.domain, "PLATFORM_ADMIN");
    // Hidden from sidebar / cmd-K / All Tools, like platform.admin.
    assert.equal(provisioning.sidebarEligible, false);
  });

  it("is a unique, single registry entry (no duplicate id)", () => {
    const matches = (
      ROUTE_REGISTRY as ReadonlyArray<{ id: string }>
    ).filter((r) => r.id === "platform.provisioning");
    assert.equal(matches.length, 1);
  });
});
