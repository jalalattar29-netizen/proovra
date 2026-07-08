/**
 * Phase 4 (Enterprise Administration) FINALIZATION — route registration for
 * the three new org-admin tabs (roles / billing / integrations).
 *
 * Pins:
 *   1. Each new route id is registered in routeRegistry.ts with the expected
 *      href, ACCOUNT domain, NONE active-space, and sidebarEligible: false
 *      (mirroring the sibling org-admin tabs).
 *   2. routeRegistry.ts and routeRegistry.js stay in sync (the compiled .js
 *      copy the API tests import must not drift from the .ts source).
 *   3. Each new route's href resolves to a real page.tsx on disk.
 *   4. Each new route id is mapped to the ADMIN pillar + a Phase B group.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
// The self-contained compiled copy the API test-suite imports.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .js sibling has no .d.ts; shape is asserted structurally.
import { ROUTE_REGISTRY as ROUTE_REGISTRY_JS } from "../lib/navigation/routeRegistry.js";
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
const jsById = new Map(
  (ROUTE_REGISTRY_JS as ReadonlyArray<RegistryEntry>).map((r) => [r.id, r]),
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

test("routeRegistry.ts and routeRegistry.js are in sync for the org-admin tabs", () => {
  // Same set of ids, and every new entry is byte-identical on the pinned
  // fields across the .ts source and the compiled .js copy.
  const tsIds = new Set(tsById.keys());
  const jsIds = new Set(jsById.keys());
  assert.equal(
    tsIds.size,
    jsIds.size,
    "routeRegistry.ts and .js have a different number of routes (drift)",
  );
  for (const id of tsIds) {
    assert.ok(jsIds.has(id), `route ${id} present in .ts but missing from .js`);
  }
  for (const { id } of NEW_ROUTES) {
    const t = tsById.get(id)!;
    const j = jsById.get(id)!;
    assert.deepEqual(
      {
        href: t.href,
        domain: t.domain,
        requiredActiveSpace: t.requiredActiveSpace,
        sidebarEligible: t.sidebarEligible,
      },
      {
        href: j.href,
        domain: j.domain,
        requiredActiveSpace: j.requiredActiveSpace,
        sidebarEligible: j.sidebarEligible,
      },
      `${id} drifted between routeRegistry.ts and routeRegistry.js`,
    );
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
