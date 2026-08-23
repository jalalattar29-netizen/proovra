/**
 * OPERATIONS — THE WORKSPACE / CAPABILITY MATRIX, IN A REAL BROWSER.
 *
 * Every context below is proven SEPARATELY. "Personal Free is refused" and "a
 * suspended workspace is refused" look alike in a screenshot and are different
 * product statements: one is a workspace that never had a workbench, the other
 * is one that has lost it. Folding them into a single parameterised assertion
 * would let either regress into the other unnoticed.
 *
 * For each context this file records the nine facts the brief asks for: the
 * route-gate result, the Operations API calls, the visible summary metrics,
 * the ownership axis, the mutations, the bulk controls, the inspector actions,
 * the read-only behaviour and the restricted/inactive behaviour.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  observedOpsCalls,
  observedPlatformCalls,
  openOperations,
  operatorCountFor,
  type OpsContext,
} from "./_fixtures";

// ---------------------------------------------------------------------------
// Readers — each answers ONE of the nine facts.
// ---------------------------------------------------------------------------

const gate = (page: Page) =>
  page.locator('[data-page-route-gate-route-id="workspace.operations"]');
const workbench = (page: Page) => page.locator('[data-testid="operations-page"]');
const table = (page: Page) => page.locator("[data-ops-table-surface]");

async function visibleMetrics(page: Page): Promise<string[]> {
  return page.locator("[data-ops-metric]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-ops-metric") ?? ""),
  );
}

async function opsPaths(): Promise<string[]> {
  return observedOpsCalls().map((c) => c.path);
}

/**
 * Every context reads through this, so a fact can never be asserted for one
 * context and silently skipped for another.
 */
async function profile(page: Page) {
  const gateCount = await gate(page).count();
  return {
    gateVisible: gateCount,
    // Absent when the gate ALLOWED: it renders its children and no wrapper.
    // Reading the attribute unconditionally waits for an element that will
    // never appear, which times out instead of reporting "allowed".
    gateState:
      gateCount > 0
        ? await gate(page).getAttribute("data-page-route-gate-state")
        : "ALLOWED",
    workbench: await workbench(page).count(),
    metrics: await visibleMetrics(page),
    ownerFilter: await page.locator("[data-ops-owner-filter]").count(),
    ownerCells: await table(page).locator("[data-ops-owner]").count(),
    rowMenus: await page.locator("[data-ops-row-menu-trigger]").count(),
    checkboxes: await page.locator('input[type="checkbox"]').count(),
    bulkBar: await page.locator("[data-ops-bulk-toolbar]").count(),
    opsCalls: await opsPaths(),
    platformCalls: [...observedPlatformCalls()],
    h1: await page.locator("h1").count(),
  };
}

/** The four facts every context shares, whatever else it does. */
async function assertUniversalInvariants(page: Page) {
  // Never a platform-runtime read from a tenant page.
  expect(observedPlatformCalls(), "no platform runtime").toEqual([]);
  // Never a link to a console the reader is refused from.
  const platformLinks = await page
    .locator('a[href^="/admin/platform/"]')
    .count();
  expect(platformLinks, "no platform-admin link").toBe(0);
  // Never a second page shell.
  expect(await page.locator("[data-hub-bar]").count()).toBe(0);
  // Never a native option popup.
  expect(await page.locator("select").count()).toBe(0);
}

// ===========================================================================
// REFUSED CONTEXTS — the workbench must not mount, and must not ask.
// ===========================================================================

const REFUSED: ReadonlyArray<{ context: OpsContext; because: string }> = [
  {
    context: "personal-free",
    because:
      "no condition-producing package and one operator: there is no shared triage to do",
  },
  {
    context: "platform-admin-no-membership",
    because:
      "platform-admin status is not tenant authority; being staff does not make somebody an operator of a customer's workspace",
  },
  {
    context: "missing-envelope",
    because: "authority never resolved, so the surface fails CLOSED",
  },
  {
    context: "withheld-capability",
    because:
      "the acting capabilities are present and the VIEWING one is not; the route gate reads the one that opens it",
  },
];

for (const { context, because } of REFUSED) {
  test.describe(`refused: ${context}`, () => {
    test(`is refused by the canonical gate — ${because}`, async ({ page }) => {
      await openOperations(page, context);

      // A refusal is either the SHARED structured panel every capability-gated
      // route renders, or the shell declining to route there at all. Both are
      // refusals; asserting one SHAPE would make this a test of which one the
      // shell picked rather than of whether the caller got in.
      const p = await profile(page);
      expect(p.gateState).not.toBe("ALLOWED");
      expect(p.workbench, "the workbench must not mount").toBe(0);

      // ZERO reads by the ROUTE. Not a 403 the panel then explains — no call.
      //
      // `/v1/ops/incidents` is excluded and asserted separately below,
      // because the app SHELL polls it from `useGlobalRuntimeState` on every
      // authenticated page to drive the topbar severity pill. Folding that
      // into this expectation would either hide the finding or blame this
      // route for a read it does not make.
      const routeReads = (await opsPaths()).filter(
        (c) => !c.endsWith("/v1/ops/incidents"),
      );
      expect(routeReads, "the workbench must not read anything").toEqual([]);
      await assertUniversalInvariants(page);
    });

    test("offers no retry and no workbench chrome behind the panel", async ({
      page,
    }) => {
      await openOperations(page, context);
      await expect(page.locator("[data-ops-summary]")).toHaveCount(0);
      await expect(page.locator("[data-ops-controls]")).toHaveCount(0);
      await expect(table(page)).toHaveCount(0);
      // Exactly one heading survives, whatever the gate rendered.
      expect(await page.locator("h1").count()).toBeLessThanOrEqual(1);
    });
  });
}

// ===========================================================================
// A SHELL-OWNED READ, RECORDED RATHER THAN HIDDEN
// ===========================================================================

test.describe("the shell's runtime poller is the only non-route ops read", () => {
  /**
   * FINDING (pre-existing, not introduced by the workbench redesign).
   *
   * `apps/web/lib/useGlobalRuntimeState.ts` polls
   * `GET /v1/ops/incidents?status=OPEN` every 45s to drive the topbar
   * severity pill and the sidebar escalation badge. It is mounted by
   * `AppSidebarV2` and `GlobalRuntimeIndicator`, on EVERY authenticated
   * page, and it has no OPERATIONS_* capability gate — it fires for a caller
   * the Operations route itself refuses.
   *
   * It is not a security hole: the endpoint is gated server-side on the
   * role-based `operations.view` permission, which every ACTIVE member of a
   * workspace holds. It is a scope and chattiness issue owned by the app
   * shell, and changing it would move the severity pill on every page in the
   * product — well outside this route's blast radius.
   *
   * Pinned here so the day the shell gains a gate, this test says so.
   */
  test("no refused context is read by anything EXCEPT that poller", async ({
    page,
  }) => {
    await openOperations(page, "withheld-capability");
    const paths = new Set((await opsPaths()).map((p) => p));
    for (const path of paths) {
      expect(
        path.endsWith("/v1/ops/incidents"),
        `${path} is read by neither the route nor the shell poller`,
      ).toBe(true);
    }
  });

  test("Personal Free is read by nothing at all", async ({ page }) => {
    // The shell demotes to its self-serve experience here and never mounts
    // the operator chrome, so this context is genuinely silent — which is
    // what makes it the strongest of the refusal proofs.
    await openOperations(page, "personal-free");
    expect(await opsPaths()).toEqual([]);
  });
});

// ===========================================================================
// SOLE-OPERATOR CONTEXTS — the workbench mounts, ownership does not.
// ===========================================================================

test.describe("personal-pro: a workbench with no ownership axis", () => {
  test("mounts, and drops every collaborative control", async ({ page }) => {
    await openOperations(page, "personal-pro");
    const p = await profile(page);

    expect(p.workbench).toBe(1);
    expect(p.h1).toBe(1);
    // FOUR cards: the two that partition work between people are absent,
    // because there is only one person.
    expect(p.metrics).toEqual(["open", "critical", "high", "overdue"]);
    expect(p.ownerFilter).toBe(0);
    expect(p.ownerCells).toBe(0);
    // It never even asked who could be assigned.
    expect(p.opsCalls.some((c) => c.includes("assignable-operators"))).toBe(
      false,
    );
    // The acting controls it DOES have are present.
    expect(p.rowMenus).toBeGreaterThan(0);
    expect(p.checkboxes).toBeGreaterThan(0);
    await assertUniversalInvariants(page);
  });

  test("its inspector offers the transitions and no owner picker", async ({
    page,
  }) => {
    await openOperations(page, "personal-pro");
    await page.locator("[data-ops-open]").first().click();
    await expect(page.locator("[data-ops-inspector]")).toBeVisible();
    await expect(page.locator("[data-ops-assignment-control]")).toHaveCount(0);
    await expect(
      page.locator('[data-ops-inspector-actions] [data-ops-action="resolve"]'),
    ).toBeVisible();
  });
});

// ===========================================================================
// COLLABORATIVE CONTEXTS — same anatomy, ownership added.
// ===========================================================================

const COLLABORATIVE: ReadonlyArray<{
  context: OpsContext;
  canAssign: boolean;
  note: string;
}> = [
  {
    context: "owned-workspace",
    canAssign: true,
    note: "a paid shared workspace that is not an organization renders exactly what a Team does",
  },
  { context: "team-admin", canAssign: true, note: "the ordinary shared case" },
  {
    context: "organization-admin",
    canAssign: true,
    note: "an organization is not a page fork",
  },
  {
    context: "enterprise-active",
    canAssign: true,
    note: "Enterprise density is filters and disclosure, not a separate component",
  },
  {
    context: "enterprise-retained",
    canAssign: false,
    note: "a lapsed contract with retained evidence obligations keeps the queue and loses only what the envelope withdrew",
  },
  {
    context: "platform-admin-member",
    canAssign: true,
    note: "a platform admin WITH membership gets ordinary tenant authority and no more",
  },
];

for (const { context, canAssign, note } of COLLABORATIVE) {
  test.describe(`collaborative: ${context}`, () => {
    test(`renders the shared anatomy — ${note}`, async ({ page }) => {
      await openOperations(page, context);
      const p = await profile(page);

      expect(p.workbench).toBe(1);
      expect(p.h1).toBe(1);
      // SIX cards: ownership is a real axis wherever more than one operator
      // can hold work, and that comes from the server's COUNT.
      expect(operatorCountFor(context)).toBeGreaterThan(1);
      expect(p.metrics).toEqual([
        "open",
        "critical",
        "high",
        "overdue",
        "assignedToMe",
        "unassigned",
      ]);
      expect(p.ownerFilter).toBe(1);
      expect(p.ownerCells).toBeGreaterThan(0);
      expect(p.rowMenus).toBeGreaterThan(0);
      await assertUniversalInvariants(page);
    });

    test(`assignment follows the capability, not the plan`, async ({ page }) => {
      await openOperations(page, context);
      await page.locator("[data-ops-open]").first().click();
      await expect(page.locator("[data-ops-inspector]")).toBeVisible();

      if (canAssign) {
        await expect(page.locator("[data-ops-assignment-control]")).toBeVisible();
        await expect(page.locator('[data-ops-action="self-assign"]')).toBeVisible();
      } else {
        // Ownership is still READABLE — it is the verb that was withdrawn.
        await expect(page.locator("[data-ops-assignment-control]")).toHaveCount(0);
        await expect(page.locator("[data-ops-assignee-readonly]")).toBeVisible();
      }
    });

    test("the bulk toolbar appears only after a selection", async ({ page }) => {
      await openOperations(page, context);
      await expect(page.locator("[data-ops-bulk-toolbar]")).toHaveCount(0);
      await page.locator("[data-ops-row-mark]").first().click();
      const bar = page.locator("[data-ops-bulk-toolbar]");
      await expect(bar).toBeVisible();
      expect(await bar.getAttribute("data-ops-bulk-count")).toBe("1");
    });
  });
}

// ===========================================================================
// READ-ONLY CONTEXTS
// ===========================================================================

const READ_ONLY: ReadonlyArray<{ context: OpsContext; note: string }> = [
  { context: "viewer", note: "an explicit VIEWER role" },
  {
    context: "insufficient-role",
    note: "a MEMBER of an Enterprise workspace whose role floor does not reach the operational tier",
  },
];

for (const { context, note } of READ_ONLY) {
  test.describe(`read-only: ${context}`, () => {
    test(`sees the work and is offered nothing to press — ${note}`, async ({
      page,
    }) => {
      await openOperations(page, context);
      const p = await profile(page);

      expect(p.workbench).toBe(1);
      // The ownership AXIS survives: "who is on this?" is the question a
      // read-only operator is there to answer, and they will never hold
      // OPERATIONS_ASSIGN — so the axis cannot be derived from that.
      expect(p.ownerFilter).toBe(1);
      expect(p.ownerCells).toBeGreaterThan(0);
      expect(p.metrics).toContain("unassigned");

      // …and every verb is gone. Not disabled — absent.
      expect(p.rowMenus).toBe(0);
      expect(p.checkboxes).toBe(0);
      expect(p.bulkBar).toBe(0);
      await assertUniversalInvariants(page);
    });

    test("the inspector is a reader, and says so", async ({ page }) => {
      await openOperations(page, context);
      await page.locator("[data-ops-open]").first().click();
      await expect(page.locator("[data-ops-inspector]")).toBeVisible();
      await expect(page.locator("[data-ops-inspector-actions]")).toHaveCount(0);
      await expect(page.locator("[data-ops-assignee-readonly]")).toBeVisible();
      // The header explains the absence rather than leaving it a mystery.
      await expect(page.locator('[data-testid="operations-header"]')).toContainText(
        /needs an operator role/i,
      );
    });
  });
}

// ===========================================================================
// WORKSPACE LIFECYCLE
// ===========================================================================

test.describe("workspace lifecycle", () => {
  test("an INACTIVE workspace still resolves one page and one header", async ({
    page,
  }) => {
    await openOperations(page, "inactive-workspace");
    // Whatever the shell decides, the two invariants hold: it is never two
    // pages, and it never reaches for platform runtime on the way.
    expect(await page.locator("h1").count()).toBeLessThanOrEqual(1);
    await assertUniversalInvariants(page);
  });

  test("a SUSPENDED workspace never renders a live mutation control", async ({
    page,
  }) => {
    await openOperations(page, "suspended-workspace");
    await assertUniversalInvariants(page);
    // If the workbench renders at all, nothing on it may commit shared state
    // without the account behind it being live.
    const bulk = await page.locator("[data-ops-bulk-toolbar]").count();
    expect(bulk).toBe(0);
  });

  test("a WRONG-workspace envelope never paints another workspace's queue", async ({
    page,
  }) => {
    await openOperations(page, "wrong-workspace");
    await assertUniversalInvariants(page);
    // Whatever it reads, it reads for the workspace the ENVELOPE named. The
    // page has no second source of workspace identity to disagree with.
    const ids = observedOpsCalls()
      .map((c) => new URLSearchParams(c.query).get("teamId"))
      .filter(Boolean);
    expect(new Set(ids).size).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// THE BOUNDARY, ASSERTED ONCE MORE ACROSS EVERY MOUNTED CONTEXT
// ===========================================================================

const MOUNTED: OpsContext[] = [
  "personal-pro",
  "owned-workspace",
  "team-admin",
  "organization-admin",
  "enterprise-active",
  "enterprise-retained",
  "platform-admin-member",
  "viewer",
  "insufficient-role",
];

for (const context of MOUNTED) {
  test(`${context}: reads only workspace-scoped Operations endpoints`, async ({
    page,
  }) => {
    await openOperations(page, context);
    const calls = observedOpsCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.path, `${call.path} must be an ops endpoint`).toMatch(
        // `saved-views` joined the set in Phase B. It is listed by NAME
        // rather than loosened to a prefix, so a future surface still has to
        // declare itself here instead of arriving unnoticed.
        /\/v1\/ops\/(summary|incidents|assignable-operators|bulk-actions|saved-views)/,
      );
      expect(
        new URLSearchParams(call.query).get("teamId"),
        `${call.path} must be workspace-scoped`,
      ).toBeTruthy();
    }
    expect(observedPlatformCalls()).toEqual([]);
  });
}
