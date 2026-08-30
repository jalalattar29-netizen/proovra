/**
 * SETTINGS — the rail each workspace context is actually given.
 *
 * WHAT THIS CLOSES
 * ---------------------------------------------------------------------------
 * This project rendered two actors: a personal space, and an organization
 * owner holding every capability. Between them sits most of an Enterprise
 * deployment — members and viewers — and nothing rendered them at all. The
 * risk that leaves open runs both ways: a Personal simplification quietly
 * removing an Enterprise destination, and an Enterprise workspace handing its
 * administration to whoever happens to be standing in it.
 *
 * Every assertion here is about the CANONICAL resolver's answer, so a
 * destination appears because `resolveRouteAccess` allowed it and not because
 * a role name matched.
 */

import { expect, test } from "@playwright/test";

import { openSettings } from "./_fixtures";

const navIds = (page: import("@playwright/test").Page) =>
  page
    .locator("[data-settings-nav-item]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-settings-nav-item")));

/** Everything an ACCOUNT holder gets, whoever they work for. */
const ACCOUNT_RAIL = ["security", "notifications", "privacy"];

/** Destinations that administer a workspace or organization. */
const ADMIN_RAIL = [
  "workspace",
  "members",
  "roles",
  "retention",
  "integrations",
  "sso",
  "audit",
  "billing",
];

test.describe("settings — a personal space stays compact", () => {
  test("account destinations only, and no workspace administration", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSettings(page, "personal");
    const ids = await navIds(page);

    expect(ids).toEqual(["overview", ...ACCOUNT_RAIL]);
    for (const id of ADMIN_RAIL) {
      expect(ids, `${id} must not leak into a personal space`).not.toContain(id);
    }
    await expect(page.locator("[data-settings-nav]")).not.toContainText(
      "Workspace",
    );
  });
});

test.describe("settings — an Enterprise organization keeps its full rail", () => {
  test("an owner is offered account AND administration", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "org-owner");
    const ids = await navIds(page);

    // The Personal simplification must never have reached this actor.
    for (const id of [...ACCOUNT_RAIL, ...ADMIN_RAIL]) {
      expect(ids, `an Enterprise owner must be offered ${id}`).toContain(id);
    }

    // The groups a reader navigates by.
    const nav = page.locator("[data-settings-nav]");
    for (const group of ["Account", "Workspace", "Integrations", "System"]) {
      await expect(nav).toContainText(group);
    }
  });

  test("the AI destination says what it is", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "org-owner");

    // It was called "General", and its own subtitle promised "workspace
    // settings and defaults for everyone working here", while the pane held
    // one section: AI assistance. Workspace defaults that do exist are owned
    // by the workspace and organization admin consoles, and Settings hands off
    // to those — so there was no General domain to fill, only a mislabelled
    // AI one.
    const item = page.locator('[data-settings-nav-item="workspace"]');
    await expect(item).toContainText("AI & assistance");
    await expect(page.locator("[data-settings-nav]")).not.toContainText("General");

    await item.click();
    await expect(page.locator("h2").first()).toContainText("AI & assistance");
    // The ORGANIZATION branch of the section — an org administers AI policy
    // for the workspace, where a personal account manages its own assistance.
    await expect(page.locator("[data-cc-ai-org]")).toBeVisible();
    // And the usage counters render rather than taking the pane to the 500
    // boundary, which is what an unguarded `usage.monthly` did until now.
    await expect(page.locator("[data-cc-ai-org-usage]")).toBeVisible();
  });
});

test.describe("settings — Enterprise membership is not Enterprise authority", () => {
  for (const actor of ["org-member", "org-viewer"] as const) {
    test(`${actor} gets their account, and none of the administration`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openSettings(page, actor);
      const ids = await navIds(page);

      // Their own account, in full. Privacy rights in particular do not
      // depend on someone's role in an organization.
      expect(ids).toEqual(["overview", ...ACCOUNT_RAIL]);

      // And none of the administration, despite standing in an Enterprise
      // workspace. `isEnterpriseWorkspace` is true for this actor: being
      // inside an Enterprise organization is not authority over it.
      for (const id of ADMIN_RAIL) {
        expect(ids, `${actor} must not be offered ${id}`).not.toContain(id);
      }
    });

    test(`${actor} still reaches every personal privacy control`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openSettings(page, actor, "#privacy");

      await expect(page.locator("[data-cc-privacy-cookies]")).toBeVisible();
      await expect(page.locator("[data-cc-privacy-policies]")).toBeVisible();
      await expect(page.locator("[data-cc-privacy-export]")).toBeVisible();
      await expect(page.locator("[data-cc-privacy-closure]")).toBeVisible();
    });
  }
});

test.describe("settings — the Overview names the context it is in", () => {
  test("an organization is called an organization, and an agreement an agreement", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "org-owner");

    const context = page.locator(".set-hero__context");
    await expect(context).toBeVisible();

    // In an organization, `activeWorkspaceName` IS the organization — and it
    // was labelled "Workspace", so an Enterprise administrator could not tell
    // which of the two they were reading. "Plan" had the same problem: an
    // agreement is not a plan, and `deriveSettingsUiContext` already computes
    // the right word (`scopeLabel`).
    await expect(context).toContainText("Organization");
    await expect(context).toContainText("Proovra Insurance");
    await expect(context).not.toContainText("Personal plan");
  });

  test("a personal space still reads as a personal space", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal");

    const context = page.locator(".set-hero__context");
    await expect(context).toContainText("Workspace");
    await expect(context).toContainText("Personal Space");
    await expect(context).toContainText("Personal plan");
    // A personal account is not in an organization, and must not be told it is.
    await expect(context).not.toContainText("Organization");
  });
});

test.describe("settings — the Enterprise role matrix", () => {
  /**
   * Every destination, per actor, decided by CAPABILITY.
   *
   * The actors here differ only in the capabilities their envelope carries —
   * no role name is compared anywhere in the resolver, and none is compared
   * here. `org-owner` holds the administration capabilities; `org-member` and
   * `org-viewer` stand in the SAME Enterprise organization holding none.
   */
  const MATRIX = [
    { actor: "org-owner", visible: [...ACCOUNT_RAIL, ...ADMIN_RAIL], hidden: [] },
    { actor: "org-member", visible: ACCOUNT_RAIL, hidden: ADMIN_RAIL },
    { actor: "org-viewer", visible: ACCOUNT_RAIL, hidden: ADMIN_RAIL },
  ] as const;

  for (const row of MATRIX) {
    test(`${row.actor}: visible and hidden destinations`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openSettings(page, row.actor as "org-owner");
      const ids = await navIds(page);

      for (const id of row.visible) {
        expect(ids, `${row.actor} must see ${id}`).toContain(id);
      }
      for (const id of row.hidden) {
        expect(ids, `${row.actor} must not see ${id}`).not.toContain(id);
      }
    });
  }

  test("a refused destination does not render when named in the URL", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });

    // Hiding a nav item is not authorization. `resolvePaneFromHash` only
    // returns panes the resolver ALLOWED, so a deep link to one it refused
    // falls back rather than mounting the surface behind it.
    for (const hash of ["#roles", "#members", "#retention", "#audit", "#billing"]) {
      await openSettings(page, "org-member", hash);
      await expect(
        page.locator('[data-settings-pane="overview"]'),
        `${hash} must fall back for a member`,
      ).toBeVisible();
      await expect(page.locator("[data-cc-roles-summary-role]")).toHaveCount(0);
      await expect(page.locator("[data-settings-handoff]")).toHaveCount(0);
    }
  });

  test("Roles is capability-gated, not organization-gated", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });

    // THE DEFECT THIS PINS. It was gated on `isOrg` ALONE — no capability at
    // all — so every member and viewer of an Enterprise organization was
    // offered "Roles & permissions" under a WORKSPACE heading, beside
    // destinations they could not reach, on a rail that is otherwise entirely
    // capability-resolved.
    await openSettings(page, "org-owner");
    expect(await navIds(page)).toContain("roles");

    await openSettings(page, "org-member");
    expect(await navIds(page)).not.toContain("roles");

    await openSettings(page, "org-viewer");
    expect(await navIds(page)).not.toContain("roles");
  });
});

test.describe("settings — SSO/SCIM is decided by the route registry", () => {
  test("an Enterprise administrator is offered it, and it hands off", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "org-owner");

    const item = page.locator('[data-settings-nav-item="sso"]');
    await expect(item).toBeVisible();

    await item.click();
    // Settings does not re-implement identity federation; it points at the
    // console that owns it, through the documented procurement deep link.
    const handoff = page.locator('[data-settings-handoff="sso"]');
    await expect(handoff).toBeVisible();
    await expect(handoff.locator("a")).toHaveAttribute(
      "href",
      "/settings/security/saml",
    );
  });

  test("a personal space is not offered it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "personal");
    expect(await navIds(page)).not.toContain("sso");
  });

  test("an Enterprise member without the capability is not offered it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "org-member");
    // THE POINT of registering the route. This used to be decided by a
    // hand-written `isEnterpriseWorkspace && has(SECURITY_CENTER_VIEW)` pair
    // rather than by `resolveRouteAccess`. The answer is the same; the
    // authority is now the one every other destination uses.
    expect(await navIds(page)).not.toContain("sso");
  });

  test("naming it in the URL does not render it for someone refused", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openSettings(page, "org-member", "#sso");
    // A pane the resolver refused falls back rather than rendering.
    await expect(page.locator('[data-settings-pane="overview"]')).toBeVisible();
    await expect(page.locator('[data-settings-handoff="sso"]')).toHaveCount(0);
  });
});

test.describe("settings — switching context changes the rail", () => {
  test("the same session shows each context its own destinations", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });

    // Personal first.
    await openSettings(page, "personal");
    expect(await navIds(page)).toEqual(["overview", ...ACCOUNT_RAIL]);

    // Then the same person in their Enterprise organization. The envelope is
    // what changes; nothing about the rail may be carried over from before it.
    await openSettings(page, "org-owner");
    const orgIds = await navIds(page);
    for (const id of ADMIN_RAIL) expect(orgIds).toContain(id);

    // And back. A stale Enterprise destination here would be an administration
    // link rendered for a context that has no administration.
    await openSettings(page, "personal");
    const backIds = await navIds(page);
    expect(backIds).toEqual(["overview", ...ACCOUNT_RAIL]);
    for (const id of ADMIN_RAIL) {
      expect(backIds, `${id} must not survive the switch back`).not.toContain(id);
    }
  });
});
