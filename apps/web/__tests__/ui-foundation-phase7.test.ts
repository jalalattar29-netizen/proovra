/**
 * Phase 7 — Design foundation contract.
 *
 * Source-text guards (in the repo's node:test + tsx style) that pin the
 * refined tokens and the shared UI primitives so later page migrations
 * and future edits cannot silently regress the foundation:
 *
 *   1. --btn-primary-bg is the refined coral → pink gradient (not the
 *      retired teal), and the coral shadow token is present.
 *   2. Backward compatibility — every legacy CSS var NAME that consumers
 *      already reference still resolves in globals.css.
 *   3. The new PROOVRA design-language tokens exist (enterprise violet
 *      accent + the six semantic status tokens).
 *   4. Each core shared component exists and exports its documented API +
 *      variants, and the barrel re-exports the whole set.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");

const read = (rel: string) => readFileSync(resolve(appRoot, rel), "utf8");

const GLOBALS = read("app/globals.css");
const UI = (name: string) => read(`components/ui/${name}`);

// ---------------------------------------------------------------------------
// 1. Coral CTA
// ---------------------------------------------------------------------------

test("--btn-primary-bg is the refined coral→pink gradient", () => {
  const match = GLOBALS.match(/--btn-primary-bg:\s*([^;]+);/);
  assert.ok(match, "--btn-primary-bg must be defined");
  const value = match![1].toLowerCase();
  assert.ok(value.includes("#e64880"), "coral start colour present");
  assert.ok(value.includes("#ff6b6b"), "pink mid colour present");
  assert.ok(value.includes("#ff8a6a"), "warm-coral end colour present");
  // The retired teal gradient must be gone from the token.
  assert.ok(!value.includes("#3e8f95"), "old teal gradient removed from token");
});

test("coral CTA shadow + border tokens are coral-tinted", () => {
  assert.match(GLOBALS, /--btn-primary-shadow:\s*[^;]*rgba\(230,\s*72,\s*128/);
  assert.match(GLOBALS, /--btn-primary-border:\s*rgba\(230,\s*72,\s*128/);
});

// ---------------------------------------------------------------------------
// 2. Backward compatibility — legacy var NAMES still resolve
// ---------------------------------------------------------------------------

test("all legacy CSS var names remain defined", () => {
  const legacyVars = [
    "--btn-primary-bg",
    "--btn-primary-color",
    "--btn-primary-border",
    "--btn-primary-hover-bg",
    "--btn-primary-hover-border",
    "--btn-primary-shadow",
    "--card",
    "--border",
    "--accent",
    "--destructive",
    "--primary",
    "--color-primary",
    "--app-nav-bg",
    "--surface",
    "--radius",
  ];
  for (const name of legacyVars) {
    assert.ok(
      new RegExp(`${name}:`).test(GLOBALS),
      `legacy var ${name} must still be defined (backward compatible)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. New PROOVRA design-language tokens
// ---------------------------------------------------------------------------

test("enterprise violet accent + semantic status tokens exist", () => {
  const required = [
    "--enterprise-accent",
    "--enterprise-gradient",
    "--status-verified-bg",
    "--status-verified-fg",
    "--status-pending-bg",
    "--status-risk-bg",
    "--status-neutral-bg",
    "--status-governance-bg",
    "--status-info-bg",
  ];
  for (const name of required) {
    assert.ok(new RegExp(`${name}:`).test(GLOBALS), `${name} must be defined`);
  }
});

// ---------------------------------------------------------------------------
// 4. Shared components + barrel
// ---------------------------------------------------------------------------

test("Button exposes its variants + states", () => {
  const src = UI("Button.tsx");
  assert.match(src, /export const Button/);
  for (const v of [
    "primary",
    "secondary",
    "enterprise",
    "destructive",
    "ghost",
  ]) {
    assert.ok(src.includes(`"${v}"`), `Button variant ${v} present`);
  }
  assert.match(src, /loading/, "Button has loading state");
  assert.match(src, /disabled/, "Button has disabled state");
  assert.match(src, /var\(--btn-primary-bg\)/, "primary uses the CTA token");
});

test("Card exposes its five variants", () => {
  const src = UI("Card.tsx");
  assert.match(src, /export function Card/);
  for (const v of ["summary", "status", "admin", "action", "empty"]) {
    assert.ok(src.includes(`"${v}"`), `Card variant ${v} present`);
  }
});

test("Badge covers the semantic tone set and reuses StatusBadge", () => {
  const src = UI("Badge.tsx");
  assert.match(src, /export function Badge/);
  for (const t of [
    "verified",
    "pending",
    "risk",
    "neutral",
    "governance",
    "info",
  ]) {
    assert.ok(src.includes(`"${t}"`), `Badge tone ${t} present`);
  }
  assert.match(src, /from "\.\/StatusBadge"/, "Badge reuses StatusBadge");
});

test("DataTable, EmptyState, FilterBar, PageShell exist with expected API", () => {
  const table = UI("DataTable.tsx");
  assert.match(table, /export function DataTable/);
  assert.match(table, /loading/);
  assert.match(table, /emptyState/);
  assert.match(table, /overflowX/, "horizontal-scroll container");

  const empty = UI("EmptyState.tsx");
  assert.match(empty, /export function EmptyState/);
  assert.match(empty, /purpose/);
  assert.match(empty, /note/, "supports permission/plan note");

  const filter = UI("FilterBar.tsx");
  assert.match(filter, /export const FilterBar/);
  assert.match(filter, /Search:/);
  assert.match(filter, /Select:/);

  const shell = UI("PageShell.tsx");
  assert.match(shell, /export function PageShell/);
  assert.match(shell, /export function PageHeader/);
  assert.match(shell, /primaryAction/);
  assert.match(shell, /secondaryActions/);
  assert.match(shell, /contextStrip/);
});

test("barrel re-exports the full foundation", () => {
  const barrel = UI("index.ts");
  for (const name of [
    "PageShell",
    "PageHeader",
    "Card",
    "Button",
    "Badge",
    "DataTable",
    "EmptyState",
    "FilterBar",
    "StatusBadge",
    "ConfirmActionProvider",
  ]) {
    assert.ok(barrel.includes(name), `barrel exports ${name}`);
  }
});
