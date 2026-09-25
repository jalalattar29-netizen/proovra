/**
 * T-09f / T-09g (RC-10) — what the shell's navigation actually RENDERS for a
 * real envelope.
 *
 * `navigation-model.test.mjs` proves the decision equals the web's. This file
 * proves the decision reaches the screen: icons are drawn, chips are shown,
 * gated destinations are absent, the phone reaches EVERY destination through
 * the drawer, and the rail carries the brand, group titles, separators, a
 * scroll container and the help footer.
 *
 * Before T-09f the shell rendered seven hardcoded labels with an 8×8 dot in
 * place of an icon; every assertion below fails against that shell.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};

function installFetch() {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) {
      return new Response(JSON.stringify({ message: "unstubbed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(hit[1]()), { status: 200, headers: { "content-type": "application/json" } });
  };
}

/** A personal-space member who may do everything EXCEPT see billing, on a plan with intake but no collaboration. */
const CAPS = {
  DASHBOARD_VIEW: true,
  CASES_VIEW: true,
  EVIDENCE_VIEW: true,
  EVIDENCE_CAPTURE: true,
  INTAKE_LINKS_MANAGE: true,
  SEARCH_VIEW: true,
  REPORTS_VIEW: true,
  ACCOUNT_BILLING_VIEW: false,
  TEAM_VIEW: true,
};
const envelope = () =>
  platformContextEnvelope({
    activeSpace: { id: "team-1", type: "PERSONAL", displayName: "Personal", status: "active" },
    capabilities: CAPS,
    planFeatures: { intakeIncluded: true, teamCollaborationIncluded: false },
    workspace: { id: "team-1", status: "active" },
    personalSpace: { id: "team-1", status: "active" },
  });

before(async () => {
  M = await loadModule("src/ui/shell.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/navigation.ts",
    "src/product/storage-widget.ts",
  ]);
});

beforeEach(async () => {
  routes = authenticatedRoutes({
    "/v1/platform/context": envelope,
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  });
  installFetch();
  M.calls.reset();
  await signIn(M);
});

const icons = (r) => r.root.findAll((n) => n.type === "Icon").map((n) => n.props.name);

async function renderShell() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.ProovraShell, null, h("View", null))));
  // Let the envelope request settle and the navigation re-derive from it.
  await r.update(h(M.TestProviders, null, h(M.ProovraShell, null, h("View", null))));
  return r;
}

test("phone: the bottom bar draws the web's glyphs and labels, bounded to five plus Menu", async () => {
  const r = await renderShell();
  const bar = r.byTestId("nav-bottom-bar")[0];
  assert.ok(bar, "no bottom bar rendered");
  const barIcons = bar.findAll((n) => n.type === "Icon").map((n) => n.props.name);
  assert.deepEqual(barIcons, ["home", "inbox", "briefcase", "archive", "camera", "menu"]);
  assert.ok(r.hasText("Notifications"), 'the Notifications destination is labelled differently from the web');
  assert.ok(!r.hasText("Alerts"), 'the old native-only "Alerts" label is back');
});

test("phone: Menu opens the drawer, which reaches EVERY permitted destination in web groups", async () => {
  const r = await renderShell();
  assert.equal(r.byTestId("nav-drawer").length, 0, "the drawer is open before anyone asked for it");
  await r.press("Open navigation menu");
  const drawer = r.byTestId("nav-drawer")[0];
  assert.ok(drawer, "Menu did not open the navigation drawer");

  const titles = drawer.findAll((n) => n.type === "Text" && n.props.accessibilityRole === "header").map((n) => n.props.children);
  assert.deepEqual(titles, ["WORKSPACE", "OUTPUTS", "SYSTEM"]);

  const ids = drawer.findAll((n) => typeof n.props.testID === "string" && /^nav-(workspace|account)\./.test(n.props.testID)).map((n) => n.props.testID);
  // Intake links: plan includes it and the member holds the capability → offered.
  assert.ok(ids.includes("nav-workspace.intake_links"), "Intake links is withheld although plan and capability allow it");
  // Reports and Billing are reachable on a phone again (they had fallen off the bar).
  assert.ok(ids.includes("nav-workspace.reports"), "Reports is unreachable from phone navigation");
  assert.ok(ids.includes("nav-account.billing"), "Billing is absent; the web shows it with a permission chip");
  // Collaboration Teams: plan does NOT include it → hidden, as on the web.
  assert.ok(!ids.includes("nav-workspace.collaboration_teams"), "Collaboration Teams offered on a plan without it");
});

test("a destination the member cannot load carries the web's chip — and still navigates", async () => {
  const r = await renderShell();
  await r.press("Open navigation menu");
  const billing = r.byLabel("Billing & plan, Requires permission");
  assert.equal(billing.length > 0, true, "Billing shows no 'Requires permission' chip for a member without ACCOUNT_BILLING_VIEW");
  assert.ok(r.hasText("Requires permission"));
  await r.press("Billing & plan, Requires permission");
  assert.deepEqual(M.calls.push, ["/billing"], "a degraded destination must still navigate; the screen owns recovery");
  assert.equal(r.byTestId("nav-drawer").length, 0, "choosing a destination did not close the drawer");
});

test("T-09g: the drawer carries the brand, a scroll container, separators and the help footer", async () => {
  const r = await renderShell();
  await r.press("Open navigation menu");
  assert.equal(r.byTestId("nav-brand").length, 1, "no brand area");
  assert.equal(r.byLabel("PROOVRA").filter((n) => n.type === "Image").length >= 1, true, "the wordmark is missing");
  assert.equal(r.byTestId("nav-rail-scroll").length, 1, "the destinations are not in a scroll container");
  assert.equal(r.byTestId("nav-group-divider").length, 2, "expected a hairline above each group title but the first");
  await r.press("Need help? Contact support");
  assert.deepEqual(M.calls.push, ["/support"]);
});

test("tablet rail: same groups and glyphs, with the branded surface", async () => {
  const groups = M.resolveNativeNavigation(M.navigationInputFromEnvelope(envelope()));
  const r = await renderComponent(h(M.TestProviders, null, h(M.ProovraTabletRail, { groups })));
  const rail = r.byTestId("nav-rail")[0];
  assert.equal(rail.type, "ImageBackground");
  assert.deepEqual(icons(r), ["home", "inbox", "briefcase", "archive", "camera", "link-2", "search", "file-text", "credit-card", "life-buoy"]);
});

test("before the envelope arrives the shell offers the provisional set with NO chips", async () => {
  routes["/v1/platform/context"] = () => {
    throw new Error("unavailable");
  };
  // A failing handler becomes a 500 via the stub below.
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/v1/platform/context")) {
      return new Response(JSON.stringify({ message: "down" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    return new Response(JSON.stringify(hit ? hit[1]() : {}), { status: hit ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  const r = await renderShell();
  await r.press("Open navigation menu");
  assert.ok(!r.hasText("Requires permission"), "a chip was shown although access is unknown");
  assert.ok(!r.hasText("Setup needed"), "a chip was shown although access is unknown");
  assert.equal(r.byTestId("nav-workspace.home").length > 0, true, "navigation vanished when the envelope failed");
});

/* ------------------------------------------------ T-09g storage footer */

test("T-09g: the storage footer shows the web's figures from /v1/billing/overview", async () => {
  const GB = 1024 * 1024 * 1024;
  routes["/v1/billing/overview"] = () => ({
    workspaces: { personal: { storage: { usedBytes: String(1 * GB), limitBytes: String(4 * GB) } } },
  });
  const r = await renderShell();
  await r.press("Open navigation menu");
  const widget = r.byTestId("nav-storage")[0];
  assert.ok(widget, "no storage footer in the navigation");
  assert.ok(r.hasText("25%"));
  assert.ok(r.hasText("1 GB of 4 GB"));
  const bar = r.byLabel("Storage used")[0];
  assert.deepEqual(bar.props.accessibilityValue, { min: 0, max: 100, now: 25 });
});

test("T-09g: an unknown storage figure draws NO bar — never a 0% that reads as empty", async () => {
  routes["/v1/billing/overview"] = () => ({ workspaces: { personal: { storage: { usedLabel: "?" } } } });
  const r = await renderShell();
  await r.press("Open navigation menu");
  assert.equal(r.byTestId("nav-storage").length, 0);
  assert.ok(!r.hasText("0%"));
});

test("T-09g: storageViewFromOverview mirrors the web's toView arithmetic", () => {
  const f = M.storageViewFromOverview;
  const wrap = (storage) => ({ workspaces: { personal: { storage } } });
  assert.equal(f(null), null);
  assert.equal(f(wrap(null)), null);
  assert.deepEqual(f(wrap({ usagePercent: 150, usedLabel: "9 GB", limitLabel: "5 GB" })), {
    percent: 100,
    usedLabel: "9 GB",
    limitLabel: "5 GB",
  });
  assert.deepEqual(f(wrap({ usedBytes: "536870912", limitBytes: "1073741824" })), {
    percent: 50,
    usedLabel: "0.50 GB",
    limitLabel: "1 GB",
  });
  assert.equal(f(wrap({ usedBytes: "10", limitBytes: "0" })), null, "a zero limit has no percentage");
  assert.equal(f(wrap({ usagePercent: 10 })), null, "no labels, no widget");
});
