/**
 * WHAT THE COMMAND PALETTE AND ALL TOOLS OFFER, AND TO WHOM.
 *
 * A FREE account saw "All Tools" in the palette and a PRO account did not.
 * There is no plan rule that says so anywhere — the behaviour was an accident
 * of truncation, and these tests pin the model that replaced it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dedupeByDestination,
  orderPaletteCandidates,
  paletteGroupFor,
  paletteTitleFor,
  scorePaletteMatch,
  PALETTE_DEFAULT_ROUTE_IDS,
} from "../lib/navigation/paletteModel";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const byId = (id: string) => {
  const r = ROUTE_REGISTRY.find((x) => x.id === id);
  assert.ok(r, `route ${id} must exist`);
  return r!;
};
const candidate = (id: string, canLoad = true) => ({
  route: byId(id),
  canLoad,
  item: id,
});

// ===========================================================================
// RANKING — the paradox
// ===========================================================================
test("a direct destination outranks the catalogue that merely mentions it", () => {
  // The reported symptom: searching a feature surfaced All Tools above the
  // page itself, because the old rank had four possible values and ties broke
  // by registry order.
  const ordered = orderPaletteCandidates(
    [candidate("workspace.tools"), candidate("account.billing")],
    "billing",
  );
  assert.equal(ordered[0]?.route.id, "account.billing");
});

test("an exact title match beats a description mention by a wide margin", () => {
  const exact = scorePaletteMatch(byId("account.billing"), "billing");
  const viaDescription = scorePaletteMatch(byId("workspace.tools"), "surface");
  assert.ok(exact > viaDescription * 2, `${exact} should dwarf ${viaDescription}`);
});

test("the default list does not depend on how many features you have bought", () => {
  /*
   * THE ROOT CAUSE, PINNED.
   *
   * The old default was "top 20 by rank". `/tools` is advancedByDefault so it
   * scored 2; every non-advanced loadable route scored 3. An account entitled
   * to MORE routes had more 3s, filling all twenty slots and pushing the 2s —
   * All Tools among them — off the list. More entitlements meant fewer things
   * visible.
   *
   * The default is now a fixed set, so a FREE and a PRO account see the same
   * destinations.
   */
  const free = orderPaletteCandidates(
    PALETTE_DEFAULT_ROUTE_IDS.filter((id) => ROUTE_REGISTRY.some((r) => r.id === id)).map(
      (id) => candidate(id),
    ),
    "",
  );
  const pro = orderPaletteCandidates(
    [
      ...PALETTE_DEFAULT_ROUTE_IDS.filter((id) =>
        ROUTE_REGISTRY.some((r) => r.id === id),
      ).map((id) => candidate(id)),
      // A PRO account is entitled to more routes. Under the old ranking these
      // extra high-scoring rows are exactly what displaced everything else.
      candidate("workspace.tools"),
      candidate("account.organizations"),
    ],
    "",
  );
  assert.deepEqual(
    pro.map((c) => c.route.id),
    free.map((c) => c.route.id),
    "the empty-query list must not change with entitlements",
  );
});

test("All Tools never appears in the default list", () => {
  assert.ok(!PALETTE_DEFAULT_ROUTE_IDS.includes("workspace.tools"));
});

test("a route that cannot be opened ranks below one that can", () => {
  const ordered = orderPaletteCandidates(
    [candidate("workspace.evidence", false), candidate("workspace.evidence", true)],
    "evidence",
  );
  assert.equal(ordered[0]?.canLoad, true);
});

// ===========================================================================
// GROUPING — Settings must read as Settings
// ===========================================================================
test("settings subpages are titled as settings destinations", () => {
  // The screenshots showed seven of them rendered as though they were
  // unrelated product tools.
  // Settings subpages are HASH routes on one page — /settings#preferences,
  // /settings#privacy, /settings#security — which is why a predicate looking
  // only for the slash form matched none of them.
  const settings = ROUTE_REGISTRY.filter((r) => /^\/settings#/.test(r.href));
  assert.ok(settings.length >= 5, `expected the settings tabs, got ${settings.length}`);
  for (const r of settings) {
    assert.equal(paletteGroupFor(r), "Settings", r.href);
    assert.match(paletteTitleFor(r), /^Settings · /, r.href);
  }
});

test("the settings root is titled Overview, not left bare", () => {
  assert.equal(paletteTitleFor(byId("account.settings")), "Settings · Overview");
});

test("a settings label already carrying the word is not prefixed twice", () => {
  const doubled = paletteTitleFor({
    ...byId("account.settings"),
    href: "/settings/x",
    label: "Settings preferences",
  } as never);
  assert.equal(doubled, "Settings preferences");
});

test("organization-only surfaces group as Governance, not as Pages", () => {
  const orgOnly = ROUTE_REGISTRY.filter(
    (r) => r.requiredActiveSpace === "ORGANIZATION_ONLY" && !r.href.startsWith("/settings"),
  );
  assert.ok(orgOnly.length > 0, "fixture sanity");
  for (const r of orgOnly.slice(0, 12)) {
    assert.equal(paletteGroupFor(r), "Governance", r.href);
  }
});

// ===========================================================================
// DEDUPLICATION — by destination, never by title
// ===========================================================================
test("two registry entries for one destination collapse to one row", () => {
  const dupes = ROUTE_REGISTRY.filter((r) => r.href === "/review");
  assert.ok(dupes.length > 1, "the registry really does carry duplicates for /review");
  const out = dedupeByDestination(dupes.map((route) => ({ route })));
  assert.equal(out.length, 1);
});

test("different surfaces with similar titles both survive", () => {
  // Notifications and Settings · Notification preferences are not the same
  // page. Deduping by title would have merged them.
  const notifications = byId("account.notifications");
  const settingsNotifications = ROUTE_REGISTRY.find(
    (r) => /^\/settings#/.test(r.href) && /notification/i.test(r.label),
  );
  if (!settingsNotifications) return; // registry may name it differently
  const out = dedupeByDestination([
    { route: notifications },
    { route: settingsNotifications },
  ]);
  assert.equal(out.length, 2, "distinct destinations must both survive");
});

// ===========================================================================
// VISIBILITY — Reviewer Criteria
// ===========================================================================
test("Reviewer Criteria requires the reviewer capability it actually needs", () => {
  /*
   * Every reviewer-criteria API endpoint gates on `review.queue.read`, held by
   * OWNER / ADMIN / REVIEWER and not by CONTRIBUTOR, VIEWER, or a personal
   * workspace. The registry declared no capability at all, so the surface was
   * offered to a brand-new personal FREE account whose first request to it
   * would 403 — and at `advancedByDefault: false`, it ranked ahead of pages
   * that account could actually open.
   */
  const r = byId("workspace.reviewer_criteria");
  assert.deepEqual(r.requiredCapabilities, ["REVIEWER_OPS_VIEW"]);
});

test("Organizations stays discoverable — it is the path, not a locked tool", () => {
  // Self-service organization creation is retired; the page opens an
  // enterprise-provisioning information modal and an accept-invite flow.
  // Neither has a billing consequence, so discovery is safe.
  const r = byId("account.organizations");
  assert.equal(r.commandPaletteVisible, true);
  assert.equal(r.requiredActiveSpace, "NONE");
});

// ===========================================================================
// PRESENTATION
// ===========================================================================
const PALETTE = readFileSync(
  resolve(APP, "components/navigation/CommandPalette.tsx"),
  "utf8",
);
const TOOLS = readFileSync(resolve(APP, "app/(app)/tools/page.tsx"), "utf8");

test("palette rows carry no capsule badges", () => {
  // A row could render three at once — group, Advanced, status — so twenty
  // rows meant up to sixty pills.
  assert.doesNotMatch(PALETTE, /<Badge/);
});

test("All Tools cards carry no capsule badges", () => {
  assert.doesNotMatch(TOOLS, /<Badge/);
});

test("a normal entitlement limit is never painted as an error", () => {
  /*
   * Both surfaces rendered the resolver's reason in `--status-risk-fg`
   * (#991b1b), so needing an organization looked like a fault the reader had
   * caused. Asserted against code rather than comments — the explanation above
   * names the token it forbids.
   */
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code(PALETTE), /status-risk-fg/);
  assert.doesNotMatch(code(TOOLS), /status-risk-fg/);
});

test("All Tools states a locked requirement once per group, not once per card", () => {
  // A personal account sees ~116 nav-visible routes, most organization-only.
  // Rendered per-card that was dozens of identical CTAs.
  assert.match(TOOLS, /data-all-tools-locked-group/);
  assert.match(TOOLS, /locked\[0\]\?\.access\.primaryAction/);
  // The open cards must not each carry their own locked CTA any more.
  assert.doesNotMatch(TOOLS, /item\.access\.primaryAction \? \(/);
});

test("locked surfaces are still named, so the page stays discovery", () => {
  // The access resolver keeps organization-only routes nav-visible on purpose.
  // Collapsing them must not mean hiding what they are.
  assert.match(TOOLS, /data-all-tools-locked-names/);
});
