/**
 * Operations Center / Notification Preferences — UX-adaptation
 * contracts (final completion pass, 2026-07-14).
 *
 * Primarily RUNTIME BEHAVIOR tests: the adaptation rules live in pure,
 * imported functions (deriveOperationsUiContext + the filter/action
 * policy), so we execute them rather than grepping source. A small
 * source-contract section pins the copy/wiring that has no executable
 * form (labels, CTA placement, hybrid tile consumption).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveOperationsUiContext } from "../lib/notifications/useOperationsUiContext";
import {
  PRIMARY_OPERATIONS_FILTERS,
  SECONDARY_OPERATIONS_FILTERS,
  shouldOfferMarkAllRead,
  shouldOfferMarkCategoryRead,
  toneTileDisabled,
  visiblePrimaryFilters,
  visibleSecondaryFilters,
} from "../lib/notifications/operationsFilterPolicy";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// Runtime — UI-context derivation (no hardcoded capabilities)
// ---------------------------------------------------------------------------

const PERSONAL_FREE = {
  activeSpaceType: "PERSONAL" as const,
  activeSpaceId: "p-1",
  personalSpaceId: "p-1",
  organizations: [],
  hasGovernanceCapability: false,
};
const PERSONAL_PRO = { ...PERSONAL_FREE, hasGovernanceCapability: true };
const ORG_MEMBER = {
  activeSpaceType: "ORGANIZATION" as const,
  activeSpaceId: "o-1",
  personalSpaceId: "p-1",
  organizations: [
    { membershipStatus: "ACTIVE" as const, role: "MEMBER" as const },
  ],
  hasGovernanceCapability: false,
};
const ORG_ADMIN = {
  ...ORG_MEMBER,
  organizations: [
    { membershipStatus: "ACTIVE" as const, role: "ADMIN" as const },
  ],
};

test("admin attention derives only from OWNER/ADMIN org memberships", () => {
  assert.equal(deriveOperationsUiContext(PERSONAL_PRO).canViewAdminAttention, false);
  assert.equal(deriveOperationsUiContext(ORG_MEMBER).canViewAdminAttention, false);
  assert.equal(deriveOperationsUiContext(ORG_ADMIN).canViewAdminAttention, true);
  // PENDING/INACTIVE memberships never grant it.
  assert.equal(
    deriveOperationsUiContext({
      ...ORG_MEMBER,
      organizations: [{ membershipStatus: "PENDING", role: "ADMIN" }],
    }).canViewAdminAttention,
    false,
  );
});

test("governance relevance: all org members; Personal only with the governance capability", () => {
  assert.equal(deriveOperationsUiContext(ORG_MEMBER).canReceiveGovernance, true);
  assert.equal(deriveOperationsUiContext(PERSONAL_PRO).canReceiveGovernance, true);
  assert.equal(deriveOperationsUiContext(PERSONAL_FREE).canReceiveGovernance, false);
});

test("Option A contract: no per-surface predicates exist for workspace workflows (collaboration/reviews are always offered)", () => {
  // The canonical visibility model gates ONLY never-receivable classes
  // (admin, governance). Collaboration/reviews/mentions/intake have NO
  // resolver flag — their absence IS the rule; a reappearing predicate
  // would reintroduce the rejected participation model.
  const out = deriveOperationsUiContext(ORG_MEMBER) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(out).sort(),
    [
      "canReceiveGovernance",
      "canViewAdminAttention",
      "hasOrganizations",
      "isPersonalWorkspace",
      "workspaceId",
    ],
  );
});

test("hasOrganizations counts ACTIVE org memberships only", () => {
  assert.equal(deriveOperationsUiContext(PERSONAL_FREE).hasOrganizations, false);
  assert.equal(deriveOperationsUiContext(ORG_MEMBER).hasOrganizations, true);
});

// ---------------------------------------------------------------------------
// Runtime — filter grouping policy
// ---------------------------------------------------------------------------

test("every filter is exactly primary or secondary — nothing lost, nothing duplicated", () => {
  const all = [...PRIMARY_OPERATIONS_FILTERS, ...SECONDARY_OPERATIONS_FILTERS];
  assert.equal(all.length, 20);
  assert.equal(new Set(all).size, 20);
});

test("admin chip renders only for admin attention; governance only when receivable", () => {
  const member = deriveOperationsUiContext(ORG_MEMBER);
  const admin = deriveOperationsUiContext(ORG_ADMIN);
  const personalFree = deriveOperationsUiContext(PERSONAL_FREE);
  assert.ok(!visibleSecondaryFilters(member, "all").includes("admin"));
  assert.ok(visibleSecondaryFilters(admin, "all").includes("admin"));
  assert.ok(!visibleSecondaryFilters(personalFree, "all").includes("governance"));
  assert.ok(visibleSecondaryFilters(member, "all").includes("governance"));
});

test("the active secondary filter is promoted into the primary row (state never hidden)", () => {
  const ctx = deriveOperationsUiContext(ORG_MEMBER);
  assert.ok(visiblePrimaryFilters(ctx, "mentions").includes("mentions"));
  assert.ok(!visibleSecondaryFilters(ctx, "mentions").includes("mentions"));
  // And a normal primary selection does not duplicate.
  const primary = visiblePrimaryFilters(ctx, "all");
  assert.equal(new Set(primary).size, primary.length);
});

// ---------------------------------------------------------------------------
// Runtime — bulk actions + tile states reflect reality
// ---------------------------------------------------------------------------

test("bulk read actions never render with zero unread; category variant needs filtered rows too", () => {
  assert.equal(shouldOfferMarkAllRead(0), false);
  assert.equal(shouldOfferMarkAllRead(3), true);
  assert.equal(shouldOfferMarkCategoryRead(3, 0, true), false);
  assert.equal(shouldOfferMarkCategoryRead(3, 2, true), true);
  assert.equal(shouldOfferMarkCategoryRead(3, 2, false), false);
  assert.equal(shouldOfferMarkCategoryRead(0, 2, true), false);
});

test("zero-count severity tiles are disabled unless they are the active toggle", () => {
  assert.equal(toneTileDisabled(0, false), true);
  assert.equal(toneTileDisabled(0, true), false);
  assert.equal(toneTileDisabled(5, false), false);
});

// ---------------------------------------------------------------------------
// Source contracts — copy + wiring with no executable form
// ---------------------------------------------------------------------------

const PAGE = read("app/(app)/inbox/page.tsx");
const PANEL = read("components/notifications/NotificationPreferencesPanel.tsx");
const BELL = read("components/app-shell-v2/NotificationBell.tsx");

test("severity tiles + empty-state decisions read the workspace scopeSummary", () => {
  assert.match(PAGE, /scopeSummary\?\.byTone\[tone\]/);
  assert.match(
    PAGE,
    /\(state\.data\.scopeSummary\?\.total \?\? state\.data\.summary\.total\) === 0/,
  );
});

test("chips render from the pure policy with a More-filters disclosure", () => {
  assert.match(PAGE, /visiblePrimaryFilters\(uiCtx, filter\)/);
  assert.match(PAGE, /visibleSecondaryFilters\(uiCtx, filter\)/);
  assert.match(PAGE, /aria-controls="inbox-secondary-filters"/);
  assert.match(PAGE, /aria-pressed=\{active\}/);
});

test("Organizations CTA only for users with organizations; personal-only users get evidence remediation", () => {
  assert.match(PAGE, /uiCtx\.hasOrganizations \? \(/);
  assert.match(PAGE, /data-action="empty-open-evidence"/);
});

test("SLA row stays semantically honest; governance group keys off canReceiveGovernance", () => {
  assert.match(PANEL, /SLA_NEAR_BREACH: "Evidence integrity & verification failures"/);
  assert.doesNotMatch(PANEL, /SLA timers approaching breach/);
  assert.match(PANEL, /requiresGovernance && !uiCtx\.canReceiveGovernance/);
});

test("bell popover manages focus (trap + restore to trigger)", () => {
  assert.match(BELL, /triggerRef\.current\?\.focus\(\)/);
  assert.match(BELL, /onTrapKeyDown/);
});

test("terminology: Operations Center, not Operational inbox", () => {
  assert.match(PAGE, /eyebrow="Account · Operations Center"/);
  assert.doesNotMatch(PAGE, /Operational inbox"/);
});
