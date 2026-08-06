/**
 * Phase 4 (Enterprise Administration) FINALIZATION — route registration for
 * the three new org-admin tabs (roles / billing / integrations).
 *
 * Pins:
 *   1. Each new route id is registered in routeRegistry.ts with the expected
 *      href, ACCOUNT domain, NONE active-space, and sidebarEligible: false
 *      (mirroring the sibling org-admin tabs).
 *   2. Each new route's href resolves to a real page.tsx on disk.
 *   3. Each new route id is mapped to the ADMIN pillar + a Phase B group.
 *
 * PHASE 12 — the committed compiled routeRegistry.js twin was DELETED
 * (stale-generated-twin eradication); routeRegistry.ts is the ONLY source and
 * every consumer (including the API suite's dynamic imports) resolves it
 * directly, so the old ".ts/.js sync" babysitter test is gone with the twin.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { pillarForRoute } from "../lib/navigation/pillarRegistry";
import { operationalGroupForRoute } from "../lib/navigation/phaseBOperationalGroups";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NEW_ROUTES: ReadonlyArray<{ id: string; href: string }> = [
  { id: "account.organization_admin_roles", href: "/organizations/:id/admin/roles" },
  { id: "account.organization_admin_billing", href: "/organizations/:id/admin/billing" },
  {
    id: "account.organization_admin_integrations",
    href: "/organizations/:id/admin/integrations",
  },
];

type RegistryEntry = {
  id: string;
  href: string;
  domain: string;
  requiredActiveSpace: string;
  sidebarEligible: boolean;
};

const tsById = new Map(
  (ROUTE_REGISTRY as ReadonlyArray<RegistryEntry>).map((r) => [r.id, r]),
);
test("each new tab is registered in routeRegistry.ts with the org-admin contract", () => {
  for (const { id, href } of NEW_ROUTES) {
    const entry = tsById.get(id);
    assert.ok(entry, `${id} must be registered in routeRegistry.ts`);
    assert.equal(entry!.href, href, `${id} href`);
    assert.equal(entry!.domain, "ACCOUNT", `${id} domain`);
    assert.equal(entry!.requiredActiveSpace, "NONE", `${id} active space`);
    assert.equal(entry!.sidebarEligible, false, `${id} sidebarEligible`);
  }
});

test("each new route resolves to a real page.tsx on disk", () => {
  for (const { href } of NEW_ROUTES) {
    // Normalise the registry `:id` to Next's `[id]` file convention.
    const seg = href.replace(/:([A-Za-z0-9_]+)/g, "[$1]");
    const onDisk = existsSync(resolve(APP_ROOT, `app/(app)${seg}/page.tsx`));
    assert.ok(onDisk, `no page.tsx for ${href} (expected app/(app)${seg}/page.tsx)`);
  }
});

test("each new route id maps to the ADMIN pillar and a Phase B operational group", () => {
  for (const { id } of NEW_ROUTES) {
    assert.equal(pillarForRoute(id), "ADMIN", `${id} pillar`);
    assert.ok(
      operationalGroupForRoute(id) !== null,
      `${id} must belong to a Phase B operational group`,
    );
  }
});
