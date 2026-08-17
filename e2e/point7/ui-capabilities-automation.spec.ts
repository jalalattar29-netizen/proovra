/**
 * PHASE 13 — POINT 7: JOURNEY A, the automation console and the provider
 * budget surface.
 *
 * Five registered write routes with no product surface. The automation
 * console could list rules and their runs and could not author, amend, arm or
 * disarm one of them — a rule engine whose rules could only arrive through a
 * REST client. The intelligence platform could report provider spend against
 * budgets that nothing in the product could create.
 *
 * WHY THE AUTOMATION ACTOR IS AN OPERATOR PROFILE, AND WHY THAT IS NOT A CHEAT
 * ---------------------------------------------------------------------------
 * `/operations/automation` is registered with `requiredActiveSpace:
 * "PLATFORM_ADMIN"` (routeRegistry.ts, id `platform.automation`), so
 * `resolveRouteAccess` short-circuits to PLATFORM_ADMIN_ONLY for everyone
 * else. The capability its controls read, `AUTOMATION_MANAGE`, is granted at
 * TEAM scope to OWNER/ADMIN, and the SERVER permission behind every one of
 * these routes — `integration.webhook.manage` — is derived from the workspace
 * role, with platform admins explicitly denied a bypass
 * (`automation.routes.ts:78-109`).
 *
 * The single actor who can both OPEN the page and PERFORM the write is
 * therefore a platform admin who also holds OWNER on a non-personal
 * workspace. That is what `buildEnterpriseFixture({ platformAdminOwner: true })`
 * builds, and it is a faithful reproduction of the product's own gate rather
 * than a way around it: the route gate is real and is satisfied, and the
 * server-side authorization is real and is satisfied separately, by the
 * workspace role. Widening a platform-admin route gate to make a test easier
 * would be changing the product to fit the test; this reviewed the gate and
 * left it alone.
 *
 * The provider-budget capability does NOT use that profile. `/intelligence`
 * is an `ENTERPRISE_ONLY_ROUTE_IDS` route reached by an ordinary enterprise
 * workspace owner, and giving it a platform-admin actor would have hidden a
 * genuine enterprise-gate failure behind the platform-admin escape in
 * `resolveRouteAccess`.
 *
 * WHY THE TOGGLE CAPABILITIES SELECT THEIR SUBJECT AT `open()`
 * ---------------------------------------------------------------------------
 * A rule offers exactly one toggle leg at a time — the inverse of its current
 * state — so once the authorized pass has enabled a rule, that rule no longer
 * has an "Enable" control for the injected-500 pass to act on. Each toggle
 * journey therefore seeds a PAIR of rules and picks, at `open()`, whichever
 * one is still in the pre-state. The durable count spans the pair, so
 * "exactly one row moved" stays exactly as strict as elsewhere.
 *
 * Rule CREATION is capability seventeen and is driven through the browser
 * there. Where a rule is merely the SUBJECT of a later capability it is
 * created through the real route from inside the authenticated page, because
 * re-driving the authoring form four more times would be re-proving
 * capability seventeen rather than proving the toggle.
 */

import { test, expect, type Page } from "@playwright/test";

import { countRows, directApiCall, login, provenBrowserScenario, sql } from "./_harness";
import {
  activateOnce,
  activateTwice,
  attachUiProbe,
  buildEnterpriseFixture,
  expectSurfaceRendered,
  proveMutationCapability,
  proveServerRefusal,
  waitForSurface,
  type UiEnterpriseFixture,
  type UiProbe,
} from "./_ui-fixtures";

const SUITE = "e2e/point7/ui-capabilities-automation.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

const AUTOMATION_ROUTE_ID = "platform.automation";
const INTELLIGENCE_ROUTE_ID = "workspace.intelligence";

/**
 * `APPLY_LABEL` is the action whose config schema has exactly one required
 * field, so it isolates the AUTHORING PATH rather than a config form.
 * `EVIDENCE_CREATED` is in the DB CHECK allowlist from the first automation
 * migration, so it cannot fail for a migration-ordering reason.
 */
const TRIGGER_TYPE = "EVIDENCE_CREATED";
const ACTION_TYPE = "APPLY_LABEL";

type AutomationSession = {
  page: Page;
  probe: UiProbe;
  fixture: UiEnterpriseFixture;
};

async function signInAsOperator(
  page: Page,
  fixture: UiEnterpriseFixture,
): Promise<AutomationSession> {
  const probe = await attachUiProbe(page);
  await login(page, fixture.owner);
  return { page, probe, fixture };
}

/**
 * Create a rule through the REAL route, from inside the authenticated page.
 *
 * The subject of the toggle journeys. Written through the product's own
 * endpoint rather than with an INSERT, because `enabled: false` on create,
 * the initial `version`, and the action-config validation are things the
 * write path computes — a hand-written row would be a plausible-looking rule
 * that no product code ever produced.
 */
async function seedAutomationRule(
  page: Page,
  input: { teamId: string; name: string },
): Promise<string> {
  const res = await directApiCall(page, {
    method: "POST",
    path: "/v1/automation/rules",
    body: {
      teamId: input.teamId,
      name: input.name,
      triggerType: TRIGGER_TYPE,
      actionType: ACTION_TYPE,
      actionConfigJson: { label: "p7-ui" },
    },
  });
  expect(res.status, `seedAutomationRule failed: ${res.body}`).toBe(201);
  const id = (JSON.parse(res.body) as { id?: string }).id;
  expect(id, `seedAutomationRule returned no id: ${res.body}`).toBeTruthy();
  return id!;
}

test.describe("JOURNEY A — automation console and provider budgets", () => {
  // =========================================================================
  // 17 + 18. POST /v1/automation/rules, then PATCH /v1/automation/rules/:id
  //
  // One test, because the amend capability has no subject until the authoring
  // capability has produced one, and manufacturing a rule with SQL to split
  // them would replace the thing under test with a fixture.
  // =========================================================================

  test("p7.ui.automation.rule_created", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({
      label: "auto-create",
      platformAdminOwner: true,
    });
    const { probe } = await signInAsOperator(page, fixture);

    const ws = fixture.tenant.workspaceId;
    const ruleName = `P7 UI rule ${Date.now().toString(36)}`;

    const createForm = '[data-automation-rule-form="create"]';
    const createSubmit = () =>
      page.locator('[data-automation-form-submit="create"]');

    const open = async () => {
      await page.goto(`/operations/automation`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, AUTOMATION_ROUTE_ID);
      await waitForSurface(page, "[data-automation-ready]");
      const reveal = page.locator("[data-automation-new-rule]");
      // The control self-disables once the form is open, so it is only
      // pressed when the form is not already mounted.
      if ((await page.locator(createForm).count()) === 0) {
        await expect(reveal).toBeEnabled({ timeout: 30_000 });
        await reveal.click();
      }
      await waitForSurface(page, createForm);
      await expect(createSubmit()).toBeEnabled({ timeout: 30_000 });
    };

    const arm = async () => {
      const form = page.locator(createForm);
      await form.locator('[data-automation-field="name"]').fill(ruleName);
      await form
        .locator('[data-automation-field="triggerType"]')
        .selectOption(TRIGGER_TYPE);
      await form
        .locator('[data-automation-field="actionType"]')
        .selectOption(ACTION_TYPE);
      // The action-config fieldset is keyed on the selected action type and
      // re-renders when it changes, so the label field is filled after it.
      await form
        .locator(`[data-automation-action-config="${ACTION_TYPE}"]`)
        .locator('[data-automation-config-field="label"]')
        .fill("p7-ui-label");
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.automation.rule_created",
        pageUrl: "/operations/automation",
        control: '[data-automation-new-rule] → [data-automation-form-submit="create"]',
        method: "POST",
        apiPath: "POST /v1/automation/rules",
        pathFragment: "/v1/automation/rules",
        tenantWorkspaceId: ws,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(createSubmit(), keyboard);
        else await activateOnce(createSubmit(), keyboard);
      },
      submitControl: createSubmit,
      // The form UNMOUNTS on success (the page closes it in `afterSave`), so
      // the outcome is announced by the page's own live region. The FAILURE
      // path keeps the form mounted and reports inside it — asserting the
      // error against the page region would read the previous success text
      // and pass for the wrong reason.
      statusRegion: () => page.locator("[data-automation-page-status]"),
      errorStatusRegion: () =>
        page.locator(`${createForm} [data-automation-form-status]`),
      countHere: () => countRows("automation_rules", "team_id = $1", [ws]),
      countThere: () =>
        countRows("automation_rules", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Rule created/i,
      expectStatus: 201,
      expectRefreshed: async () => {
        await expect(
          page.locator("[data-automation-rules-table]"),
        ).toContainText(ruleName, { timeout: 20_000 });
        // A new rule must arrive DISARMED. An engine that starts firing the
        // moment a rule is saved is a different product.
        const rows = await sql<{ enabled: boolean }>(
          `SELECT enabled FROM automation_rules WHERE team_id = $1 AND name = $2`,
          [ws, ruleName],
        );
        expect(
          rows[0]?.enabled,
          "a newly authored rule must be created disabled",
        ).toBe(false);
      },
    });

    proven("p7.ui.automation.rule_created");

    // -----------------------------------------------------------------------
    // 18. PATCH /v1/automation/rules/:id — the amend leg
    //
    // `triggerType` and `actionType` are immutable on the server, which is
    // why the amendment under test is the NAME: it is the field the route
    // will actually accept, so a green result means the amend path works
    // rather than that a rejected field was silently ignored.
    // -----------------------------------------------------------------------
    const created = await sql<{ id: string }>(
      `SELECT id FROM automation_rules WHERE team_id = $1 AND name = $2`,
      [ws, ruleName],
    );
    const ruleId = created[0]?.id;
    expect(ruleId, "the authoring capability must have produced a rule").toBeTruthy();

    const amendedName = `${ruleName} (amended)`;
    const editForm = '[data-automation-rule-form="edit"]';
    const editSubmit = () => page.locator('[data-automation-form-submit="edit"]');

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.automation.rule_updated",
        pageUrl: "/operations/automation",
        control: `[data-automation-rule-edit="${ruleId}"] → [data-automation-form-submit="edit"]`,
        method: "PATCH",
        apiPath: "PATCH /v1/automation/rules/:id",
        pathFragment: `/v1/automation/rules/${ruleId}`,
        tenantWorkspaceId: ws,
      },
      open: async () => {
        await page.goto(`/operations/automation`, { waitUntil: "domcontentloaded" });
        await expectSurfaceRendered(page, AUTOMATION_ROUTE_ID);
        await waitForSurface(page, "[data-automation-ready]");
        const rowAction = page.locator(`[data-automation-rule-edit="${ruleId}"]`);
        await expect(rowAction).toBeEnabled({ timeout: 30_000 });
        await rowAction.click();
        await waitForSurface(page, editForm);
        await expect(editSubmit()).toBeEnabled({ timeout: 30_000 });
      },
      arm: async () => {
        await page
          .locator(editForm)
          .locator('[data-automation-field="name"]')
          .fill(amendedName);
      },
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(editSubmit(), keyboard);
        else await activateOnce(editSubmit(), keyboard);
      },
      submitControl: editSubmit,
      statusRegion: () => page.locator("[data-automation-page-status]"),
      errorStatusRegion: () =>
        page.locator(`${editForm} [data-automation-form-status]`),
      // The durable effect of an amendment is a CHANGED FIELD, not a new row
      // — counting rules that carry the amended name is how a change becomes
      // a count without loosening the "exactly one" invariant.
      countHere: () =>
        countRows("automation_rules", "team_id = $1 AND name = $2", [
          ws,
          amendedName,
        ]),
      countThere: () =>
        countRows("automation_rules", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Rule updated/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        await expect(
          page.locator("[data-automation-rules-table]"),
        ).toContainText(amendedName, { timeout: 20_000 });
        const rows = await sql<{ trigger_type: string; action_type: string }>(
          `SELECT trigger_type, action_type FROM automation_rules WHERE id = $1`,
          [ruleId],
        );
        expect(
          rows[0]?.trigger_type,
          "an amendment must never move the trigger — it is immutable server-side",
        ).toBe(TRIGGER_TYPE);
        expect(rows[0]?.action_type).toBe(ACTION_TYPE);
      },
    });

    proven("p7.ui.automation.rule_updated");
  });

  // =========================================================================
  // 19. POST /v1/automation/rules/:id/enable
  // =========================================================================

  test("p7.ui.automation.rule_enabled", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({
      label: "auto-enable",
      platformAdminOwner: true,
    });
    const { probe } = await signInAsOperator(page, fixture);
    const ws = fixture.tenant.workspaceId;

    const ids = [
      await seedAutomationRule(page, { teamId: ws, name: `P7 UI arm A ${Date.now()}` }),
      await seedAutomationRule(page, { teamId: ws, name: `P7 UI arm B ${Date.now()}` }),
    ];
    let target = ids[0]!;

    const open = async () => {
      const rows = await sql<{ id: string }>(
        `SELECT id FROM automation_rules
          WHERE id = ANY($1::uuid[]) AND enabled = false ORDER BY created_at ASC`,
        [ids],
      );
      expect(
        rows.length,
        "every seeded rule is already enabled — the fixture can no longer " +
          "offer the control under test",
      ).toBeGreaterThan(0);
      target = rows[0]!.id;

      await page.goto(`/operations/automation`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, AUTOMATION_ROUTE_ID);
      await waitForSurface(page, "[data-automation-ready]");
      await expect(
        page.locator(
          `[data-automation-rule-toggle="enable"][data-automation-rule-toggle-for="${target}"]`,
        ),
        "a disabled rule must offer exactly one leg, and it must be Enable",
      ).toBeEnabled({ timeout: 30_000 });
    };

    const submit = () =>
      page.locator(
        `[data-automation-rule-toggle="enable"][data-automation-rule-toggle-for="${target}"]`,
      );

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.automation.rule_enabled",
        pageUrl: "/operations/automation",
        control: '[data-automation-rule-toggle="enable"][data-automation-rule-toggle-for="{id}"]',
        method: "POST",
        apiPath: "POST /v1/automation/rules/:id/enable",
        pathFragment: "/enable",
        tenantWorkspaceId: ws,
      },
      open,
      // The toggle fires inline: there is no form to fill and no confirmation
      // step. The control IS the mutation.
      arm: async () => {},
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      statusRegion: () =>
        page.locator(`[data-automation-rule-id="${target}"] [data-automation-toggle-status]`),
      countHere: () =>
        countRows("automation_rules", "id = ANY($1::uuid[]) AND enabled = true", [ids]),
      countThere: () =>
        countRows("automation_rules", "team_id = $1 AND enabled = true", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Rule enabled/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        await expect(
          page.locator(`[data-automation-rule-id="${target}"]`),
          "the row must re-read and report itself armed",
        ).toHaveAttribute("data-automation-rule-enabled", "true", {
          timeout: 20_000,
        });
      },
    });

    proven("p7.ui.automation.rule_enabled");
  });

  // =========================================================================
  // 20. POST /v1/automation/rules/:id/disable
  // =========================================================================

  test("p7.ui.automation.rule_disabled", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({
      label: "auto-disable",
      platformAdminOwner: true,
    });
    const { probe } = await signInAsOperator(page, fixture);
    const ws = fixture.tenant.workspaceId;

    const ids = [
      await seedAutomationRule(page, { teamId: ws, name: `P7 UI dis A ${Date.now()}` }),
      await seedAutomationRule(page, { teamId: ws, name: `P7 UI dis B ${Date.now()}` }),
    ];
    // The ARMED state is the precondition, not the capability — arming is
    // capability nineteen and is driven through the browser there. Both rules
    // are armed through the real route so the disarm leg can be proven on its
    // own terms rather than as the tail of another journey.
    for (const id of ids) {
      const res = await directApiCall(page, {
        method: "POST",
        path: `/v1/automation/rules/${id}/enable`,
      });
      expect(res.status, `arming the subject rule failed: ${res.body}`).toBe(200);
    }

    let target = ids[0]!;

    const open = async () => {
      const rows = await sql<{ id: string }>(
        `SELECT id FROM automation_rules
          WHERE id = ANY($1::uuid[]) AND enabled = true ORDER BY created_at ASC`,
        [ids],
      );
      expect(
        rows.length,
        "every seeded rule is already disabled — the fixture can no longer " +
          "offer the control under test",
      ).toBeGreaterThan(0);
      target = rows[0]!.id;

      await page.goto(`/operations/automation`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, AUTOMATION_ROUTE_ID);
      await waitForSurface(page, "[data-automation-ready]");
      await expect(
        page.locator(
          `[data-automation-rule-toggle="disable"][data-automation-rule-toggle-for="${target}"]`,
        ),
      ).toBeEnabled({ timeout: 30_000 });
    };

    const submit = () =>
      page.locator(
        `[data-automation-rule-toggle="disable"][data-automation-rule-toggle-for="${target}"]`,
      );

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.automation.rule_disabled",
        pageUrl: "/operations/automation",
        control: '[data-automation-rule-toggle="disable"][data-automation-rule-toggle-for="{id}"]',
        method: "POST",
        apiPath: "POST /v1/automation/rules/:id/disable",
        pathFragment: "/disable",
        tenantWorkspaceId: ws,
      },
      open,
      arm: async () => {},
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      statusRegion: () =>
        page.locator(`[data-automation-rule-id="${target}"] [data-automation-toggle-status]`),
      countHere: () =>
        countRows("automation_rules", "id = ANY($1::uuid[]) AND enabled = false", [ids]),
      countThere: () =>
        countRows("automation_rules", "team_id = $1 AND enabled = false", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Rule disabled/i,
      expectStatus: 200,
      expectRefreshed: async () => {
        await expect(
          page.locator(`[data-automation-rule-id="${target}"]`),
        ).toHaveAttribute("data-automation-rule-enabled", "false", {
          timeout: 20_000,
        });
        const rows = await sql<{ disabled_at: string | null }>(
          `SELECT disabled_at FROM automation_rules WHERE id = $1`,
          [target],
        );
        expect(
          rows[0]?.disabled_at,
          "disarming must stamp the instant it happened, not merely flip a flag",
        ).toBeTruthy();
      },
    });

    proven("p7.ui.automation.rule_disabled");

    // The SERVER refuses a caller without AUTOMATION_MANAGE on the workspace,
    // from inside that caller's own authenticated page. The member is not a
    // platform admin either, so the page would never have rendered — which is
    // exactly why the claim is made about the request, not about the button.
    await page.context().clearCookies();
    await login(page, fixture.member);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.automation.rule_disabled",
      pageUrl: "/operations/automation",
      control: '[data-automation-rule-toggle="disable"]',
      method: "POST",
      apiPath: "POST /v1/automation/rules/:id/disable",
      requestPath: `/v1/automation/rules/${ids[1]}/disable`,
      tenantWorkspaceId: ws,
      countRowsNow: () =>
        countRows("automation_rules", "id = $1 AND enabled = false", [ids[1]!]),
    });
  });

  // =========================================================================
  // 21. POST /v1/intelligence/providers/budgets — ProviderBudgetPanel
  //
  // Deliberately an ordinary enterprise workspace owner, NOT the platform
  // admin used above: `/intelligence` is an ENTERPRISE_ONLY route, and
  // `resolveRouteAccess` lets a platform admin past that gate. Using one here
  // would have made a broken enterprise projection invisible.
  // =========================================================================

  test("p7.ui.intelligence.provider_budget_created", async ({ page }) => {
    const fixture = await buildEnterpriseFixture({ label: "intel-budget" });
    const { probe } = await signInAsOperator(page, fixture);
    const ws = fixture.tenant.workspaceId;

    const submit = () => page.locator("[data-intelligence-budget-submit]");

    const open = async () => {
      await page.goto(`/intelligence`, { waitUntil: "domcontentloaded" });
      await expectSurfaceRendered(page, INTELLIGENCE_ROUTE_ID);
      await waitForSurface(page, "[data-intelligence-budget-form]");
      // Blocked until the panel has resolved the active workspace and the
      // BILLING_MANAGE capability; waiting for ENABLED rather than for a
      // timeout is what makes "it was enabled for an authorized caller" mean
      // something.
      await expect(submit()).toBeEnabled({ timeout: 30_000 });
    };

    const arm = async () => {
      // WORKSPACE scope needs neither a provider nor a scope target, so it
      // isolates the budget write itself rather than a scope resolver.
      await page.locator("[data-intelligence-budget-scope]").selectOption("WORKSPACE");
      await page.locator("[data-intelligence-budget-period]").selectOption("MONTHLY");
      await page.locator("[data-intelligence-budget-soft-limit]").fill("100");
      await page.locator("[data-intelligence-budget-hard-limit]").fill("250");
    };

    await proveMutationCapability({
      page,
      probe,
      descriptor: {
        capabilityId: "p7.ui.intelligence.provider_budget_created",
        pageUrl: "/intelligence",
        control: "[data-intelligence-budget-submit] — “Create budget”",
        method: "POST",
        apiPath: "POST /v1/intelligence/providers/budgets",
        pathFragment: "/v1/intelligence/providers/budgets",
        tenantWorkspaceId: ws,
      },
      open,
      arm,
      fire: async ({ double, keyboard }) => {
        if (double) await activateTwice(submit(), keyboard);
        else await activateOnce(submit(), keyboard);
      },
      submitControl: submit,
      statusRegion: () => page.locator("[data-intelligence-budget-status]"),
      // The request body carries NO teamId — the route derives the workspace
      // from `users.current_workspace_id`. So this count is the only place
      // the tenant binding can be checked, and it is the whole point of the
      // cross-tenant assertion beside it.
      countHere: () => countRows("provider_budgets", "team_id = $1", [ws]),
      countThere: () =>
        countRows("provider_budgets", "team_id = $1", [
          fixture.otherTenant.workspaceId,
        ]),
      successCopy: /Budget created/i,
      expectStatus: 201,
      expectRefreshed: async () => {
        await expect
          .poll(
            async () => page.locator("[data-intelligence-budget-row]").count(),
            {
              message: "the budgets table must re-read and show the new budget",
              timeout: 20_000,
            },
          )
          .toBeGreaterThan(0);
        const rows = await sql<{ soft_limit_usd_micros: string; hard_limit_usd_micros: string }>(
          `SELECT soft_limit_usd_micros::text, hard_limit_usd_micros::text
             FROM provider_budgets WHERE team_id = $1`,
          [ws],
        );
        // The form takes dollars and the column stores micros; a budget that
        // silently stored 100 instead of 100_000_000 would enforce a limit a
        // millionth of the one the operator typed.
        expect(
          rows[0]?.soft_limit_usd_micros,
          "the soft limit must be persisted in micro-dollars",
        ).toBe("100000000");
        expect(rows[0]?.hard_limit_usd_micros).toBe("250000000");
      },
    });

    proven("p7.ui.intelligence.provider_budget_created");

    // `intelligence.policy.manage` is an OWNER/ADMIN permission; a MEMBER is
    // refused by the SERVER even though their session resolves the same
    // workspace.
    await page.context().clearCookies();
    await login(page, fixture.member);
    await proveServerRefusal({
      page,
      capabilityId: "p7.ui.intelligence.provider_budget_created",
      pageUrl: "/intelligence",
      control: "[data-intelligence-budget-submit]",
      method: "POST",
      apiPath: "POST /v1/intelligence/providers/budgets",
      requestPath: "/v1/intelligence/providers/budgets",
      body: {
        scope: "WORKSPACE",
        period: "MONTHLY",
        softLimitUsdMicros: 1_000_000,
        hardLimitUsdMicros: 2_000_000,
      },
      tenantWorkspaceId: ws,
      countRowsNow: () => countRows("provider_budgets", "team_id = $1", [ws]),
    });
  });
});
