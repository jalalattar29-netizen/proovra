/**
 * Evidence Detail — final shell cleanup.
 *
 * Every dialog on the route now runs through the canonical portal Modal, and
 * every action through the canonical primitives. This file pins that, and
 * pins the three dialogs the last pass migrated — lock, unlock and
 * restore-archived — because those are the ones that change a record's
 * lifecycle and must keep their authorization, confirmation and pending
 * behaviour exactly as they were.
 *
 * It also holds the route-wide presentation floor: no inline style objects,
 * no private colour literals, no native selects, no legacy primitives. Those
 * are cheap to reintroduce and expensive to notice, so they are asserted
 * rather than reviewed.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const ROUTE = resolve(REPO_ROOT, "apps/web/app/(app)/evidence/[id]");

const PAGE = readFileSync(join(ROUTE, "page.tsx"), "utf8");
const CSS = readFileSync(join(ROUTE, "evidence-detail.css"), "utf8");

/** Prose is not code. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}
const PAGE_CODE = code(PAGE);

/** Every production TS/TSX file under the route. */
function routeFiles(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e)) {
        out.push({ rel: p.slice(ROUTE.length + 1).replace(/\\/g, "/"), src: readFileSync(p, "utf8") });
      }
    }
  })(ROUTE);
  return out;
}
const FILES = routeFiles();

// ---------------------------------------------------------------------------
// A) The three lifecycle dialogs
// ---------------------------------------------------------------------------

const LIFECYCLE_DIALOGS = [
  { testid: "evidence-lock", open: "lockOpen", confirm: "confirm-lock", route: "/lock" },
  { testid: "evidence-unlock", open: "unlockOpen", confirm: "confirm-unlock", route: "/unlock" },
  {
    testid: "evidence-restore-archived",
    open: "restoreArchivedOpen",
    confirm: "confirm-restore-archived",
    route: "/unarchive",
  },
];

for (const d of LIFECYCLE_DIALOGS) {
  test(`${d.testid}: renders through the canonical portal Modal`, () => {
    assert.match(PAGE, new RegExp(`<PortalModal\\n\\s+open=\\{${d.open}\\}`));
    assert.match(PAGE, new RegExp(`testid="${d.testid}"`));
  });

  test(`${d.testid}: cannot be dismissed while the mutation is pending`, () => {
    const block = PAGE.slice(
      PAGE.indexOf(`testid="${d.testid}"`) - 200,
      PAGE.indexOf(`testid="${d.testid}"`) + 400,
    );
    assert.match(block, /dismissDisabled=\{actionBusy\}/);
  });

  test(`${d.testid}: confirm and cancel are both present and both busy-gated`, () => {
    const start = PAGE.indexOf(`testid="${d.testid}"`);
    const block = PAGE.slice(start, PAGE.indexOf("</PortalModal>", start));
    assert.match(block, /onClick=\{\(\) => set\w+\(false\)\}[\s\S]{0,120}disabled=\{actionBusy\}/);
    assert.match(block, new RegExp(`data-evidence-modal-action="${d.confirm}"`));
    // A double-submit is impossible: the confirm disables on the same flag
    // the request sets.
    const confirmIdx = block.indexOf(`data-evidence-modal-action="${d.confirm}"`);
    assert.match(block.slice(Math.max(0, confirmIdx - 400), confirmIdx), /disabled=\{actionBusy\}/);
  });

  test(`${d.testid}: still calls its own backend route`, () => {
    assert.match(PAGE, new RegExp(`/v1/evidence/\\$\\{evidenceId\\}${d.route.replace("/", "\\/")}`));
  });

  test(`${d.testid}: confirm is not the purple primary`, () => {
    // Anchor to the enclosing <button, not a fixed lookback: the unlock
    // handler body is long enough to push the tag out of any window.
    const attr = PAGE.indexOf(`data-evidence-modal-action="${d.confirm}"`);
    const button = PAGE.slice(PAGE.lastIndexOf("<button", attr), attr);
    assert.match(button, /className="app-secondary-action app-secondary-action--filled"/);
    assert.doesNotMatch(button, /app-primary-action/);
  });
}

test("the canonical Modal is the only dialog shell on the route", () => {
  // Focus trap, focus restoration, Escape, backdrop and scroll lock all live
  // in that one component, so nothing on this route can quietly lack them.
  const shell = readFileSync(
    resolve(REPO_ROOT, "apps/web/components/cases-experience/matter-modals/Modal.tsx"),
    "utf8",
  );
  assert.match(shell, /createPortal/);
  assert.match(shell, /previouslyFocusedRef/);
  assert.match(shell, /"Escape"/);
  assert.match(shell, /aria-modal="true"/);

  const portals = PAGE.match(/<PortalModal\b/g) ?? [];
  assert.equal(portals.length, 8, `expected 8 canonical dialogs, got ${portals.length}`);
});

// ---------------------------------------------------------------------------
// B) Route-wide presentation floor
// ---------------------------------------------------------------------------

const FLOOR: Array<[string, RegExp]> = [
  ["inline style object", /style=\{\{/],
  ["style prop", /style=\{/],
  ["raw hex colour", /#[0-9a-fA-F]{3,8}\b/],
  ["raw rgb/rgba", /\brgba?\(/],
  ["legacy teal", /teal/i],
  ["italic markup", /<em[\s>]|<i[\s>]|font-style:\s*italic/],
  ["native <select>", /<select[\s>]/],
  ["legacy <Modal>", /<Modal[\s>]/],
  ["legacy <Button>", /<Button[\s>]/],
];

for (const [label, re] of FLOOR) {
  test(`route carries no ${label}`, () => {
    const offenders = FILES.filter((f) => re.test(code(f.src))).map((f) => f.rel);
    assert.deepEqual(offenders, [], `${label} found in: ${offenders.join(", ")}`);
  });
}

test("the only components/ui import left is the canonical toast hook", () => {
  const importers = FILES.filter((f) => /from "[^"]*components\/ui"/.test(code(f.src)));
  assert.equal(importers.length, 1, `unexpected ui importers: ${importers.map((f) => f.rel).join(", ")}`);
  assert.equal(importers[0]!.rel, "page.tsx");
  assert.match(PAGE, /import \{ useToast \} from "\.\.\/\.\.\/\.\.\/\.\.\/components\/ui";/);
});

test("no parallel, backup or V2 surface exists on the route", () => {
  const bad = FILES.filter((f) => /_old|\.old\.|legacy|backup|copy|v2/i.test(f.rel));
  assert.deepEqual(bad.map((f) => f.rel), []);
});

test("the route stays under its byte guard", () => {
  const bytes = Buffer.byteLength(PAGE, "utf8");
  assert.ok(bytes < 80_000, `page.tsx is ${bytes} bytes`);
});

// ---------------------------------------------------------------------------
// C) The retired authorities are gone
// ---------------------------------------------------------------------------

test("selectors retired by the migration are deleted, not neutralised", () => {
  for (const dead of [
    ".evidence-detail-note-box",
    ".evidence-detail-related-card",
    ".evidence-detail-related-list",
    ".evidence-detail-select",
    ".evidence-detail-flat-list",
    ".evidence-detail-back-link",
    ".evidence-detail-subtitle",
  ]) {
    assert.doesNotMatch(CSS, new RegExp(dead.replace(/[.-]/g, "\\$&")), `${dead} still declared`);
  }
});

test("zero-consumer custom properties are deleted", () => {
  for (const dead of ["--detail-soft", "--detail-panel", "--detail-subtle", "--detail-teal-strong"]) {
    assert.doesNotMatch(CSS, new RegExp(`${dead}\\s*:`), `${dead} still declared`);
  }
});

test("the shell's own presentation moved into the stylesheet", () => {
  for (const cls of [
    "evidence-detail-record-banner",
    "evidence-detail-attention",
    "evidence-detail-dialog-field",
    "evd-panel",
  ]) {
    assert.match(CSS, new RegExp(`\\.${cls}\\b`));
  }
  // The dead style constants are gone from the source.
  assert.doesNotMatch(PAGE_CODE, /pillButtonStyle|CSSProperties/);
});
