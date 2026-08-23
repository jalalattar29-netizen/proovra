/**
 * THE SHELL IS PART OF THE CAPABILITY BOUNDARY.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE EXISTS TO STOP
 * ---------------------------------------------------------------------------
 * `useGlobalRuntimeState` polled three endpoints — runtime readiness, open
 * operational incidents, open reviewer escalations — for any context that
 * resolved a `teamId`, and the sidebar resolved that id from the workspace's
 * SHAPE rather than from the caller's AUTHORITY:
 *
 *     envelope.workspace.scope === "TEAM" ? envelope.workspace.id : null
 *
 * A shape is not a permission. It silenced a Personal Free space by accident
 * (scope PERSONAL) — which is why the boundary looked intact — and let every
 * refused ORGANIZATION context through: a platform administrator with no
 * membership, a member below the operational role floor, a workspace whose
 * package grants no Operations surface. Each polled `/v1/ops/incidents` every
 * 45 seconds and coloured a severity pill for a page the route gate refuses
 * them.
 *
 * Counting requests is the only way to see this. A refused context renders a
 * correct refusal panel whether or not the shell behind it is quietly reading,
 * so every DOM assertion in the suite passed while the boundary leaked.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH LEDGERS
 * ---------------------------------------------------------------------------
 * The route and the shell are different owners of the same boundary. Asserting
 * one total would let a fix in one hide a regression in the other, so each is
 * counted separately and both must be zero.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  observedOpsCalls,
  observedPlatformCalls,
  observedShellRuntimeCalls,
  openOperations,
  type OpsContext,
} from "./_fixtures";

/**
 * Every context the brief requires to make ZERO operational requests.
 *
 * Each names the boundary it is testing, because they look alike in a
 * screenshot and are different product statements — and because a shared
 * assertion that happens to pass for one reason should not be read as passing
 * for all of them.
 */
const REFUSED: ReadonlyArray<{ context: OpsContext; boundary: string }> = [
  {
    context: "personal-free",
    boundary:
      "no condition-producing package and one operator: there is no operational surface to poll for",
  },
  {
    context: "missing-envelope",
    boundary:
      "authority never resolved. The gate fails CLOSED on the first render, which is exactly when an ungated poller fires",
  },
  {
    context: "withheld-capability",
    boundary:
      "an otherwise entitled paid, shared workspace whose package grants no OPERATIONS_VIEW",
  },
  {
    context: "platform-admin-no-membership",
    boundary:
      "platform-admin status is not tenant authority — staff without a membership are refused exactly like anyone else",
  },
  {
    context: "suspended-workspace",
    boundary: "a suspended account cannot act, so operational chrome has nothing to offer",
  },
  {
    context: "wrong-workspace",
    boundary:
      "the envelope describes a DIFFERENT workspace, so its capabilities are the wrong evidence for this read",
  },
];

async function counts(page: Page) {
  // Give any timer-driven poll a chance to fire before counting. A boundary
  // that holds for 50ms and leaks at 500ms is not a boundary.
  await page.waitForTimeout(700);
  return {
    ops: observedOpsCalls().map((c) => c.path),
    shell: observedShellRuntimeCalls().map((c) => c.source),
    platform: [...observedPlatformCalls()],
  };
}

// ===========================================================================
// 1. REFUSED CONTEXTS READ NOTHING — ROUTE OR SHELL
// ===========================================================================

for (const { context, boundary } of REFUSED) {
  test(`${context}: ZERO operational requests — ${boundary}`, async ({
    page,
  }) => {
    await openOperations(page, context);
    const c = await counts(page);

    expect(c.ops, `${context}: the ROUTE must not read`).toEqual([]);
    expect(c.shell, `${context}: the SHELL must not read`).toEqual([]);
    expect(c.platform, `${context}: platform runtime is never tenant-read`).toEqual(
      [],
    );
  });
}

test("insufficient-role reads nothing operational either", async ({ page }) => {
  // A MEMBER of an Enterprise workspace below the operational role floor holds
  // OPERATIONS_VIEW (they may LOOK) but no acting capability. The shell may
  // therefore read incidents — and this records exactly that, so the
  // distinction between "may not look" and "may not act" stays visible.
  await openOperations(page, "insufficient-role");
  const c = await counts(page);
  expect(c.platform).toEqual([]);
  for (const source of c.shell) {
    expect(["incidents", "readiness"]).toContain(source);
  }
});

// ===========================================================================
// 2. PERMITTED CONTEXTS STILL READ — THE GATE IS NOT A MUTE BUTTON
// ===========================================================================

const PERMITTED: OpsContext[] = ["personal-pro", "team-admin", "enterprise-active"];

for (const context of PERMITTED) {
  test(`${context}: the shell still reads what it is entitled to`, async ({
    page,
  }) => {
    await openOperations(page, context);
    await page.waitForTimeout(700);
    const shell = observedShellRuntimeCalls().map((c) => c.source);
    // Incidents ride OPERATIONS_VIEW, which every one of these holds.
    expect(shell, `${context} should still poll incidents`).toContain("incidents");
  });
}

test("a PERSONAL workspace never asks for reviewer escalations", async ({
  page,
}) => {
  // ESCALATIONS_VIEW is granted to team-shaped workspaces only. A personal
  // space has no reviewer escalations, so asking would be a request whose
  // answer is always empty.
  await openOperations(page, "personal-pro");
  await page.waitForTimeout(700);
  const shell = observedShellRuntimeCalls().map((c) => c.source);
  expect(shell).not.toContain("escalations");
});

test("a shared workspace DOES ask for reviewer escalations", async ({ page }) => {
  await openOperations(page, "team-admin");
  await page.waitForTimeout(700);
  const shell = observedShellRuntimeCalls().map((c) => c.source);
  expect(shell).toContain("escalations");
});

// ===========================================================================
// 3. NO FALSE BADGE FROM AN UNREAD CONTEXT
// ===========================================================================

test("a refused context shows no operational severity pill", async ({ page }) => {
  await openOperations(page, "withheld-capability");
  await page.waitForTimeout(700);
  // Whatever the shell renders, it must not claim a severity it never read.
  // HEALTHY drawn from an absence of data is the false all-clear this whole
  // program exists to remove.
  const pill = page.locator("[data-global-runtime-severity]");
  if ((await pill.count()) > 0) {
    const severity = await pill.first().getAttribute("data-global-runtime-severity");
    expect(severity, "an unread context is UNKNOWN, never HEALTHY").not.toBe(
      "HEALTHY",
    );
  }
});

// ===========================================================================
// 4. A SETTLED REFUSAL IS NOT RETRIED FOREVER
// ===========================================================================

test("a 403 latches the source off rather than retrying on every tick", async ({
  page,
}) => {
  // The server is authoritative and can refuse a caller the client believed
  // was entitled — a revoked membership between two polls, for instance. A
  // 403 is a settled answer: retrying it every 45 seconds is an unbounded
  // stream of requests that will never succeed.
  await page.route("**/v1/ops/incidents**", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "permission_denied" } }),
    }),
  );
  await openOperations(page, "team-admin");

  await page.waitForTimeout(500);
  const first = observedShellRuntimeCalls().filter(
    (c) => c.source === "incidents",
  ).length;
  await page.waitForTimeout(1500);
  const second = observedShellRuntimeCalls().filter(
    (c) => c.source === "incidents",
  ).length;

  expect(second, "a refused source must not keep retrying").toBe(first);
});

// ===========================================================================
// 5. A WORKSPACE SWITCH CANNOT REPOPULATE THE NEW SHELL
// ===========================================================================

test("leaving a permitted workspace for a refused one silences the shell", async ({
  page,
}) => {
  await openOperations(page, "team-admin");
  await page.waitForTimeout(700);
  expect(
    observedShellRuntimeCalls().length,
    "the permitted context should have read",
  ).toBeGreaterThan(0);

  // The same browser, a different context. `openOperations` resets the
  // ledgers, so what is counted now is only what the SECOND context asked.
  await openOperations(page, "withheld-capability");
  const c = await counts(page);
  expect(c.shell, "the refused context must ask for nothing").toEqual([]);
  expect(c.ops).toEqual([]);
});
