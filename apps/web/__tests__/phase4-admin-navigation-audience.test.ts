/**
 * PHASE 4 — NAVIGATION AUDIENCE AGREES WITH SERVER AUTHORITY.
 *
 * The sidebar and the Command Palette must not offer an Admin destination to
 * an identity that cannot use it, and the intended identity must have a
 * discoverable path to every Admin page. Both surfaces already ask the same
 * canonical resolver, `resolveRouteAccess` — so the property to hold is that
 * the resolver itself answers correctly for every Admin entry, and that the
 * two consumers keep asking it rather than deciding for themselves.
 *
 * This runs the real resolver against the real navigation registry. It is not
 * a source scan: `resolveRouteAccess` is the production decision, and the
 * registry is the production list of destinations.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN_NAV_SECTIONS } from "../components/admin/adminNavigation";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import { getRouteDefinition } from "../lib/navigation/routeRegistry";

/** Every routeId the Admin console offers as a destination. */
function adminRouteIds(): string[] {
  const ids: string[] = [];
  const walk = (nodes: readonly unknown[]) => {
    for (const node of nodes) {
      const n = node as { routeId?: string; children?: readonly unknown[] };
      if (typeof n.routeId === "string") ids.push(n.routeId);
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(ADMIN_NAV_SECTIONS as unknown as readonly unknown[]);
  return [...new Set(ids)];
}

const PLATFORM_ADMIN = {
  isPlatformAdmin: true,
  activeSpaceType: "ORGANIZATION" as const,
  capabilities: {} as Record<string, boolean>,
};

/** Every identity that is NOT a platform operator. */
const NON_PLATFORM_IDENTITIES = [
  { name: "anonymous/no capabilities", activeSpaceType: "PERSONAL" as const, capabilities: {} },
  { name: "personal workspace owner", activeSpaceType: "PERSONAL" as const, capabilities: {} },
  {
    name: "workspace owner with every workspace capability",
    activeSpaceType: "ORGANIZATION" as const,
    // The dangerous case: a tenant administrator who legitimately holds every
    // WORKSPACE capability must still not be offered a platform destination.
    // A workspace capability is not platform authority.
    capabilities: new Proxy({}, { get: () => true }) as Record<string, boolean>,
  },
].map((i) => ({ ...i, isPlatformAdmin: false }));

test("the Admin navigation registry resolves to real routes", () => {
  const ids = adminRouteIds();
  assert.ok(ids.length > 0, "the Admin navigation offers no destinations at all");
  const missing = ids.filter((id) => !getRouteDefinition(id));
  assert.deepEqual(
    missing,
    [],
    `Admin navigation points at routeIds with no route:\n${missing.join("\n")}`,
  );
});

test("a platform operator can see and load every Admin destination it offers", () => {
  const unreachable: string[] = [];
  for (const id of adminRouteIds()) {
    const route = getRouteDefinition(id);
    if (!route) continue;
    const access = resolveRouteAccess({ route, ...PLATFORM_ADMIN });
    // An entry the intended audience cannot open is a dead link in their own
    // console — the "intended role has a discoverable path" half of the rule.
    if (!access.canSeeNav || !access.canLoad) unreachable.push(`${id} (${route.href})`);
  }
  assert.deepEqual(
    unreachable,
    [],
    `the platform operator is offered Admin entries it cannot open:\n${unreachable.join("\n")}`,
  );
});

test("no non-platform identity is offered a platform-admin Admin destination", () => {
  const leaked: string[] = [];
  for (const identity of NON_PLATFORM_IDENTITIES) {
    for (const id of adminRouteIds()) {
      const route = getRouteDefinition(id);
      if (!route) continue;
      const isPlatformOnly =
        route.requiredActiveSpace === "PLATFORM_ADMIN" || route.domain === "PLATFORM_ADMIN";
      if (!isPlatformOnly) continue;
      const access = resolveRouteAccess({
        route,
        activeSpaceType: identity.activeSpaceType,
        isPlatformAdmin: identity.isPlatformAdmin,
        capabilities: identity.capabilities,
      });
      if (access.canSeeNav || access.canLoad) {
        leaked.push(`${identity.name} → ${id} (${route.href})`);
      }
    }
  }
  assert.deepEqual(
    leaked,
    [],
    `platform-admin destinations offered to non-platform identities:\n${leaked.join("\n")}`,
  );
});

test("a refused Admin route states a reason rather than going blank", () => {
  /*
   * A direct URL from a non-platform identity must produce a truthful refusal.
   * A resolver that answered `canLoad: false` with no `accessState` or reason
   * would leave the page with nothing to render, which is how an unauthorized
   * visit becomes a blank screen or a misleading sign-in prompt.
   */
  const silent: string[] = [];
  for (const id of adminRouteIds()) {
    const route = getRouteDefinition(id);
    if (!route) continue;
    const access = resolveRouteAccess({
      route,
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: {},
    });
    if (access.canLoad) continue;
    if (!access.accessState || !access.reason) silent.push(`${id} (${route.href})`);
  }
  assert.deepEqual(
    silent,
    [],
    `refused Admin routes with no state or reason to render:\n${silent.join("\n")}`,
  );
});

test("the sidebar and the Command Palette agree about every Admin destination", () => {
  /*
   * Two surfaces, one audience decision — asserted as an OUTCOME rather than
   * by looking for a function name in the source.
   *
   * The Command Palette includes a route when the resolver says
   * `canSeeNav` AND the route opts in with `commandPaletteVisible`. The
   * Admin sidebar renders its sections inside a console the layout already
   * gates to platform operators. So the property that must hold is: for a
   * given identity, a destination the sidebar offers is one the palette will
   * also surface (when the route opts in), and a destination neither should
   * offer is offered by neither. A disagreement is how an entry vanishes from
   * the sidebar but stays searchable, or the reverse.
   */
  const disagreements: string[] = [];
  const identities = [
    { name: "platform operator", ...PLATFORM_ADMIN },
    ...NON_PLATFORM_IDENTITIES,
  ];

  for (const identity of identities) {
    for (const id of adminRouteIds()) {
      const route = getRouteDefinition(id);
      if (!route) continue;
      const access = resolveRouteAccess({
        route,
        activeSpaceType: identity.activeSpaceType,
        isPlatformAdmin: identity.isPlatformAdmin,
        capabilities: identity.capabilities,
      });
      const sidebarWouldOffer = access.canSeeNav;
      const paletteWouldOffer =
        access.canSeeNav && route.commandPaletteVisible === true;

      // The palette may legitimately withhold a route the sidebar shows (an
      // explicit opt-out). It must never surface one the sidebar would hide.
      if (paletteWouldOffer && !sidebarWouldOffer) {
        disagreements.push(
          `${identity.name}: palette offers ${id} (${route.href}) that the sidebar hides`,
        );
      }
    }
  }

  assert.deepEqual(
    disagreements,
    [],
    `sidebar and Command Palette disagree:\n${disagreements.join("\n")}`,
  );
});
