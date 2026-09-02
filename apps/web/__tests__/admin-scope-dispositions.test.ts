/**
 * EVERY ADMIN SCOPE FINDING HAS A REVIEWED DISPOSITION.
 *
 * ===========================================================================
 * WHAT THIS REPLACES
 * ===========================================================================
 * A previous report ended with "PLATFORM_READS_WORKSPACE = 18,
 * PLATFORM_SCOPES_API_BY_TEAM = 9" and no explanation. Two numbers with no
 * decisions behind them are worse than no numbers: they look like measurement
 * and they carry no information about whether anything is wrong.
 *
 * The inventory now follows each page's request into the API handler and
 * reports what `teamId` actually DOES there — narrows the query (FILTER),
 * decides who may call (AUTHZ), or gets recorded and nothing else (AUDIT).
 * `adminScopeDispositions.ts` records a decision for every one, and this file
 * makes the two agree in both directions:
 *
 *   - a finding in the tree with no disposition FAILS, so a page cannot be
 *     added or re-scoped without somebody deciding what it is;
 *   - a disposition for a finding the tree no longer has FAILS, so the file
 *     cannot accumulate stale entries that make coverage look complete.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type InventoryRow = {
  route: string;
  actualScope: string;
  inNavigation: boolean;
  isContextualDetail: boolean;
  navSection: string | null;
  declaredSpace: string | null;
  visual: string;
  parent: string;
  registryId: string | null;
};

/**
 * Run the inventory rather than importing a snapshot of it.
 *
 * A committed snapshot is a thing that goes stale between the change and the
 * test run, which is precisely the window this file exists to close.
 */
function inventory(): InventoryRow[] {
  const out = execFileSync(
    process.execPath,
    [resolve(APP_ROOT, "scripts/admin-inventory.mjs"), "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out).rows as InventoryRow[];
}

const NEEDS_DISPOSITION = new Set([
  "WORKSPACE_FILTERED",
  // A handler that passes teamId to something the scanner cannot classify.
  // It needs a human decision exactly as much as a proven filter does.
  "WORKSPACE_CANDIDATE",
  "WORKSPACE_AUTHZ",
  "PLATFORM_AUDIT_SCOPED",
  "WORKSPACE_UNCLASSIFIED",
]);

test("every scope finding in the tree has a reviewed disposition", async () => {
  const { ADMIN_SCOPE_DISPOSITIONS } = await import(
    "../lib/navigation/adminScopeDispositions"
  );
  const covered = new Set(ADMIN_SCOPE_DISPOSITIONS.map((d) => d.route));

  const undecided = inventory()
    .filter((r) => NEEDS_DISPOSITION.has(r.actualScope))
    .map((r) => `${r.route} (${r.actualScope})`)
    .filter((s) => !covered.has(s.split(" ")[0]));

  assert.deepEqual(
    undecided,
    [],
    "these pages read or authorize on a workspace and nobody has said whether " +
      "that is correct. Add an entry to adminScopeDispositions.ts with the reason.",
  );
});

test("no disposition describes a finding the tree no longer has", async () => {
  const { ADMIN_SCOPE_DISPOSITIONS } = await import(
    "../lib/navigation/adminScopeDispositions"
  );
  const rows = new Map(inventory().map((r) => [r.route, r]));

  const stale: string[] = [];
  for (const d of ADMIN_SCOPE_DISPOSITIONS) {
    const row = rows.get(d.route);
    if (!row) {
      stale.push(`${d.route}: no such page`);
      continue;
    }
    if (!NEEDS_DISPOSITION.has(row.actualScope)) {
      stale.push(`${d.route}: now ${row.actualScope}, needs no disposition`);
    }
  }
  assert.deepEqual(stale, [], "adminScopeDispositions.ts has stale entries");
});

test("the observed scope recorded in each disposition matches the tree", async () => {
  const { ADMIN_SCOPE_DISPOSITIONS } = await import(
    "../lib/navigation/adminScopeDispositions"
  );
  const rows = new Map(inventory().map((r) => [r.route, r]));

  for (const d of ADMIN_SCOPE_DISPOSITIONS) {
    const row = rows.get(d.route);
    if (!row) continue;
    assert.equal(
      row.actualScope,
      d.observed,
      `${d.route}: the disposition was written against ${d.observed} but the ` +
        `tree now reports ${row.actualScope}. The reasoning may no longer hold.`,
    );
  }
});

test("every reason is an argument, not a restatement", async () => {
  const { ADMIN_SCOPE_DISPOSITIONS } = await import(
    "../lib/navigation/adminScopeDispositions"
  );
  for (const d of ADMIN_SCOPE_DISPOSITIONS) {
    // A one-line "it is fine" is the shape this file exists to prevent.
    assert.ok(
      d.why.length >= 80,
      `${d.route}: the reason is ${d.why.length} characters. Say what the ` +
        `handler does and why that is the right answer.`,
    );
    assert.doesNotMatch(
      d.why,
      /^(correct|fine|ok|by design)\.?$/i,
      `${d.route}: "${d.why}" is an assertion, not a reason`,
    );
  }
});

// ===========================================================================
// Discoverability
// ===========================================================================

test("every non-detail admin page is discoverable in navigation", () => {
  const orphans = inventory()
    .filter((r) => !r.inNavigation && !r.isContextualDetail)
    .map((r) => r.route);

  assert.deepEqual(
    orphans,
    [],
    "these pages exist, are gated, and appear in no navigation surface — an " +
      "operator can only reach them by typing the URL",
  );
});

test("every contextual detail page has a resolvable parent", () => {
  const rows = inventory();
  const known = new Set(rows.map((r) => r.route));
  for (const r of rows.filter((x) => x.isContextualDetail)) {
    assert.ok(
      known.has(r.parent),
      `${r.route}: its parent ${r.parent} is not a page, so the breadcrumb ` +
        `and the return path have nowhere to point`,
    );
  }
});

test("every admin page is registered", () => {
  const unregistered = inventory()
    .filter((r) => r.registryId === null)
    .map((r) => r.route);
  assert.deepEqual(unregistered, [], "unregistered admin pages");
});

// ===========================================================================
// Visual system
// ===========================================================================

test("no admin page is left on a bespoke visual system", () => {
  // `SHARED_SHELL` means the page renders through PageShell and carries none
  // of the older OPS_* inline-token objects. MIXED and LEGACY_OPS_TOKENS and
  // BESPOKE are the three ways a page can be outside the shared system.
  const offenders = inventory()
    .filter((r) => r.visual !== "SHARED_SHELL")
    .map((r) => `${r.route} (${r.visual})`);

  assert.deepEqual(
    offenders,
    [],
    "these admin pages do not render through the shared enterprise shell",
  );
});

// ===========================================================================
// The scope the navigation SHOWS must match the disposition
// ===========================================================================

test("the navigation scope of every surface matches its reviewed disposition", async () => {
  // The console said "Workspace-scoped surface. This page administers your own
  // active workspace — not the platform." on Queues, Exports, Signers,
  // Recovery and Reliability. All five are platform-wide: the queues route's
  // own header says failed jobs "may originate from a different workspace than
  // the one the operator is currently active in", and `listAllSigners` starts
  // from `getCurrentActiveSigners()`, which takes no teamId.
  //
  // An operator triaging a failed job under that banner would conclude the
  // failure was theirs. This keeps the banner and the evidence in step.
  const { ADMIN_SCOPE_DISPOSITIONS } = await import(
    "../lib/navigation/adminScopeDispositions"
  );
  const { ADMIN_NAV_SECTIONS } = await import(
    "../components/admin/adminNavigation"
  );

  const navScope = new Map<string, string>();
  for (const section of ADMIN_NAV_SECTIONS) {
    for (const child of section.children) navScope.set(child.href, child.scope);
  }

  const EXPECTED: Record<string, string> = {
    PLATFORM_AUDIT_CONTEXT: "PLATFORM_AUDIT",
    WORKSPACE_SURFACE_LABELLED: "WORKSPACE",
    PLATFORM_WITH_TENANT_FILTER: "PLATFORM",
  };

  const wrong: string[] = [];
  for (const d of ADMIN_SCOPE_DISPOSITIONS) {
    const shown = navScope.get(d.route);
    if (shown === undefined) continue; // detail routes carry no nav entry
    const want = EXPECTED[d.decision];
    if (shown !== want) {
      wrong.push(`${d.route}: nav says ${shown}, disposition implies ${want}`);
    }
  }
  assert.deepEqual(wrong, [], "the console's scope banner contradicts the evidence");
});

test("the two scope notices say different things", () => {
  const src = readFileSync(
    resolve(APP_ROOT, "components/admin/AdminConsoleNav.tsx"),
    "utf8",
  );
  // Two states that render the same sentence are one state with extra steps.
  assert.match(src, /data-scope="WORKSPACE"/);
  assert.match(src, /data-scope="PLATFORM_AUDIT"/);
  assert.match(src, /not a filter on what you see/);
  assert.match(src, /administers/);
});
