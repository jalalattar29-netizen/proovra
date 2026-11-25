/**
 * T-125 / PRD-01 / ARCH-09 — the navigation contract resolves.
 *
 * Two promises, proven behaviourally for every context the product sells
 * (Free / Pro / Team on the Personal Workspace by role / Enterprise
 * ORGANIZATION workspace by role, plus a Pro workspace holding a packaging
 * FEATURE_REDACTION grant and a legacy OWNED Team workspace):
 *
 *   1. SERVER NAVIGATION → WEB. Every item the `GET /v1/platform/context`
 *      `navigation` payload advertises (built here by calling the server's
 *      own builders with the server's own capability resolver) names a real
 *      page under `app/(app)` and OPENS for that context: the route registry
 *      (`resolveRouteAccess`, mounted by PageRouteGate and every nav surface)
 *      answers ALLOWED, and the surface layer (`getDirectAccessDecision`,
 *      mounted by EnterpriseSurfaceLayout/SurfaceGate) answers allow — no 404,
 *      no redirect, no upgrade panel.
 *
 *   2. ONE COMMERCIAL ANSWER. For every path gated by BOTH web engines, the
 *      commercial decision (role capabilities neutralised) is the same in the
 *      registry and in the surface tier table, for every context. The tier
 *      table no longer carries its own entitlement key: it reads the
 *      registry's `requiredPlanFeature`, so the two cannot drift again.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getPlanCapabilities } from "@proovra/shared-billing";

import { resolveCapabilities } from "../../../services/api/src/services/platform-context/capability-registry";
import {
  buildNavigationProjection,
  filterNavigationRegistry,
} from "../../../services/api/src/services/platform-context/navigation-registry";
import {
  ROUTE_REGISTRY,
  getRouteDefinition,
  findRouteDefinitionByPath,
  type RouteDefinition,
} from "../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import {
  getDirectAccessDecision,
  ruleEntitlement,
  type SurfaceUserContext,
} from "../lib/surface/access";
import { surfaceUserContextFromEnvelope } from "../lib/surface/useSurfaceUserContext";
import { routeRequiresEnterpriseWorkspace } from "../lib/navigation/routeRegistry";
import { SURFACE_TIER_RULES, findSurfaceTierRule } from "../lib/surface/tiers";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(APP_ROOT, "app", "(app)");

type Plan = "FREE" | "PRO" | "TEAM" | "ENTERPRISE";
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
type Kind = "PERSONAL" | "OWNED" | "ORGANIZATION";

type Ctx = {
  name: string;
  plan: Plan;
  role: Role;
  kind: Kind;
  isEnterpriseWorkspace: boolean;
  /** Packaging FEATURE_REDACTION grant (planFeatures.redactionIncluded). */
  redaction: boolean;
  /**
   * Enterprise contract narrowing of the review ladder
   * (`resolveEffectiveReviewCapabilities`): a contract may sell assignments
   * (REVIEW_ASSIGNMENTS → reviewerOperationsIncluded) without shared queues
   * (REVIEW_TASKS_AND_QUEUES → reviewQueuesIncluded).
   */
  narrowed?: Partial<Record<"reviewerOperationsIncluded" | "reviewQueuesIncluded", boolean>>;
};

const CONTEXTS: Ctx[] = [
  { name: "FREE personal owner", plan: "FREE", role: "OWNER", kind: "PERSONAL", isEnterpriseWorkspace: false, redaction: false },
  { name: "PRO personal owner", plan: "PRO", role: "OWNER", kind: "PERSONAL", isEnterpriseWorkspace: false, redaction: false },
  { name: "PRO personal owner + FEATURE_REDACTION grant", plan: "PRO", role: "OWNER", kind: "PERSONAL", isEnterpriseWorkspace: false, redaction: true },
  { name: "TEAM personal owner", plan: "TEAM", role: "OWNER", kind: "PERSONAL", isEnterpriseWorkspace: false, redaction: false },
  { name: "TEAM personal admin", plan: "TEAM", role: "ADMIN", kind: "PERSONAL", isEnterpriseWorkspace: false, redaction: false },
  { name: "TEAM personal member", plan: "TEAM", role: "MEMBER", kind: "PERSONAL", isEnterpriseWorkspace: false, redaction: false },
  { name: "TEAM personal viewer", plan: "TEAM", role: "VIEWER", kind: "PERSONAL", isEnterpriseWorkspace: false, redaction: false },
  { name: "TEAM legacy OWNED owner", plan: "TEAM", role: "OWNER", kind: "OWNED", isEnterpriseWorkspace: false, redaction: false },
  { name: "ENTERPRISE org owner", plan: "ENTERPRISE", role: "OWNER", kind: "ORGANIZATION", isEnterpriseWorkspace: true, redaction: true },
  { name: "ENTERPRISE org admin", plan: "ENTERPRISE", role: "ADMIN", kind: "ORGANIZATION", isEnterpriseWorkspace: true, redaction: true },
  { name: "ENTERPRISE org member", plan: "ENTERPRISE", role: "MEMBER", kind: "ORGANIZATION", isEnterpriseWorkspace: true, redaction: true },
  { name: "ENTERPRISE org viewer", plan: "ENTERPRISE", role: "VIEWER", kind: "ORGANIZATION", isEnterpriseWorkspace: true, redaction: true },
  { name: "ENTERPRISE org owner, contract without shared queues", plan: "ENTERPRISE", role: "OWNER", kind: "ORGANIZATION", isEnterpriseWorkspace: true, redaction: true, narrowed: { reviewQueuesIncluded: false } },
];

/**
 * `envelope.planFeatures` as `platform-context.service.ts` projects it: the
 * catalog booleans plus the review ladder (BASIC_RECORD_REVIEW Pro+,
 * REVIEW_ASSIGNMENTS / REVIEW_TASKS_AND_QUEUES Team+) and the packaging
 * FEATURE_REDACTION answer.
 */
function planFeaturesFor(ctx: Ctx): Record<string, boolean> {
  const caps = getPlanCapabilities(ctx.plan);
  const teamPlus = ctx.plan === "TEAM" || ctx.plan === "ENTERPRISE";
  const proPlus = teamPlus || ctx.plan === "PRO";
  return {
    reportsIncluded: caps.reportsIncluded,
    verificationPackageIncluded: caps.verificationPackageIncluded,
    intakeIncluded: caps.intakeIncluded,
    casesIncluded: caps.casesIncluded,
    reviewerOperationsIncluded: teamPlus,
    basicRecordReviewIncluded: proPlus,
    professionalSurfacesIncluded: caps.professionalSurfacesIncluded,
    reviewQueuesIncluded: teamPlus,
    teamCollaborationIncluded: caps.maxCollaborationTeamsPerWorkspace > 0,
    externalReviewIncluded: proPlus,
    redactionIncluded: ctx.redaction,
    redactionReadRetained: false,
    ...ctx.narrowed,
  };
}

function capabilitiesFor(ctx: Ctx): Record<string, boolean> {
  const pf = planFeaturesFor(ctx);
  return resolveCapabilities({
    scope: ctx.kind === "PERSONAL" ? "PERSONAL" : "TEAM",
    workspaceKind: ctx.kind,
    role: ctx.role,
    plan: ctx.plan,
    isPlatformAdmin: false,
    packageProducesOperationalConditions: ctx.plan !== "FREE",
    memberCount: ctx.kind === "PERSONAL" && ctx.plan !== "TEAM" ? 1 : 3,
    collaborationIncluded: pf.teamCollaborationIncluded,
    reviewerOperationsIncluded: pf.reviewerOperationsIncluded,
  }) as unknown as Record<string, boolean>;
}

function activeSpaceType(ctx: Ctx): "PERSONAL" | "ORGANIZATION" {
  return ctx.kind === "PERSONAL" ? "PERSONAL" : "ORGANIZATION";
}

/** What the server projection is told about the active workspace. */
function serverNavContext(ctx: Ctx) {
  return {
    activeSpaceType: activeSpaceType(ctx),
    isEnterpriseWorkspace: ctx.isEnterpriseWorkspace,
    isPlatformAdmin: false,
    planFeatures: planFeaturesFor(ctx),
  };
}

function surfaceCtx(ctx: Ctx): SurfaceUserContext {
  return {
    isPlatformAdmin: false,
    isEnterpriseWorkspace: ctx.isEnterpriseWorkspace,
    planFeatures: planFeaturesFor(ctx) as SurfaceUserContext["planFeatures"],
  };
}

function registryDecision(ctx: Ctx, route: RouteDefinition, capabilities: Record<string, boolean>) {
  return resolveRouteAccess({
    route,
    activeSpaceType: activeSpaceType(ctx),
    isPlatformAdmin: false,
    capabilities,
    workspace: { id: "w-1", status: "active" },
    personalSpace: { id: "p-1", status: "active" },
    isEnterpriseWorkspace: ctx.isEnterpriseWorkspace,
    planFeatures: planFeaturesFor(ctx),
  });
}

type AdvertisedItem = { id: string; href: string };

/** Every item the server's navigation payload carries, from every projection. */
function advertisedItems(ctx: Ctx): AdvertisedItem[] {
  const caps = capabilitiesFor(ctx);
  const nav = serverNavContext(ctx);
  // The builders take the gate context as their second argument; the old
  // capability-only builders ignored it (that is the defect).
  const build = buildNavigationProjection as unknown as (c: unknown, n: unknown) => ReturnType<typeof buildNavigationProjection>;
  const legacy = filterNavigationRegistry as unknown as (c: unknown, n: unknown) => ReturnType<typeof filterNavigationRegistry>;
  const projection = build(caps, nav);
  const out = new Map<string, AdvertisedItem>();
  for (const group of legacy(caps, nav)) for (const item of group.items) out.set(item.id, item);
  for (const group of projection.sidebar.groups) for (const item of group.items) out.set(item.id, item);
  for (const pillar of projection.sidebar.pillars) for (const item of pillar.items) out.set(item.id, item);
  for (const item of projection.accountMenu.items) out.set(item.id, item);
  return [...out.values()];
}

/** The web registry entry an advertised item lands on. */
function webRouteFor(item: AdvertisedItem): RouteDefinition | null {
  const byId = getRouteDefinition(item.id);
  if (byId && byId.href === item.href) return byId;
  return findRouteDefinitionByPath(item.href);
}

function pageExists(href: string): boolean {
  const segments = href.split(/[?#]/)[0]!.split("/").filter(Boolean);
  return existsSync(join(APP_DIR, ...segments, "page.tsx"));
}

for (const ctx of CONTEXTS) {
  test(`server navigation resolves on the web — ${ctx.name}`, () => {
    const caps = capabilitiesFor(ctx);
    const failures: string[] = [];
    for (const item of advertisedItems(ctx)) {
      if (!pageExists(item.href)) {
        failures.push(`${item.id} ${item.href}: no page under app/(app)`);
        continue;
      }
      const route = webRouteFor(item);
      if (!route) {
        failures.push(`${item.id} ${item.href}: no route registry entry`);
        continue;
      }
      const decision = registryDecision(ctx, route, caps);
      if (!(decision.canLoad && decision.canSeeNav && decision.accessState === "ALLOWED")) {
        failures.push(`${item.id} ${item.href}: registry ${route.id} → ${decision.accessState}`);
      }
      const surface = getDirectAccessDecision(surfaceCtx(ctx), item.href);
      if (surface.kind !== "allow") {
        failures.push(`${item.id} ${item.href}: surface gate → ${surface.kind}`);
      }
    }
    assert.deepEqual(failures, [], `${ctx.name}: advertised items that do not open:\n  ${failures.join("\n  ")}`);
  });
}

test("the Team owner navigation still advertises Review (the payload was narrowed, not emptied)", () => {
  const team = CONTEXTS.find((c) => c.name === "TEAM personal owner")!;
  const ids = advertisedItems(team).map((i) => i.id);
  assert.ok(ids.includes("review.queue"), ids.join(", "));
  assert.ok(ids.includes("workspace.evidence"), ids.join(", "));
  const enterprise = CONTEXTS.find((c) => c.name === "ENTERPRISE org owner")!;
  const entIds = advertisedItems(enterprise).map((i) => i.id);
  assert.ok(entIds.includes("governance.hub"), entIds.join(", "));
  assert.ok(entIds.includes("workspace.review_redaction"), entIds.join(", "));
});

/** A concrete URL for a registry href (`:id` / `[id]` → a sample segment). */
function concrete(href: string): string {
  return href
    .split("/")
    .map((s) => (s.startsWith(":") || (s.startsWith("[") && s.endsWith("]")) ? "x0" : s))
    .join("/");
}

/** The `app/(app)` directory chain a URL renders through (dynamic segments resolved). */
function directoryChain(url: string): string[] | null {
  const chain: string[] = [APP_DIR];
  let dir = APP_DIR;
  for (const seg of url.split("/").filter(Boolean)) {
    const literal = join(dir, seg);
    if (existsSync(literal)) {
      dir = literal;
    } else {
      const dynamic = existsSync(dir)
        ? readdirSync(dir).find((d) => d.startsWith("[") && !d.startsWith("[["))
        : undefined;
      if (!dynamic) return null;
      dir = join(dir, dynamic);
    }
    chain.push(dir);
  }
  return existsSync(join(dir, "page.tsx")) ? chain : null;
}

/** Does SurfaceGate (directly or via EnterpriseSurfaceLayout) wrap this page? */
function surfaceGateMounted(url: string): boolean {
  const chain = directoryChain(url);
  if (!chain) return false;
  const files = [...chain.map((d) => join(d, "layout.tsx")), join(chain[chain.length - 1]!, "page.tsx")];
  return files.some(
    (f) => existsSync(f) && /\b(SurfaceGate|EnterpriseSurfaceLayout)\b/.test(readFileSync(f, "utf8")),
  );
}

/** A registry route carries a commercial gate (plan feature or Enterprise workspace). */
function hasCommercialGate(route: RouteDefinition): boolean {
  return Boolean(route.requiredPlanFeature || route.navPlanFeature || routeRequiresEnterpriseWorkspace(route));
}

/**
 * Pages BOTH engines gate commercially: the registry route carries a plan /
 * Enterprise gate, the page renders under SurfaceGate, and the tier rule for
 * its URL can refuse (not a plain `allow`). Iterated from both tables at run
 * time, so a route another stage turns into a redirect (e.g.
 * `/review/operations`) simply drops out or is compared as it then stands.
 */
function doublyGatedRoutes(): Array<{ route: RouteDefinition; url: string }> {
  const out: Array<{ route: RouteDefinition; url: string }> = [];
  for (const route of ROUTE_REGISTRY) {
    if (route.href.includes("#")) continue;
    if (route.requiredActiveSpace === "PLATFORM_ADMIN" || route.domain === "PLATFORM_ADMIN") continue;
    if (!hasCommercialGate(route)) continue;
    const url = concrete(route.href);
    const rule = findSurfaceTierRule(url);
    if (!rule || rule.directAccessPolicy === "allow" || rule.tier === "INTERNAL") continue;
    if (!surfaceGateMounted(url)) continue;
    out.push({ route, url });
  }
  return out;
}

const ALL_CAPS = new Proxy({}, { get: () => true }) as Record<string, boolean>;

test("both web gate engines gate the review, redaction and Enterprise pages", () => {
  const urls = doublyGatedRoutes().map((r) => r.url);
  for (const u of ["/review", "/review/queues", "/review/qc", "/redaction", "/workflows", "/governance"]) {
    assert.ok(urls.includes(u), `${u} is gated by both engines (have: ${urls.join(", ")})`);
  }
});

for (const ctx of CONTEXTS) {
  test(`registry and surface tier give one commercial answer — ${ctx.name}`, () => {
    const mismatches: string[] = [];
    for (const { route, url } of doublyGatedRoutes()) {
      // Role capabilities neutralised: this compares the COMMERCIAL layer
      // (plan feature, read-retained, Enterprise workspace, workspace kind) —
      // the only layer the tier table claims.
      const registry = registryDecision(ctx, route, ALL_CAPS);
      const surface = getDirectAccessDecision(surfaceCtx(ctx), url);
      if (registry.canLoad !== (surface.kind === "allow")) {
        mismatches.push(`${url} (${route.id}): registry ${registry.accessState}/canLoad=${registry.canLoad}, surface ${surface.kind}`);
      }
    }
    assert.deepEqual(mismatches, [], `${ctx.name}:\n  ${mismatches.join("\n  ")}`);
  });
}

test("redaction: one answer for a granted, a lapsed-with-material and an ungranted workspace", () => {
  const route = getRouteDefinition("workspace.review_redaction")!;
  const base = CONTEXTS.find((c) => c.name === "TEAM personal owner")!;
  const cases: Array<{ name: string; included: boolean; retained: boolean; load: boolean; nav: boolean }> = [
    { name: "granted", included: true, retained: false, load: true, nav: true },
    { name: "lapsed, material kept", included: false, retained: true, load: true, nav: false },
    { name: "never granted", included: false, retained: false, load: false, nav: false },
  ];
  for (const c of cases) {
    const pf = { ...planFeaturesFor(base), redactionIncluded: c.included, redactionReadRetained: c.retained };
    const decision = resolveRouteAccess({
      route,
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: capabilitiesFor(base),
      workspace: { id: "w-1", status: "active" },
      personalSpace: { id: "p-1", status: "active" },
      isEnterpriseWorkspace: false,
      planFeatures: pf,
    });
    const surface = getDirectAccessDecision(
      { isPlatformAdmin: false, isEnterpriseWorkspace: false, planFeatures: pf as SurfaceUserContext["planFeatures"] },
      "/redaction",
    );
    assert.equal(decision.canLoad, c.load, `${c.name}: registry load`);
    assert.equal(decision.canSeeNav, c.nav, `${c.name}: registry nav`);
    assert.equal(surface.kind === "allow", c.load, `${c.name}: surface gate`);
  }
});

test("every tier rule that follows an entitlement names a registry route that declares one, carried by the surface context", () => {
  const carried = surfaceUserContextFromEnvelope({
    planFeatures: {
      reviewerOperationsIncluded: true,
      reviewQueuesIncluded: true,
      externalReviewIncluded: true,
      redactionIncluded: true,
      redactionReadRetained: true,
      intakeIncluded: true,
      professionalSurfacesIncluded: true,
    },
  } as unknown as Parameters<typeof surfaceUserContextFromEnvelope>[0]).planFeatures as Record<string, unknown>;
  const following = SURFACE_TIER_RULES.filter((r) => r.entitlementRouteId);
  assert.ok(following.length >= 12, "the review hub and redaction rules follow the registry");
  for (const rule of following) {
    const entitlement = ruleEntitlement(rule);
    assert.ok(entitlement, `${rule.pathPrefix} → ${rule.entitlementRouteId} declares no requiredPlanFeature`);
    assert.equal(typeof carried[entitlement.key], "boolean", `${rule.pathPrefix}: surface context lacks ${entitlement.key}`);
    if (entitlement.readRetainedKey) {
      assert.equal(typeof carried[entitlement.readRetainedKey], "boolean", `${rule.pathPrefix}: surface context lacks ${entitlement.readRetainedKey}`);
    }
  }
  // The drift this removed: one key per surface.
  assert.equal(ruleEntitlement(findSurfaceTierRule("/review/queues"))?.key, getRouteDefinition("workspace.review_queues")?.requiredPlanFeature);
  assert.equal(ruleEntitlement(findSurfaceTierRule("/redaction"))?.key, "redactionIncluded");
});

test("the tier table carries no entitlement key of its own (folded into the registry)", () => {
  for (const rule of SURFACE_TIER_RULES) {
    assert.equal(
      (rule as Record<string, unknown>).entitlementOverride,
      undefined,
      `${rule.pathPrefix} still declares its own entitlementOverride`,
    );
    assert.equal(
      (rule as Record<string, unknown>).readRetainedOverride,
      undefined,
      `${rule.pathPrefix} still declares its own readRetainedOverride`,
    );
  }
});
