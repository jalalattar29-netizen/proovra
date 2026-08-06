/**
 * Phase 5 (Enterprise Governance) FINALIZATION — External-reviewer grant
 * governance view: registration + tier-gating contract (SCOPE J).
 *
 * The read-only external-reviewer grant governance view lives at
 * /organizations/:id/admin/governance/external-reviewers. It REUSES the
 * existing `/v1/external-review/grants` + `/activity` reads — no new portal.
 *
 * Two layers are pinned here:
 *
 *   1. REGISTRATION — the sub-view is a first-class registry route
 *      (cmd-K + All Tools discoverable, sidebar-ineligible like its sibling
 *      org-admin tabs) and its href resolves to a real page.tsx on disk.
 *
 *   2. ENTERPRISE-ONLY surface gate — personal / FREE / PAYG / PRO / TEAM
 *      users cannot reach it (the /organizations path prefix is
 *      ENTERPRISE-tier). Only an enterprise workspace (or platform admin)
 *      may. The backend re-gates every read at `audit.read`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canAccessSurface,
  type SurfaceUserContext,
} from "../lib/surface/access";
import type { WorkspacePlan } from "../lib/platform-context/types";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROUTE_ID = "account.organization_admin_governance_external_reviewers";
const HREF = "/organizations/:id/admin/governance/external-reviewers";
const CONCRETE = "/organizations/org_123/admin/governance/external-reviewers";

function ctxFor(plan: WorkspacePlan): SurfaceUserContext {
  return {
    // PHASE 12B Track 1A — server-projected booleans, never the plan name.
    planFeatures: {
      intakeIncluded: null,
      professionalSurfacesIncluded:
        plan === "PRO" || plan === "TEAM" || (plan as string) === "ENTERPRISE",
    },
    isPlatformAdmin: false,
    isEnterpriseWorkspace: plan === "ENTERPRISE",
  };
}

// ---------------------------------------------------------------------------
// 1. Registration.
// ---------------------------------------------------------------------------

test("the external-reviewer governance view is registered in the route registry", () => {
  const route = (ROUTE_REGISTRY as ReadonlyArray<{
    id: string;
    href: string;
    domain: string;
    sidebarEligible: boolean;
    commandPaletteVisible: boolean;
    allToolsVisible: boolean;
  }>).find((r) => r.id === ROUTE_ID);
  assert.ok(route, `${ROUTE_ID} must exist in ROUTE_REGISTRY`);
  assert.equal(route!.href, HREF, "href matches the canonical sub-view path");
  assert.equal(route!.domain, "ACCOUNT", "ACCOUNT domain like sibling admin tabs");
  // Discoverable via cmd-K + All Tools but not in the sidebar (org detail is
  // the canonical sidebar entry; the admin shell is reached from there).
  assert.equal(route!.sidebarEligible, false, "sidebar-ineligible");
  assert.equal(route!.commandPaletteVisible, true, "cmd-K discoverable");
  assert.equal(route!.allToolsVisible, true, "All Tools discoverable");
});

test("the external-reviewer governance view resolves to a real page on disk", () => {
  const seg = HREF.replace(/:([A-Za-z0-9_]+)/g, "[$1]");
  const exists =
    existsSync(resolve(APP_ROOT, `app/(app)${seg}/page.tsx`)) ||
    existsSync(resolve(APP_ROOT, `app${seg}/page.tsx`));
  assert.ok(exists, `${HREF} must have a page.tsx on disk`);
});

// ---------------------------------------------------------------------------
// 2. Enterprise-only surface gate.
// ---------------------------------------------------------------------------

const NON_ENTERPRISE: WorkspacePlan[] = ["FREE", "PAYG", "PRO", "TEAM"];

test("personal / FREE / PAYG / PRO / TEAM cannot access the external-reviewer governance view", () => {
  for (const plan of NON_ENTERPRISE) {
    assert.equal(
      canAccessSurface(ctxFor(plan), CONCRETE),
      false,
      `${plan} must NOT access ${CONCRETE}`,
    );
  }
});

test("an enterprise workspace CAN access the external-reviewer governance view", () => {
  assert.equal(
    canAccessSurface(ctxFor("ENTERPRISE"), CONCRETE),
    true,
    `ENTERPRISE must access ${CONCRETE}`,
  );
});
