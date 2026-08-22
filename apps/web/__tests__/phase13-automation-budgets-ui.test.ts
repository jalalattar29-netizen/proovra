/**
 * PHASE 13 §UI — five registered API routes that had NO product surface.
 *
 *   POST  /v1/automation/rules              automation.routes.ts:243
 *   PATCH /v1/automation/rules/:id          automation.routes.ts:305
 *   POST  /v1/automation/rules/:id/enable   automation.routes.ts:412
 *   POST  /v1/automation/rules/:id/disable  automation.routes.ts:418
 *   POST  /v1/intelligence/providers/budgets
 *                                           intelligence-platform.routes.ts:634
 *
 * The automation page listed rules and runs and then said, in its own copy,
 * that the lifecycle was available "via API (form UI lands in E3.1)" — so the
 * empty state was a dead end and no rule could ever be turned on. The provider
 * budget POST had the same shape of hole: /budget-center and the budgets table
 * rendered spend and breaches read-only, and nothing in the product could
 * author the limit that produces them.
 *
 * These are SOURCE-SHAPE assertions, matching the convention of
 * phase13-disconnected-ui-actions.test.ts: what regressed (and what would
 * regress again) is which request leaves, from which control, with which
 * states around it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(WEB_ROOT, rel), "utf8");

const PAGE = "app/(app)/admin/platform/automation/page.tsx";
const FORM = "components/automation/AutomationRuleForm.tsx";
const TOGGLE = "components/automation/AutomationRuleToggle.tsx";
const BUDGET = "components/intelligence/ProviderBudgetPanel.tsx";

/** No bare `fetch(` anywhere — the API is a DIFFERENT origin (AUDIT-002). */
function assertNoBareFetch(src: string, label: string): void {
  assert.equal(
    /(?<![A-Za-z])fetch\(/.test(src),
    false,
    `${label} issues a bare fetch() — a relative call resolves against the WEB origin and 404s`,
  );
  assert.ok(
    src.includes('from "../../lib/api"') ||
      src.includes('from "../../../../lib/api"'),
    `${label} does not import the canonical apiFetch client`,
  );
}

// ---------------------------------------------------------------------------
// POST /v1/automation/rules — create
// ---------------------------------------------------------------------------

test("POST /v1/automation/rules is called from a real create form", () => {
  const src = read(FORM);
  assertNoBareFetch(src, "AutomationRuleForm");

  // Exact path + method.
  assert.ok(
    src.includes('await apiFetch("/v1/automation/rules", {'),
    "the create call does not address /v1/automation/rules via apiFetch",
  );
  const createCall = src.slice(
    src.indexOf('await apiFetch("/v1/automation/rules", {'),
  );
  assert.ok(
    createCall.slice(0, 200).includes('method: "POST"'),
    "the create call is not a POST",
  );

  // Every required body field of CreateAutomationRuleInput is sent.
  for (const field of [
    "teamId,",
    "name: trimmedName,",
    "triggerType,",
    "actionType,",
    "actionConfigJson,",
    "conditionJson,",
  ]) {
    assert.ok(
      createCall.slice(0, 700).includes(field),
      `the create body omits ${field}`,
    );
  }

  // Workspace context comes from the page's own authority, not a new source.
  const page = read(PAGE);
  assert.ok(
    page.includes("useActiveSpaceId()") && page.includes("teamId={teamId}"),
    "the create form is not given the page's active workspace id",
  );

  // Client-side validation of the required fields BEFORE the request.
  assert.ok(
    src.includes('nextErrors.name = "Rule name is required."'),
    "the required rule name is not validated client-side",
  );
  assert.ok(
    src.includes('nextErrors.triggerType = "Choose a trigger."') &&
      src.includes('nextErrors.actionType = "Choose an action."'),
    "the required trigger/action are not validated client-side",
  );
  assert.ok(
    src.includes("buildActionConfig(actionType, configValues)"),
    "the per-action-type config is not validated against the server's schema shape",
  );
  assert.ok(
    src.includes("if (Object.keys(nextErrors).length > 0) {"),
    "an invalid form is still allowed to issue the request",
  );

  // …AND the server's 400 is handled distinctly from a server error.
  assert.ok(
    /if \(code === 400\) \{/.test(src),
    "the server's 400 (invalid body / action config / condition) is not handled",
  );

  // Trigger + action allowlists come from the server envelope, never hardcoded.
  assert.ok(
    src.includes("triggerTypes.map(") && src.includes("actionTypes.map("),
    "the bounded allowlists are not rendered from the server envelope",
  );
});

// ---------------------------------------------------------------------------
// PATCH /v1/automation/rules/:id — edit
// ---------------------------------------------------------------------------

test("PATCH /v1/automation/rules/:id is called from the edit form, without the immutable fields", () => {
  const src = read(FORM);

  assert.ok(
    src.includes("`/v1/automation/rules/${encodeURIComponent(rule.id)}`"),
    "the edit call does not address the parameterised rule path",
  );
  const patchAt = src.indexOf(
    "`/v1/automation/rules/${encodeURIComponent(rule.id)}`",
  );
  assert.ok(patchAt > -1);
  assert.ok(
    src.slice(patchAt, patchAt + 200).includes('method: "PATCH"'),
    "the edit call is not a PATCH",
  );

  // UpdateAutomationRuleInput accepts name/description/conditionJson/
  // actionConfigJson ONLY — triggerType and actionType are immutable, so the
  // edit form must render them read-only and never send them.
  const patchBody = src.slice(
    src.indexOf("const body: Record<string, unknown> = {"),
    patchAt,
  );
  assert.ok(patchBody.includes("name: trimmedName,"), "PATCH body lost the name");
  assert.ok(
    patchBody.includes("actionConfigJson,"),
    "PATCH body lost the action config",
  );
  assert.equal(
    /triggerType[,:]/.test(patchBody),
    false,
    "the PATCH body sends triggerType, which the server ignores — the form must not pretend it is editable",
  );
  assert.ok(
    src.includes("disabled={disabled || isEdit}"),
    "the trigger/action selects are still editable in edit mode",
  );
  assert.ok(
    src.includes("Immutable after creation"),
    "nothing tells the user why the trigger/action cannot be changed",
  );

  // The page opens the edit form against a REAL rule from the loaded list.
  const page = read(PAGE);
  assert.ok(
    page.includes('setFormMode({ kind: "edit", ruleId: r.id })') &&
      page.includes("data-automation-rule-edit={r.id}"),
    "there is no per-rule Edit control bound to a real rule id",
  );
  assert.ok(
    page.includes('mode="edit"') && page.includes("rule={editingRule}"),
    "the edit form is not given the rule it edits",
  );
});

// ---------------------------------------------------------------------------
// POST /v1/automation/rules/:id/{enable,disable} — ONE control
// ---------------------------------------------------------------------------

test("enable/disable is one control whose leg follows the rule's current state", () => {
  const src = read(TOGGLE);
  assertNoBareFetch(src, "AutomationRuleToggle");

  assert.ok(
    src.includes('const leg = rule.enabled ? "disable" : "enable";'),
    "the leg is not derived from the rule's CURRENT state",
  );
  assert.ok(
    src.includes(
      "`/v1/automation/rules/${encodeURIComponent(rule.id)}/${leg}`",
    ),
    "neither enable nor disable is addressed by its exact path",
  );
  const callAt = src.indexOf(
    "`/v1/automation/rules/${encodeURIComponent(rule.id)}/${leg}`",
  );
  assert.ok(
    src.slice(callAt, callAt + 120).includes('method: "POST"'),
    "the transition is not a POST",
  );

  // ONE button — not two always-enabled buttons.
  const buttons = src.match(/<button\b/g) ?? [];
  assert.equal(
    buttons.length,
    1,
    "the toggle renders more than one button — enable and disable must be one control",
  );
  assert.ok(
    src.includes('{busy ? "Working…" : label}') &&
      src.includes('const label = rule.enabled ? "Disable" : "Enable";'),
    "the control's label does not reflect the rule's current state",
  );
});

// ---------------------------------------------------------------------------
// POST /v1/intelligence/providers/budgets
// ---------------------------------------------------------------------------

test("POST /v1/intelligence/providers/budgets is called from a real budget form", () => {
  const src = read(BUDGET);
  assertNoBareFetch(src, "ProviderBudgetPanel");

  assert.ok(
    src.includes('await apiFetch("/v1/intelligence/providers/budgets", {'),
    "the budget create call does not address the exact path via apiFetch",
  );
  // The panel addresses this path TWICE: the read (GET, line ~72) and the new
  // write. Take the LAST occurrence so the write is what is being asserted.
  const call = src.slice(
    src.lastIndexOf('await apiFetch("/v1/intelligence/providers/budgets", {'),
  );
  assert.ok(
    call.slice(0, 200).includes('method: "POST"'),
    "the budget create call is not a POST",
  );

  // Exactly the BudgetCreateBody fields, no invented teamId (the route derives
  // the workspace from the caller's current workspace).
  const body = call.slice(0, 500);
  for (const field of [
    "scope,",
    "scopeTargetId:",
    "provider:",
    "period,",
    "softLimitUsdMicros: soft,",
    "hardLimitUsdMicros: hard,",
  ]) {
    assert.ok(body.includes(field), `the budget body omits ${field}`);
  }
  assert.equal(
    /teamId/.test(body),
    false,
    "the budget body invents a teamId the route does not accept",
  );

  // Enums come from the shared package — not retyped in the component.
  assert.ok(
    src.includes("PROVIDER_BUDGET_SCOPES.map(") &&
      src.includes("PROVIDER_BUDGET_PERIODS.map(") &&
      src.includes("MEDIA_INTELLIGENCE_PROVIDERS.map("),
    "the budget selects do not render the canonical shared enums",
  );

  // Client-side validation mirrors createBudget's own rejection rules.
  assert.ok(src.includes("function usdToMicros("), "no USD → micros conversion");
  assert.ok(
    src.includes("next.softLimitUsd =") && src.includes("next.hardLimitUsd ="),
    "the required limits are not validated client-side",
  );
  assert.ok(
    src.includes("soft > hard"),
    "the soft<=hard rule the server rejects with 409 is not checked client-side",
  );
  assert.ok(
    src.includes("next.scopeTargetId =") && src.includes("next.provider ="),
    "the scope-dependent required fields are not validated client-side",
  );
  assert.ok(
    /if \(code === 409\) \{/.test(src),
    "the server's 409 policy denial is not handled",
  );

  // Workspace context: the panel reads the canonical platform context, and the
  // control fails closed without a resolved workspace.
  assert.ok(
    src.includes('from "../../lib/platform-context"') &&
      src.includes("activeWorkspaceId"),
    "the budget form does not read the canonical workspace context",
  );
  assert.ok(
    src.includes("!canManage || !activeWorkspaceId"),
    "the submit control is not disabled without permission or workspace",
  );

  // Success refreshes the budgets list.
  assert.ok(
    src.includes("<ProviderBudgetCreateForm onCreated={refresh} />") &&
      src.includes("await onCreated();"),
    "a created budget does not refetch the budgets list",
  );
  // Empty state for the list the form feeds.
  assert.ok(
    src.includes("data-intelligence-budgets-empty"),
    "the budgets list has no addressable empty state",
  );
});

// ---------------------------------------------------------------------------
// Shared obligations — every control added must carry all of these
// ---------------------------------------------------------------------------

for (const [label, rel] of [
  ["AutomationRuleForm", FORM],
  ["AutomationRuleToggle", TOGGLE],
  ["ProviderBudgetPanel", BUDGET],
] as const) {
  test(`${label}: loading, permission, error, success and a11y states are all present`, () => {
    const src = read(rel);

    // Loading / in-flight.
    assert.ok(
      src.includes("aria-busy={busy}"),
      `${label} does not expose an aria-busy in-flight state`,
    );
    assert.ok(
      src.includes("disabled={disabled}"),
      `${label} does not disable its control while the action is unavailable or in flight`,
    );

    // Permission denied — both the pre-emptive disable and the server's 403.
    assert.ok(
      /if \(code === 403\) \{/.test(src),
      `${label} does not handle a 403 from the server`,
    );
    assert.ok(
      src.includes("canManage"),
      `${label} does not gate its control on a capability`,
    );

    // Server error with BOUNDED copy — never a raw error body.
    assert.ok(
      src.includes("toSafeUserError("),
      `${label} does not route unexpected failures through the sanctioned safe-error path`,
    );
    assert.equal(
      /\{\s*(err|error)\.message\s*\}/.test(src),
      false,
      `${label} renders a raw error message into the DOM`,
    );

    // Stale-response protection.
    assert.ok(
      src.includes("mounted.current") && src.includes("seq.current"),
      `${label} has no stale/unmounted response guard`,
    );

    // Screen-reader status.
    assert.ok(
      src.includes('role="status"') && src.includes('aria-live="polite"'),
      `${label} has no screen-reader status region`,
    );

    // Real, keyboard-reachable controls with labelled fields.
    assert.ok(src.includes("<button"), `${label} has no real <button>`);
    assert.equal(
      /onClick=\{[^}]*\}\s*>\s*<(div|span)/.test(src),
      false,
      `${label} appears to hang a click handler off a non-interactive element`,
    );
    if (rel !== TOGGLE) {
      assert.ok(
        src.includes("htmlFor="),
        `${label} has form fields with no <label htmlFor>`,
      );
    }

    // No secrets rendered.
    assert.equal(
      /(token|secret|apiKey|signingKey)\s*\}/i.test(src),
      false,
      `${label} looks like it renders a credential into the DOM`,
    );
  });
}

// ---------------------------------------------------------------------------
// The automation page itself: the surface the four routes hang off
// ---------------------------------------------------------------------------

test("the automation page offers the lifecycle, refetches after it, and no longer defers the form", () => {
  const src = read(PAGE);

  // The deferral copy is gone — it was the admission that the routes were
  // unreachable from the product.
  assert.equal(
    src.includes("form UI lands in E3.1"),
    false,
    "the page still tells the user the lifecycle is API-only",
  );

  // Create is reachable from BOTH the header and the empty state.
  assert.ok(
    src.includes("data-automation-new-rule"),
    "no New rule control in the rules section header",
  );
  assert.ok(
    src.includes("data-automation-empty-create"),
    "the empty state still cannot be escaped from the product",
  );
  assert.ok(
    src.includes("data-automation-empty"),
    "the rules list lost its empty state",
  );

  // Every lifecycle control is disabled without AUTOMATION_MANAGE.
  assert.ok(
    src.includes('ctx.can("AUTOMATION_MANAGE")'),
    "the page no longer reads the manage capability",
  );
  const disabledOnCapability = src.match(/disabled=\{!canManage/g) ?? [];
  assert.ok(
    disabledOnCapability.length >= 3,
    "not every lifecycle control is disabled without the manage capability",
  );

  // Success refetches the list from the server (no local patching).
  assert.ok(
    src.includes("const [reloadToken, setReloadToken] = useState(0)") &&
      src.includes("}, [teamId, reloadToken]);"),
    "a successful mutation does not re-run the rules/runs load",
  );
  assert.ok(
    src.includes("reload();"),
    "the mutation handlers do not trigger the refetch",
  );

  // Page-level screen-reader status for the form that closes on success.
  assert.ok(
    src.includes("data-automation-page-status") &&
      src.includes('aria-live="polite"'),
    "the page has no live region for a control that unmounts on success",
  );

  // The controls are mounted, not stubbed.
  assert.ok(
    src.includes("<AutomationRuleToggle") && src.includes("<AutomationRuleForm"),
    "the lifecycle controls are not mounted on the page",
  );
});
