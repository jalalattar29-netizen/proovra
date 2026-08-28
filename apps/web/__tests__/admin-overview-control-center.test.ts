/**
 * Platform Admin — Control Center Overview (item A) contract.
 *
 * The /admin landing page must be a real control center: it consumes the
 * platform overview API, renders honest "Not measured" states (no fabricated
 * numbers), keeps the Provision CTA, and every quick action + nav item routes
 * to a real page on disk.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");
const PAGE = "app/(app)/admin/page.tsx";

test("overview consumes the platform overview API (not the old analytics bundle)", () => {
  const src = read(PAGE);
  assert.match(src, /\/v1\/admin\/overview/, "must fetch /v1/admin/overview");
});

test("overview renders through the shared PageShell and NOT a marketing hero", () => {
  const src = read(PAGE);
  assert.match(src, /PageShell/, "must use PageShell");
  assert.doesNotMatch(src, /app-hero-full|admin-hero-note/, "no marketing hero");
});

test("overview keeps the Provision Enterprise CTA linking to /admin/provisioning", () => {
  const src = read(PAGE);
  assert.match(src, /data-testid="admin-provision-cta"/);
  assert.match(src, /href="\/admin\/provisioning"/);
});

test("overview renders honest 'Not measured' states (no fabricated numbers)", () => {
  const src = read(PAGE);
  assert.match(src, /Not measured/, "null figures must render as Not measured");
  assert.match(src, /Traffic not connected|not-connected|not connected/i);
});

test("overview shows the control-plane sections", () => {
  const src = read(PAGE);
  // ADM-002/003/004/009 — the section list changed with the populations it
  // reports. "Quick actions" is GONE: the console nav (now in the layout) is
  // the navigation, and every tile on this page is itself a drill-down link,
  // which is a better answer to the same need than a row of buttons.
  for (const section of [
    "Platform posture",
    "Customers",
    "Workspaces",
    "Commercial attention",
    "Evidence operations",
    "Security",
    "Traffic",
  ]) {
    assert.match(src, new RegExp(section), `must have a "${section}" section`);
  }
});

// ADM-002 — the Overview counts CUSTOMER organizations, never every
// Organization row. The SYSTEM bootstrap container each workspace owns is not a
// customer, and the copy has to say which population the reader is looking at.
test("overview says its customer population excludes bootstrap containers", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /bootstrap container/i,
    "the Customers section must state that SYSTEM containers are excluded",
  );
});

// ADM-004 — closed workspaces are excluded from every live figure.
test("overview separates live workspaces from closed ones", () => {
  const src = read(PAGE);
  assert.match(src, /Live workspaces/, "a live-workspace figure");
  assert.match(src, /Closed \(history\)/, "closed workspaces reported separately");
});

// §1.1 — NO DEAD LINKS.
//
// The drill-down destination now travels WITH each figure from the API
// (`OverviewFigure.drillDown`), rather than being hard-coded in the page as the
// old QUICK_ACTIONS array was. That is the better arrangement — a tile cannot be
// added without someone deciding where it leads — but it moves the "does this
// link exist?" question to the service, so that is where it is asked.
//
// Both halves are checked: the handful of destinations the PAGE still hard-codes
// here, and every destination the SERVICE emits, below.
test("every admin destination hard-coded in the overview page resolves", () => {
  const src = read(PAGE);
  const hrefs = new Set<string>();
  for (const m of src.matchAll(
    /["`](\/admin\/[A-Za-z0-9\-/]*)(?:\?[^"`]*)?["`]/g,
  )) {
    hrefs.add(m[1]!.replace(/\/$/, ""));
  }
  assert.ok(hrefs.size >= 1, "expected at least one hard-coded destination");
  for (const href of hrefs) {
    const page = resolve(APP_ROOT, `app/(app)${href}/page.tsx`);
    assert.ok(existsSync(page), `${href} must resolve to a page.tsx`);
  }
});

test("every drill-down the overview SERVICE emits resolves to a real page", () => {
  // The service lives in the API package; this test reads it as text for the
  // same reason the rest of this file does — it is checking a cross-package
  // contract (an admin path) that neither typechecker can see.
  const service = readFileSync(
    resolve(APP_ROOT, "../../services/api/src/services/admin/overview.service.ts"),
    "utf8",
  );
  const hrefs = new Set<string>();
  for (const m of service.matchAll(
    /["`](\/admin\/[A-Za-z0-9\-/]*)(?:\?[^"`]*)?["`]/g,
  )) {
    hrefs.add(m[1]!.replace(/\/$/, ""));
  }
  assert.ok(
    hrefs.size >= 6,
    `expected the overview service to emit several drill-downs, saw ${hrefs.size}`,
  );
  for (const href of hrefs) {
    const page = resolve(APP_ROOT, `app/(app)${href}/page.tsx`);
    assert.ok(
      existsSync(page),
      `${href} is emitted as a drill-down but has no page.tsx — a drill-down that 404s is worse than a terminal number, because it looks like it worked`,
    );
  }
});

test("no fabricated uptime / growth literals baked into the overview", () => {
  const src = read(PAGE);
  assert.doesNotMatch(src, /99\.9%/);
  assert.doesNotMatch(src, /100%\s*uptime/i);
});
