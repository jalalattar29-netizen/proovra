/**
 * THE BOOT CHAIN IS TWO LEVELS DEEP, NOT THREE.
 *
 * Home's reads are workspace-scoped, so they wait for the platform context.
 * The platform context used to wait for the identity fetch — not because it
 * needed the answer, but because `(app)/layout.tsx` returned its placeholder
 * BEFORE `PlatformContextProvider`, so the provider did not exist to start
 * its own request until `/v1/users/me` had already come back.
 *
 * Measured in Chrome against a production build of the app and the local
 * fixture API, populated organization workspace, median of five loads:
 *
 *                        first KPI on screen
 *     serial context           1131ms
 *     parallel context          850ms
 *
 * and with 2ms of round-trip latency added between the API and Postgres,
 * where a serialised chain costs what it actually costs:
 *
 *     serial context           2880ms
 *     parallel context         1708ms
 *
 * This is a source guard rather than a render test because the defect is
 * structural — an early `return` above a provider — and a render test that
 * mounts the layout would not observe the ordering of two fetches it stubs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAYOUT = resolve(HERE, "../app/(app)/layout.tsx");
const BELL = resolve(HERE, "../components/app-shell-v2/NotificationBell.tsx");

const read = (p: string) => readFileSync(p, "utf8");

test("the platform context provider is not gated behind the identity fetch", () => {
  const src = read(LAYOUT);
  const gate = src.indexOf("!authReady");
  const provider = src.indexOf("<PlatformContextProvider>");
  assert.ok(gate > -1, "the authReady gate should still exist");
  assert.ok(provider > -1, "the layout should still mount PlatformContextProvider");
  assert.ok(
    provider < gate,
    "PlatformContextProvider must MOUNT before the authReady gate is evaluated — " +
      "otherwise GET /v1/platform/context cannot start until GET /v1/users/me returns",
  );
});

test("no early return can skip the provider", () => {
  /*
   * The specific shape of the original defect: a `return` statement that
   * leaves the component before the provider is ever rendered. Any return in
   * the layout body must come after the provider is in the tree.
   */
  const src = read(LAYOUT);
  // Top-level returns only — the two-space indent of the component body.
  // `handleLogout` and the hooks sit deeper and are not candidates.
  const topLevelReturns = src.match(/^ {2}return[ (]/gm) ?? [];
  assert.equal(
    topLevelReturns.length,
    1,
    "the layout must have exactly ONE top-level return, the one that mounts " +
      "<PlatformContextProvider>; any earlier return re-serialises the boot chain",
  );
});

test("the placeholder still renders while auth is resolving", () => {
  // The point is to start the fetch sooner, NOT to show anything sooner.
  // The same placeholder must still stand in until auth is ready.
  const src = read(LAYOUT);
  assert.match(src, /!authReady \? \(\s*\n?\s*<div className="min-h-screen/);
});

test("the notification bell does not count before its scope is decided", () => {
  /*
   * The bell's summary poll closes over the active workspace, so it used to
   * fire once with no workspace — which the server reads as "every workspace"
   * — and again the moment the context arrived. Two requests in the most
   * contended part of the boot, the first thrown away by the second, and a
   * badge briefly counted across a scope the list beside it does not show.
   */
  const src = read(BELL);
  assert.match(src, /const workspaceResolved = contextState\?\.name !== "LOADING_CONTEXT"/);
  assert.match(src, /if \(!workspaceResolved\) return;/);
  assert.match(src, /\}, \[loadSummary, workspaceResolved\]\);/);
});

test("the bell still polls once the context resolves to no workspace", () => {
  // "No workspace" and "not told yet" are the same `null`. Only the second
  // suppresses the poll; a resolved context with no workspace still counts.
  const src = read(BELL);
  assert.doesNotMatch(
    src,
    /if \(!activeWorkspaceId\) return;/,
    "gating on the id itself would silently disable the bell for a resolved context with no workspace",
  );
});
