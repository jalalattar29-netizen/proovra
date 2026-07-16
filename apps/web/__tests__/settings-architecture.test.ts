/**
 * Settings IA remediation contracts (2026-07-16).
 *
 * RUNTIME tests execute the canonical settings UI-context resolver across
 * the full persona/plan/role matrix (personal Free/PAYG/Pro, Team org
 * member/admin, Enterprise reviewer/admin/owner). Source contracts pin the
 * wiring that has no executable form (compact overview, MFA flow wiring,
 * light design tokens, route registration).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveSettingsUiContext,
  type SettingsUiContextInput,
} from "../lib/settings/settingsUiContext";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// Persona fixtures
// ---------------------------------------------------------------------------

function personal(plan: string): SettingsUiContextInput {
  return {
    activeSpace: { type: "PERSONAL", id: "p-1", displayName: "Personal Space" },
    workspacePlan: plan,
    accountPlan: plan,
    organizations: [],
    planFeatures: { reviewerOperationsIncluded: false },
  };
}

function orgMember(
  plan: string,
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER",
  opts: { reviewer?: boolean } = {},
): SettingsUiContextInput {
  return {
    activeSpace: { type: "ORGANIZATION", id: "o-1", displayName: "Acme Legal" },
    workspacePlan: plan,
    accountPlan: "FREE", // personal entitlement stays FREE — the org plan must win
    organizations: [
      {
        id: "o-1",
        name: "Acme Legal",
        membershipStatus: "ACTIVE",
        role,
        plan,
      },
    ],
    planFeatures: { reviewerOperationsIncluded: opts.reviewer ?? true },
  };
}

// ---------------------------------------------------------------------------
// RUNTIME — universal account sections are never gated
// ---------------------------------------------------------------------------

test("profile/security/preferences/privacy are universal in every context", () => {
  const contexts = [
    personal("FREE"),
    personal("PAYG"),
    personal("PRO"),
    orgMember("TEAM", "MEMBER"),
    orgMember("TEAM", "ADMIN"),
    orgMember("ENTERPRISE", "MEMBER"),
    orgMember("ENTERPRISE", "ADMIN"),
    orgMember("ENTERPRISE", "OWNER"),
  ];
  for (const c of contexts) {
    const ui = deriveSettingsUiContext(c);
    assert.equal(ui.showProfile, true);
    assert.equal(ui.showSecurity, true);
    assert.equal(ui.showPreferences, true);
    assert.equal(ui.showPrivacy, true);
    assert.equal(ui.showNotifications, true);
  }
});

// ---------------------------------------------------------------------------
// RUNTIME — billing context matrix (§11)
// ---------------------------------------------------------------------------

test("personal Free/PAYG/Pro users see a clearly-labeled personal plan", () => {
  for (const plan of ["FREE", "PAYG", "PRO"]) {
    const ui = deriveSettingsUiContext(personal(plan));
    assert.equal(ui.billing.contextType, "personal");
    assert.equal(ui.billing.displayPlan, plan);
    assert.equal(ui.billing.scopeLabel, "Personal plan");
    assert.equal(ui.billing.canManageBilling, true);
    assert.equal(ui.billing.billingHref, "/billing");
  }
});

test("a TEAM org MEMBER sees the ORG plan as managed — never their personal FREE", () => {
  const ui = deriveSettingsUiContext(orgMember("TEAM", "MEMBER"));
  assert.equal(ui.billing.contextType, "organization");
  assert.equal(ui.billing.displayPlan, "TEAM", "org plan, not personal FREE");
  assert.equal(ui.billing.canManageBilling, false);
  assert.equal(ui.billing.billingHref, null, "no billing action for members");
  assert.equal(ui.billing.managedByOrgName, "Acme Legal");
});

test("a TEAM org ADMIN gets the billing action for the organization", () => {
  const ui = deriveSettingsUiContext(orgMember("TEAM", "ADMIN"));
  assert.equal(ui.billing.canManageBilling, true);
  assert.equal(ui.billing.billingHref, "/billing");
});

test("ENTERPRISE reads as a managed contract with NO self-service upgrade CTA", () => {
  for (const role of ["MEMBER", "ADMIN", "OWNER"] as const) {
    const ui = deriveSettingsUiContext(orgMember("ENTERPRISE", role));
    assert.equal(ui.billing.contextType, "enterprise-contract");
    assert.equal(ui.billing.displayPlan, "ENTERPRISE");
    assert.equal(ui.billing.billingHref, null, `${role}: contract-managed, no CTA`);
  }
});

// ---------------------------------------------------------------------------
// RUNTIME — org admin boundary (§13)
// ---------------------------------------------------------------------------

test("org admin links show only for ACTIVE org OWNER/ADMIN of the active org", () => {
  assert.equal(deriveSettingsUiContext(personal("PRO")).showOrgAdminLinks, false);
  assert.equal(
    deriveSettingsUiContext(orgMember("TEAM", "MEMBER")).showOrgAdminLinks,
    false,
  );
  assert.equal(
    deriveSettingsUiContext(orgMember("TEAM", "VIEWER")).showOrgAdminLinks,
    false,
  );
  const admin = deriveSettingsUiContext(orgMember("ENTERPRISE", "ADMIN"));
  assert.equal(admin.showOrgAdminLinks, true);
  assert.equal(admin.orgAdminOrgId, "o-1");
  const owner = deriveSettingsUiContext(orgMember("TEAM", "OWNER"));
  assert.equal(owner.showOrgAdminLinks, true);
});

test("reviewer-criteria card is entitlement-gated; AI settings are workspace-universal", () => {
  const free = deriveSettingsUiContext(personal("FREE"));
  assert.equal(free.showReviewerCriteria, false);
  assert.equal(free.showAiSettings, true);
  const team = deriveSettingsUiContext(orgMember("TEAM", "MEMBER", { reviewer: true }));
  assert.equal(team.showReviewerCriteria, true);
});

// ---------------------------------------------------------------------------
// Source contracts — overview is compact + honest
// ---------------------------------------------------------------------------

const OVERVIEW = read("app/(app)/settings/page.tsx");
const SECURITY = read("app/(app)/security-center/components/PersonalSecuritySections.tsx");
const REGISTRY = read("lib/navigation/routeRegistry.ts");

test("overview has no always-open profile form (editing lives on /settings/profile)", () => {
  assert.doesNotMatch(OVERVIEW, /handleSaveProfile/);
  assert.doesNotMatch(OVERVIEW, /method:\s*"PATCH"/);
  assert.match(OVERVIEW, /href="\/settings\/profile"/);
});

test("overview has no legal-document dump and no fake session status", () => {
  assert.doesNotMatch(OVERVIEW, /LEGAL_LINKS/);
  assert.doesNotMatch(OVERVIEW, /data-retention/);
  assert.doesNotMatch(OVERVIEW, /Abuse reporting/i);
  assert.doesNotMatch(OVERVIEW, />Active</);
  // Privacy is now a dedicated child page.
  assert.match(OVERVIEW, /href="\/settings\/privacy"/);
});

test("notification preferences are discoverable from the Settings overview", () => {
  assert.match(OVERVIEW, /href="\/settings\/notifications"/);
  assert.match(OVERVIEW, /data-cc-overview-notifications/);
});

test("billing card is context-aware (resolver-driven), not a hardcoded personal plan", () => {
  assert.match(OVERVIEW, /deriveSettingsUiContext/);
  assert.match(OVERVIEW, /data-cc-billing-context=\{ui\.billing\.contextType\}/);
  assert.doesNotMatch(OVERVIEW, /\/v1\/billing\/status/);
});

// ---------------------------------------------------------------------------
// Source contracts — MFA management wiring (§2)
// ---------------------------------------------------------------------------

test("MFA management is wired to the canonical /v1/identity/mfa API family", () => {
  assert.match(SECURITY, /\/v1\/identity\/mfa\/factors/);
  assert.match(SECURITY, /\/v1\/identity\/mfa\/enroll\/start/);
  assert.match(SECURITY, /\/v1\/identity\/mfa\/enroll\/verify/);
  assert.match(SECURITY, /\/v1\/identity\/mfa\/recovery-codes\/regenerate/);
});

test("MFA enrollment shows a QR code AND an accessible manual secret", () => {
  assert.match(SECURITY, /QRCodeSVG/);
  assert.match(SECURITY, /data-cc-mfa-manual-secret/);
});

test("recovery codes are one-time with explicit acknowledgement before dismissal", () => {
  assert.match(SECURITY, /never be shown again/);
  assert.match(SECURITY, /data-cc-mfa-codes-acknowledge/);
  // Done button is disabled until the user acknowledges saving the codes.
  assert.match(SECURITY, /disabled=\{!codesAcknowledged\}/);
});

test("factor removal and code regeneration require confirmation", () => {
  assert.match(SECURITY, /Remove two-factor authentication\?/);
  assert.match(SECURITY, /Regenerate recovery codes\?/);
});

test("the dead 'Account → Two-factor' instruction is gone repo-wide", () => {
  const securityCenter = read("app/(app)/security-center/page.tsx");
  assert.doesNotMatch(securityCenter, /Account →\s*\n?\s*Two-factor\)/);
  assert.match(securityCenter, /Settings → Account security/);
});

// ---------------------------------------------------------------------------
// Source contracts — visual system remediation (§3)
// ---------------------------------------------------------------------------

test("no dark-theme constants remain in the personal security sections", () => {
  assert.doesNotMatch(SECURITY, /rgba\(0,0,0,0\.30\)/);
  assert.doesNotMatch(SECURITY, /#dce1de/);
  assert.doesNotMatch(SECURITY, /rgba\(220,225,222/);
  // Canonical light tokens are in use.
  assert.match(SECURITY, /var\(--ink-primary/);
  assert.match(SECURITY, /var\(--ink-secondary/);
});

test("sessions UX: revoke-others only renders when other sessions exist; empty state is honest", () => {
  assert.match(SECURITY, /others\.length > 0 \? \(/);
  assert.doesNotMatch(SECURITY, /No active sessions found/);
  assert.match(SECURITY, /data-cc-no-other-sessions/);
  assert.match(SECURITY, /Current session/);
});

// ---------------------------------------------------------------------------
// Source contracts — routes registered
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step-up re-authentication wiring (2026-07-16 final pass)
// ---------------------------------------------------------------------------

test("sensitive actions retry with backend step-up proof — never a frontend boolean", () => {
  // The shared prompt exists and collects password / current MFA code.
  assert.match(SECURITY, /function StepUpVerify/);
  assert.match(SECURITY, /data-cc-step-up-verify/);
  // Denials are recognized by the backend contract codes.
  assert.match(SECURITY, /STEP_UP_REQUIRED/);
  assert.match(SECURITY, /STEP_UP_INVALID/);
  // All three sensitive actions send the proof in the mutation body.
  assert.match(SECURITY, /JSON\.stringify\(proof \? \{ stepUp: proof \} : \{\}\)/);
  // No frontend `confirmed: true` style bypass.
  assert.doesNotMatch(SECURITY, /confirmed:\s*true/);
});

test("OAuth-only step-up path instructs re-sign-in (no unusable password prompt)", () => {
  assert.match(SECURITY, /sign out and sign back in with your/);
});

// ---------------------------------------------------------------------------
// Notification card contract — Option B (navigation-only), documented
// ---------------------------------------------------------------------------

test("notification overview card is the explicit Option-B navigation contract", () => {
  assert.match(OVERVIEW, /PRODUCT CONTRACT \(Option B/);
  assert.match(
    OVERVIEW,
    /Manage in-app, email, digest and quiet-hour preferences/,
  );
  // No fake digest/quiet-hours values are surfaced on the card.
  assert.doesNotMatch(OVERVIEW, /Quiet hours.*value/);
});

// ---------------------------------------------------------------------------
// FULL persona/workspace/plan matrix (12 scenarios) — executable artifact
// ---------------------------------------------------------------------------

test("full persona matrix — 12 scenarios resolve to the pinned expectations", () => {
  type Row = {
    name: string;
    input: SettingsUiContextInput;
    expect: {
      billing: string;
      plan: string;
      canManageBilling: boolean;
      orgAdmin: boolean;
      reviewerCriteria: boolean;
    };
  };
  const payg = personal("PAYG");
  const rows: Row[] = [
    { name: "Personal Free", input: personal("FREE"), expect: { billing: "personal", plan: "FREE", canManageBilling: true, orgAdmin: false, reviewerCriteria: false } },
    { name: "Personal PAYG", input: payg, expect: { billing: "personal", plan: "PAYG", canManageBilling: true, orgAdmin: false, reviewerCriteria: false } },
    { name: "Personal Pro", input: personal("PRO"), expect: { billing: "personal", plan: "PRO", canManageBilling: true, orgAdmin: false, reviewerCriteria: false } },
    { name: "Team member", input: orgMember("TEAM", "MEMBER"), expect: { billing: "organization", plan: "TEAM", canManageBilling: false, orgAdmin: false, reviewerCriteria: true } },
    { name: "Team reviewer(viewer)", input: orgMember("TEAM", "VIEWER"), expect: { billing: "organization", plan: "TEAM", canManageBilling: false, orgAdmin: false, reviewerCriteria: true } },
    { name: "Team admin", input: orgMember("TEAM", "ADMIN"), expect: { billing: "organization", plan: "TEAM", canManageBilling: true, orgAdmin: true, reviewerCriteria: true } },
    { name: "Team owner", input: orgMember("TEAM", "OWNER"), expect: { billing: "organization", plan: "TEAM", canManageBilling: true, orgAdmin: true, reviewerCriteria: true } },
    { name: "Ent member", input: orgMember("ENTERPRISE", "MEMBER"), expect: { billing: "enterprise-contract", plan: "ENTERPRISE", canManageBilling: false, orgAdmin: false, reviewerCriteria: true } },
    { name: "Ent reviewer(viewer)", input: orgMember("ENTERPRISE", "VIEWER"), expect: { billing: "enterprise-contract", plan: "ENTERPRISE", canManageBilling: false, orgAdmin: false, reviewerCriteria: true } },
    { name: "Ent admin", input: orgMember("ENTERPRISE", "ADMIN"), expect: { billing: "enterprise-contract", plan: "ENTERPRISE", canManageBilling: true, orgAdmin: true, reviewerCriteria: true } },
    { name: "Ent owner", input: orgMember("ENTERPRISE", "OWNER"), expect: { billing: "enterprise-contract", plan: "ENTERPRISE", canManageBilling: true, orgAdmin: true, reviewerCriteria: true } },
    // Billing owner is not modeled as a distinct envelope role today —
    // OWNER carries billing authority; pinned identical to owner.
    { name: "Billing owner (=owner)", input: orgMember("TEAM", "OWNER"), expect: { billing: "organization", plan: "TEAM", canManageBilling: true, orgAdmin: true, reviewerCriteria: true } },
  ];

  const lines: string[] = [
    "persona | billing-ctx | plan | manageBilling | orgAdmin | reviewerCrit | universal",
  ];
  for (const r of rows) {
    const ui = deriveSettingsUiContext(r.input);
    // Universal account sections — NEVER gated in any scenario.
    assert.equal(ui.showProfile && ui.showSecurity && ui.showPreferences && ui.showPrivacy, true, `${r.name}: universal sections`);
    assert.equal(ui.billing.contextType, r.expect.billing, `${r.name}: billing ctx`);
    assert.equal(ui.billing.displayPlan, r.expect.plan, `${r.name}: plan`);
    assert.equal(ui.billing.canManageBilling, r.expect.canManageBilling, `${r.name}: manage billing`);
    assert.equal(ui.showOrgAdminLinks, r.expect.orgAdmin, `${r.name}: org admin links`);
    assert.equal(ui.showReviewerCriteria, r.expect.reviewerCriteria, `${r.name}: reviewer criteria`);
    // Enterprise never exposes a self-service billing CTA.
    if (r.expect.billing === "enterprise-contract") {
      assert.equal(ui.billing.billingHref, null, `${r.name}: no self-service CTA`);
    }
    lines.push(
      `${r.name} | ${ui.billing.contextType} | ${ui.billing.displayPlan} | ${ui.billing.canManageBilling} | ${ui.showOrgAdminLinks} | ${ui.showReviewerCriteria} | yes`,
    );
  }
  // Matrix artifact — printed so the runner output carries the full table.
  console.log("\nSETTINGS PERSONA MATRIX\n" + lines.join("\n"));
});

test("profile/preferences/privacy routes are registered as universal ACCOUNT routes", () => {
  for (const id of ["account.profile", "account.preferences", "account.privacy"]) {
    const at = REGISTRY.indexOf(`id: "${id}"`);
    assert.ok(at > -1, `${id} must be registered`);
    const entry = REGISTRY.slice(at, REGISTRY.indexOf("\n  },", at));
    assert.match(entry, /requiredCapabilities: \[\]/, `${id} must be capability-free`);
    assert.match(entry, /requiredActiveSpace: "NONE"/, `${id} must load without a workspace`);
    assert.match(entry, /sidebarEligible: false/, `${id} is not a sidebar pillar`);
  }
});
