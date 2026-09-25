/**
 * T-09f / RC-10 (SB-4, SB-5) — native navigation must be the web sidebar's
 * decision, not a hand-kept list.
 *
 * THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ----------------------------------------
 * Native navigation was `useNavItems()`: a hardcoded seven-item array with no
 * icons, no groups and no access decision. The web sidebar is derived from
 * `ROUTE_REGISTRY` through `resolveRouteAccess` → exposure → disclosure →
 * grouping (`AppSidebarV2.tsx:19-44`). Nothing tied the two together, so the
 * native list said "Alerts" where the web said "Notifications", offered no
 * Billing, hid Intake links and Collaboration Teams from every workspace whose
 * plan includes them, and showed every destination to every member regardless
 * of capability.
 *
 * HOW THIS TEST IS FALSIFIABLE
 * ----------------------------
 * It does not compare against a copy of the web's answer. It BUNDLES the web's
 * own navigation modules with esbuild and EXECUTES them — the same functions
 * `AppSidebarV2` calls — over an envelope matrix, then requires the native
 * resolver to produce the identical grouped list for the destinations native
 * implements. A change to the web registry, resolver order or grouping fails
 * here until native follows.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const WEB = resolve(MOBILE, "../web");
const CACHE = resolve(MOBILE, "node_modules/.render-test-cache");

async function bundle(name, contents, resolveDir) {
  const out = await build({
    stdin: { contents, resolveDir, sourcefile: `${name}.ts`, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "node20",
    logLevel: "silent",
  });
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, `${name}-${Date.now()}.mjs`);
  await writeFile(file, out.outputFiles[0].text, "utf8");
  return import(pathToFileURL(file).href);
}

let W; // the web's navigation pipeline, executed
let N; // the native model

before(async () => {
  W = await bundle(
    "web-nav",
    [
      `export { ROUTE_REGISTRY, ENTERPRISE_ONLY_ROUTE_IDS } from "./lib/navigation/routeRegistry";`,
      `export { resolveRouteAccess } from "./lib/navigation/routeAccessResolver";`,
      `export { resolveNavigationExposure } from "./lib/navigation/navigationExposureResolver";`,
      `export { resolveNavigationDisclosure } from "./lib/navigation/navigationDisclosureResolver";`,
      `export { resolveNavigationGroups } from "./lib/navigation/navigationGroupingResolver";`,
      `export { DEGRADATION_CHIP_LABELS } from "./lib/navigation/canonicalNavigationGroups";`,
      `export { resolveWorkspaceExperience } from "./lib/workspace-experience/resolveWorkspaceExperience";`,
    ].join("\n"),
    WEB,
  );
  N = await bundle("native-nav", `export * from "./src/product/navigation";`, MOBILE);
});

/** Every capability any registry route requires — the "full member" set. */
function allCapabilities() {
  const caps = {};
  for (const r of W.ROUTE_REGISTRY) for (const c of r.requiredCapabilities ?? []) caps[c] = true;
  return caps;
}

/**
 * The web sidebar for an envelope, computed EXACTLY as AppSidebarV2 computes
 * it (AppSidebarV2.tsx:522-640), including its sidebar-local suppression of
 * organization-only routes outside an organization.
 */
function webSidebar(env) {
  const activeSpaceType = env.activeSpace?.type ?? null;
  const isPlatformAdmin = env.platform?.isPlatformAdmin === true;
  const capabilities = env.capabilities ?? {};
  const resolved = W.ROUTE_REGISTRY.map((route) => {
    const access = W.resolveRouteAccess({
      route,
      activeSpaceType,
      isPlatformAdmin,
      capabilities,
      accountPlan: null,
      isEnterpriseWorkspace: env.flags?.isEnterpriseWorkspace === true,
      planFeatures: env.planFeatures ?? null,
      workspace: env.workspace ? { id: env.workspace.id ?? null, status: env.workspace.status ?? null } : null,
      personalSpace: env.personalSpace
        ? { id: env.personalSpace.id ?? null, status: env.personalSpace.status ?? null }
        : null,
    });
    if (access.canSeeNav && access.accessState === "NEEDS_ORGANIZATION" && activeSpaceType !== "ORGANIZATION" && !isPlatformAdmin) {
      return { route, access: { ...access, canSeeNav: false } };
    }
    return { route, access };
  });
  const exposure = W.resolveNavigationExposure({ routes: resolved });
  const experience = W.resolveWorkspaceExperience({ activeSpaceType, capabilities });
  const disclosure = W.resolveNavigationDisclosure({ exposure, demotionRouteIds: experience.demotionRouteIds });
  const { groups } = W.resolveNavigationGroups({
    primaryItems: disclosure.primaryItems,
    secondaryItems: disclosure.secondaryItems,
  });
  const chip = (a) => (a.canLoad ? null : W.DEGRADATION_CHIP_LABELS[a.accessState] ?? null);
  return {
    groups: groups
      .filter((g) => g.items.length > 0)
      .map((g) => ({
        title: g.title,
        items: g.items.map((i) => ({ id: i.route.id, state: i.access.accessState, canLoad: i.access.canLoad, chip: chip(i.access) })),
      })),
    more: disclosure.moreAdvancedItems.map((i) => i.route.id),
  };
}

function nativeSidebar(env) {
  return N.resolveNativeNavigation(N.navigationInputFromEnvelope(env)).map((g) => ({
    title: g.title,
    items: g.items.map((i) => ({ id: i.route.id, state: i.access.accessState, canLoad: i.access.canLoad, chip: i.chip })),
  }));
}

/** The envelope matrix: space × admin × enterprise × capabilities × plan × workspace evidence. */
function envelopes() {
  const full = allCapabilities();
  const capSets = {
    all: full,
    none: {},
    noBilling: { ...full, ACCOUNT_BILLING_VIEW: false },
    noCases: { ...full, CASES_VIEW: false },
    noSearch: { ...full, SEARCH_VIEW: false },
    noIntake: { ...full, INTAKE_LINKS_MANAGE: false },
    noOperations: { ...full, OPERATIONS_VIEW: false },
    noReports: { ...full, REPORTS_VIEW: false },
  };
  const plans = {
    none: null,
    empty: {},
    intake: { intakeIncluded: true },
    collab: { teamCollaborationIncluded: true },
    both: { intakeIncluded: true, teamCollaborationIncluded: true, reviewerOperationsIncluded: true },
  };
  const out = [];
  for (const type of ["PERSONAL", "ORGANIZATION", null]) {
    for (const admin of [false, true]) {
      for (const ent of [false, true]) {
        for (const [capName, caps] of Object.entries(capSets)) {
          for (const [planName, pf] of Object.entries(plans)) {
            // Workspace evidence: both, legacy workspace only, personal space
            // only, a degraded personal space, a "no-workspace" row, none.
            const spaces = {
              both: [{ id: "w1", status: "active" }, { id: "p1", status: "active" }],
              wsOnly: [{ id: "w1", status: "active" }, undefined],
              psOnly: [undefined, { id: "p1", status: "active" }],
              psDegraded: [undefined, { id: "p1", status: "degraded" }],
              noWorkspace: [{ id: "w1", status: "no-workspace" }, undefined],
              none: [undefined, undefined],
            };
            for (const [wsName, [workspace, personalSpace]] of Object.entries(spaces)) {
              out.push({
                label: `${type}/admin=${admin}/ent=${ent}/caps=${capName}/plan=${planName}/ws=${wsName}`,
                env: {
                  activeSpace: type ? { id: "w1", type } : {},
                  platform: { isPlatformAdmin: admin },
                  flags: { isEnterpriseWorkspace: ent },
                  capabilities: caps,
                  planFeatures: pf,
                  workspace,
                  personalSpace,
                },
              });
            }
          }
        }
      }
    }
  }
  return out;
}

test("native registry fields are the web registry's, field for field", () => {
  const byId = new Map(W.ROUTE_REGISTRY.map((r) => [r.id, r]));
  for (const n of N.NATIVE_NAV_ROUTES) {
    const w = byId.get(n.id);
    assert.ok(w, `${n.id} is not a web registry id`);
    assert.equal(n.webHref, w.href, `${n.id}: href`);
    assert.equal(n.label, w.label, `${n.id}: label`);
    assert.equal(n.domain, w.domain, `${n.id}: domain`);
    assert.deepEqual([...n.requiredCapabilities], [...w.requiredCapabilities], `${n.id}: requiredCapabilities`);
    assert.equal(n.requiredActiveSpace, w.requiredActiveSpace, `${n.id}: requiredActiveSpace`);
    assert.equal(n.fallbackBehavior, w.fallbackBehavior, `${n.id}: fallbackBehavior`);
    assert.equal(n.requiredPlanFeature, w.requiredPlanFeature, `${n.id}: requiredPlanFeature`);
    assert.equal(n.navPlanFeature, w.navPlanFeature, `${n.id}: navPlanFeature`);
    assert.equal(n.enterpriseOnly === true, W.ENTERPRISE_ONLY_ROUTE_IDS.has(n.id), `${n.id}: enterprise-only`);
    assert.equal(w.sidebarEligible, true, `${n.id} is not sidebar-eligible on the web, so native must not offer it in navigation`);
  }
});

test("per destination, the native access decision equals the web's over the whole matrix", () => {
  const byId = new Map(W.ROUTE_REGISTRY.map((r) => [r.id, r]));
  let checked = 0;
  for (const { label, env } of envelopes()) {
    const input = N.navigationInputFromEnvelope(env);
    for (const n of N.NATIVE_NAV_ROUTES) {
      const w = W.resolveRouteAccess({
        route: byId.get(n.id),
        activeSpaceType: input.activeSpaceType,
        isPlatformAdmin: input.isPlatformAdmin,
        capabilities: input.capabilities,
        accountPlan: null,
        isEnterpriseWorkspace: input.isEnterpriseWorkspace,
        planFeatures: input.planFeatures,
        workspace: input.workspace,
        personalSpace: input.personalSpace,
      });
      const nat = N.resolveNativeRouteAccess(n, input);
      assert.deepEqual(
        { canLoad: nat.canLoad, canSeeNav: nat.canSeeNav, accessState: nat.accessState },
        { canLoad: w.canLoad, canSeeNav: w.canSeeNav, accessState: w.accessState },
        `${n.id} under ${label}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 5000, `the matrix is too small to mean anything (${checked})`);
});

/** A web registry route in the native shape, so the native resolver can judge it. */
function asNative(w, group = "WORKSPACE") {
  return {
    ...w,
    webHref: w.href,
    enterpriseOnly: W.ENTERPRISE_ONLY_ROUTE_IDS.has(w.id),
    group,
    icon: "archive",
  };
}

test("the PORTED resolver equals the web resolver for EVERY registry route, not only today's native ones", () => {
  // The native set exercises only some branches (no native destination is
  // organization-only, platform-admin or HIDDEN_IF_NO_CAPABILITY today). Judging
  // the whole registry proves every branch of the port, so adding such a
  // destination later cannot expose an untested path.
  let checked = 0;
  const states = new Set();
  for (const { label, env } of envelopes()) {
    const input = N.navigationInputFromEnvelope(env);
    for (const w of W.ROUTE_REGISTRY) {
      const web = W.resolveRouteAccess({
        route: w,
        activeSpaceType: input.activeSpaceType,
        isPlatformAdmin: input.isPlatformAdmin,
        capabilities: input.capabilities,
        accountPlan: null,
        isEnterpriseWorkspace: input.isEnterpriseWorkspace,
        planFeatures: input.planFeatures,
        workspace: input.workspace,
        personalSpace: input.personalSpace,
      });
      const nat = N.resolveNativeRouteAccess(asNative(w), input);
      if (nat.canLoad !== web.canLoad || nat.canSeeNav !== web.canSeeNav || nat.accessState !== web.accessState) {
        assert.fail(`${w.id} under ${label}: native ${JSON.stringify(nat)} vs web ${web.accessState}/${web.canLoad}/${web.canSeeNav}`);
      }
      states.add(web.accessState);
      checked += 1;
    }
  }
  for (const s of ["ALLOWED", "NEEDS_ORGANIZATION", "NEEDS_PERSONAL_OR_ORG", "DENIED_NO_CAPABILITY", "NEEDS_UPGRADE", "PLATFORM_ADMIN_ONLY"]) {
    assert.ok(states.has(s), `the matrix never produced ${s}, so that branch is unproven`);
  }
  assert.ok(checked > 100_000, `too few decisions compared (${checked})`);
});

test("outside an organization, an organization-only destination is hidden, not chipped — as the web sidebar does", () => {
  const hub = W.ROUTE_REGISTRY.find((r) => r.id === "governance.hub");
  const routes = [...N.NATIVE_NAV_ROUTES, asNative(hub, "GOVERNANCE")];
  const caps = allCapabilities();
  const ids = (env) =>
    N.resolveNativeNavigation(N.navigationInputFromEnvelope(env), routes).flatMap((g) => g.items.map((i) => i.route.id));
  // Governance is also Enterprise-only, so both envelopes carry the Enterprise flag:
  // the ONLY difference between them is the active space type.
  const personal = { activeSpace: { id: "w", type: "PERSONAL" }, capabilities: caps, flags: { isEnterpriseWorkspace: true } };
  const org = { activeSpace: { id: "w", type: "ORGANIZATION" }, capabilities: caps, flags: { isEnterpriseWorkspace: true } };
  assert.ok(!ids(personal).includes("governance.hub"), "an org-only destination was offered in a personal space");
  assert.ok(ids(org).includes("governance.hub"), "an org-only destination was withheld inside an organization");
  // And it agrees with the web sidebar in both.
  assert.equal(webSidebar(personal).groups.some((g) => g.items.some((i) => i.id === "governance.hub")), false);
  assert.equal(webSidebar(org).groups.some((g) => g.items.some((i) => i.id === "governance.hub")), true);
});

test("the grouped native navigation equals the web sidebar restricted to native destinations", () => {
  const nativeIds = new Set(N.NATIVE_NAV_ROUTES.map((r) => r.id));
  for (const { label, env } of envelopes()) {
    const web = webSidebar(env);
    const expected = web.groups
      .map((g) => ({ title: g.title, items: g.items.filter((i) => nativeIds.has(i.id)) }))
      .filter((g) => g.items.length > 0);
    assert.deepEqual(nativeSidebar(env), expected, `grouped navigation differs under ${label}`);
  }
});

test("no web sidebar destination goes missing silently", () => {
  // Every destination the web sidebar renders (outside More / Advanced) is
  // either implemented natively or named, with a reason, in the absence list.
  const nativeIds = new Set(N.NATIVE_NAV_ROUTES.map((r) => r.id));
  const declared = new Set(Object.keys(N.WEB_SIDEBAR_ROUTES_WITHOUT_NATIVE_SCREEN));
  const undeclared = new Set();
  const seen = new Set();
  for (const { env } of envelopes()) {
    for (const g of webSidebar(env).groups) {
      for (const i of g.items) {
        seen.add(i.id);
        if (!nativeIds.has(i.id) && !declared.has(i.id)) undeclared.add(i.id);
      }
    }
  }
  assert.deepEqual([...undeclared], [], "web sidebar destinations with no native entry and no recorded reason");
  // And the absence list must not keep stale entries once native implements one.
  for (const id of declared) assert.ok(!nativeIds.has(id), `${id} is implemented natively but still listed as absent`);
  for (const id of declared) assert.ok(seen.has(id), `${id} is listed as absent but the web sidebar never renders it`);
});

test("every native destination wears the web's glyph (Lucide → its Feather ancestor)", () => {
  const src = readFileSync(resolve(WEB, "lib/navigation/routeIcons.ts"), "utf8");
  const LUCIDE_TO_FEATHER = {
    Home: "home",
    Inbox: "inbox",
    BriefcaseBusiness: "briefcase",
    FolderArchive: "archive",
    Camera: "camera",
    Link2: "link-2",
    Search: "search",
    UsersRound: "users",
    FileText: "file-text",
    CreditCard: "credit-card",
    Radio: "radio",
    HeartPulse: "activity",
  };
  const glyphs = readFileSync(
    resolve(MOBILE, "node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Feather.json"),
    "utf8",
  );
  const feather = JSON.parse(glyphs);
  for (const n of N.NATIVE_NAV_ROUTES) {
    // routeIconFor(): the explicit entry, then the family fallback — as the web resolves it.
    const explicit = src.match(new RegExp(`"${n.id.replace(/\./g, "\\.")}":\\s*(\\w+),`));
    const familyBlock = src.slice(src.indexOf("const ICON_BY_FAMILY"));
    const family = familyBlock.match(new RegExp(`\\n\\s*${n.id.slice(0, n.id.indexOf("."))}:\\s*(\\w+),`));
    const glyph = explicit?.[1] ?? family?.[1];
    assert.ok(glyph, `routeIcons.ts resolves no glyph for ${n.id}`);
    assert.equal(n.icon, LUCIDE_TO_FEATHER[glyph], `${n.id}: web glyph ${glyph} ↔ native ${n.icon}`);
    assert.ok(n.icon in feather, `${n.icon} is not a Feather glyph, so it would render as "?"`);
  }
});

test("the provisional (pre-envelope) navigation claims nothing it cannot back", () => {
  const groups = N.provisionalNavigation();
  const items = groups.flatMap((g) => g.items);
  assert.ok(items.length >= 5, "someone must be able to move around before the envelope arrives");
  for (const i of items) {
    assert.equal(i.chip, null, `${i.route.id} carries an access chip before access is known`);
    assert.equal(i.route.requiredPlanFeature, undefined, `${i.route.id} is plan-gated and must not be offered provisionally`);
    assert.equal(i.route.navPlanFeature, undefined, `${i.route.id} is plan-gated and must not be offered provisionally`);
  }
});

test("the phone bottom bar is a bounded Workspace subset without the header's search", () => {
  const env = {
    activeSpace: { id: "w1", type: "PERSONAL" },
    capabilities: allCapabilities(),
    planFeatures: { intakeIncluded: true },
  };
  const bar = N.bottomBarItems(N.resolveNativeNavigation(N.navigationInputFromEnvelope(env)));
  assert.ok(bar.length <= N.BOTTOM_BAR_LIMIT);
  assert.deepEqual(
    bar.map((i) => i.route.id),
    ["workspace.home", "account.notifications", "workspace.cases", "workspace.evidence", "workspace.capture"],
  );
});

test("the old hardcoded array is gone from the shell", () => {
  const shell = readFileSync(resolve(MOBILE, "src/ui/shell.tsx"), "utf8");
  assert.doesNotMatch(shell, /function useNavItems/, "the hardcoded nav array came back");
  assert.doesNotMatch(shell, /label: "Alerts"/, 'native relabelled Notifications as "Alerts" again');
  assert.match(shell, /resolveNativeNavigation\(navigationInputFromEnvelope\(envelope\)\)/);
});
