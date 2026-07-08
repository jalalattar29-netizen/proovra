/**
 * Enterprise onboarding wizard — contract + model tests.
 *
 * Two styles, matching the sibling web tests:
 *
 *   (A) PURE-LOGIC unit tests over `_lib/wizardModel.ts` — the step set,
 *       the state machine (next/back/skip/bounds), and checklist
 *       derivation from reads.
 *
 *   (B) SOURCE-SCANNING contract tests over the wizard page + registry —
 *       proving the page exists, is gated, renders the expected step set,
 *       calls the REUSED endpoints (and invents no new ones), and renders
 *       the success screen + checklist.
 *
 * Runs under Node's built-in `node:test`, matching every other web test.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WIZARD_STEPS,
  TOTAL_STEPS,
  initialWizardState,
  goNext,
  goBack,
  goToStep,
  skipStep,
  canGoBack,
  canGoNext,
  isLastStep,
  deriveChecklist,
  checklistProgress,
} from "../app/(app)/organizations/[id]/setup/_lib/wizardModel";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_DIR = resolve(APP_ROOT, "app", "(app)", "organizations", "[id]", "setup");
const PAGE = readFileSync(resolve(SETUP_DIR, "page.tsx"), "utf8");
const CHECKLIST = readFileSync(resolve(SETUP_DIR, "_lib", "SetupChecklist.tsx"), "utf8");
const REGISTRY = readFileSync(
  resolve(APP_ROOT, "lib", "navigation", "routeRegistry.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// (B) The page exists at the org-scoped location.
// ---------------------------------------------------------------------------

test("wizard page exists at organizations/[id]/setup/page.tsx", () => {
  assert.ok(
    existsSync(resolve(SETUP_DIR, "page.tsx")),
    "expected the setup wizard page on disk",
  );
});

// ---------------------------------------------------------------------------
// (B) Gating — PageRouteGate + registry entry, no hand-rolled tier gate.
// ---------------------------------------------------------------------------

test("wizard is gated via PageRouteGate with the org-setup route id", () => {
  assert.match(PAGE, /PageRouteGate/, "must wrap the page in PageRouteGate");
  assert.match(
    PAGE,
    /routeId="account\.organization-setup"/,
    "must use the account.organization-setup route id",
  );
});

test("registry declares account.organization-setup at /organizations/:id/setup", () => {
  assert.match(REGISTRY, /id:\s*"account\.organization-setup"/);
  assert.match(REGISTRY, /href:\s*"\/organizations\/:id\/setup"/);
});

test("wizard surfaces caller role and disables mutating UI for non owner/admin", () => {
  // Mirrors the org detail page: canManage is derived from callerRole and
  // gates the mutating controls (server still enforces).
  assert.match(PAGE, /callerRole/, "reads callerRole from GET /v1/orgs/:id");
  assert.match(
    PAGE,
    /canManage\s*=\s*callerRole === "ORG_OWNER" \|\| callerRole === "ORG_ADMIN"/,
    "gates mutations to ORG_OWNER / ORG_ADMIN",
  );
});

// ---------------------------------------------------------------------------
// (A) Step set.
// ---------------------------------------------------------------------------

const EXPECTED_STEP_IDS = [
  "company",
  "workspace",
  "branding",
  "administrator",
  "invite",
  "billing",
  "security",
  "retention",
  "legalHolds",
  "evidenceDefaults",
  "firstCapture",
  "finish",
] as const;

test("wizard renders the expected 12-step set in order", () => {
  assert.equal(TOTAL_STEPS, EXPECTED_STEP_IDS.length);
  assert.deepEqual(
    WIZARD_STEPS.map((s) => s.id),
    [...EXPECTED_STEP_IDS],
  );
  // Indexes are 1-based and contiguous.
  WIZARD_STEPS.forEach((s, i) => assert.equal(s.index, i + 1));
});

test("each step renders a body in the page source", () => {
  for (const id of EXPECTED_STEP_IDS) {
    assert.match(
      PAGE,
      new RegExp(`step\\.id === "${id}"`),
      `page must render a body for step "${id}"`,
    );
  }
});

test("optional steps are skippable; required steps are not", () => {
  const byId = Object.fromEntries(WIZARD_STEPS.map((s) => [s.id, s]));
  // Required: company, administrator, billing, finish.
  assert.equal(byId.company.skippable, false);
  assert.equal(byId.administrator.skippable, false);
  assert.equal(byId.billing.skippable, false);
  assert.equal(byId.finish.skippable, false);
  // Skippable optional steps.
  assert.equal(byId.workspace.skippable, true);
  assert.equal(byId.invite.skippable, true);
  assert.equal(byId.security.skippable, true);
  assert.equal(byId.retention.skippable, true);
  assert.equal(byId.legalHolds.skippable, true);
});

// ---------------------------------------------------------------------------
// (A) State machine.
// ---------------------------------------------------------------------------

test("state machine: initial, next/back bounds, jump", () => {
  let s = initialWizardState();
  assert.equal(s.stepIndex, 0);
  assert.equal(canGoBack(s), false);
  assert.equal(canGoNext(s), true);

  s = goBack(s); // clamped at 0
  assert.equal(s.stepIndex, 0);

  s = goNext(s);
  assert.equal(s.stepIndex, 1);
  assert.equal(canGoBack(s), true);

  s = goToStep(s, TOTAL_STEPS - 1);
  assert.equal(isLastStep(s), true);
  assert.equal(canGoNext(s), false);

  s = goNext(s); // clamped at last
  assert.equal(s.stepIndex, TOTAL_STEPS - 1);

  // Out-of-range jump is a no-op.
  assert.equal(goToStep(s, -1).stepIndex, TOTAL_STEPS - 1);
  assert.equal(goToStep(s, TOTAL_STEPS + 5).stepIndex, TOTAL_STEPS - 1);
});

test("state machine: skip only advances on skippable steps and records the skip", () => {
  // Step 0 (company) is NOT skippable → no-op.
  const notSkippable = skipStep(initialWizardState());
  assert.equal(notSkippable.stepIndex, 0);
  assert.equal(notSkippable.skipped.size, 0);

  // Step 1 (workspace) IS skippable → advances and records.
  const atWorkspace = goToStep(initialWizardState(), 1);
  const skipped = skipStep(atWorkspace);
  assert.equal(skipped.stepIndex, 2);
  assert.ok(skipped.skipped.has("workspace"));
});

// ---------------------------------------------------------------------------
// (A) Checklist derivation.
// ---------------------------------------------------------------------------

test("checklist: all-null inputs derive to loading (null) criteria", () => {
  const c = deriveChecklist({
    org: null,
    memberCount: null,
    pendingInviteCount: null,
    mfaPolicyLevel: null,
    retentionPolicyCount: null,
    evidenceCount: null,
  });
  assert.equal(c.length, 5);
  for (const crit of c) assert.equal(crit.done, null);
  assert.deepEqual(
    c.map((x) => x.id),
    ["companyProfile", "employeeInvited", "mfaChosen", "retentionSet", "firstEvidence"],
  );
});

test("checklist: fully-configured inputs derive to all done", () => {
  const c = deriveChecklist({
    org: { legalName: "Acme LLC", legalEmail: "legal@acme.test", timezone: "UTC" },
    memberCount: 3,
    pendingInviteCount: 0,
    mfaPolicyLevel: "ALL_MEMBERS",
    retentionPolicyCount: 1,
    evidenceCount: 2,
  });
  for (const crit of c) assert.equal(crit.done, true);
  assert.deepEqual(checklistProgress(c), { done: 5, total: 5 });
});

test("checklist: MFA OFF and empty company fields are not complete", () => {
  const c = deriveChecklist({
    org: { legalName: "", legalEmail: null, timezone: "UTC" },
    memberCount: 1, // sole owner → no employees
    pendingInviteCount: 0,
    mfaPolicyLevel: "OFF",
    retentionPolicyCount: 0,
    evidenceCount: 0,
  });
  const byId = Object.fromEntries(c.map((x) => [x.id, x.done]));
  assert.equal(byId.companyProfile, false);
  assert.equal(byId.employeeInvited, false);
  assert.equal(byId.mfaChosen, false);
  assert.equal(byId.retentionSet, false);
  assert.equal(byId.firstEvidence, false);
});

test("checklist: a single pending invite satisfies employeeInvited", () => {
  const c = deriveChecklist({
    org: null,
    memberCount: 1,
    pendingInviteCount: 1,
    mfaPolicyLevel: null,
    retentionPolicyCount: null,
    evidenceCount: null,
  });
  const invited = c.find((x) => x.id === "employeeInvited");
  assert.equal(invited?.done, true);
});

// ---------------------------------------------------------------------------
// (B) Reuses EXISTING endpoints; invents no new ones.
// ---------------------------------------------------------------------------

test("each writing step declares the EXISTING endpoint it reuses", () => {
  const byId = Object.fromEntries(WIZARD_STEPS.map((s) => [s.id, s.endpoint]));
  assert.equal(byId.company, "PATCH /v1/orgs/:id");
  assert.equal(byId.workspace, "PATCH /v1/teams/:id");
  assert.equal(byId.branding, "PATCH /v1/orgs/:id");
  assert.equal(byId.invite, "POST /v1/orgs/:id/invites");
  assert.equal(byId.billing, "GET /v1/billing/overview");
  assert.equal(byId.security, "PUT /v1/identity-security/mfa-policy");
  assert.equal(byId.retention, "POST /v1/lifecycle/retention/policies");
  assert.equal(byId.legalHolds, "POST /v1/lifecycle/legal-holds");
});

test("page calls the reused endpoints verbatim", () => {
  // Company + branding profile update.
  assert.match(PAGE, /apiFetch\(`\/v1\/orgs\/\$\{orgId\}`,\s*\{\s*method:\s*"PATCH"/);
  // Workspace rename.
  assert.match(PAGE, /apiFetch\(`\/v1\/teams\/\$\{primaryWorkspaceId\}`,\s*\{\s*method:\s*"PATCH"/);
  // Invite.
  assert.match(PAGE, /apiFetch\(`\/v1\/orgs\/\$\{orgId\}\/invites`,\s*\{\s*method:\s*"POST"/);
  // Billing overview (read, via the safeFetch wrapper around apiFetch).
  assert.match(PAGE, /safeFetch<[^>]*>\("\/v1\/billing\/overview"\)/);
  // MFA policy (read + write).
  assert.match(PAGE, /\/v1\/identity-security\/mfa-policy\?teamId=/);
  assert.match(PAGE, /apiFetch\("\/v1\/identity-security\/mfa-policy",\s*\{\s*method:\s*"PUT"/);
  // Retention.
  assert.match(PAGE, /apiFetch\("\/v1\/lifecycle\/retention\/policies",\s*\{\s*method:\s*"POST"/);
  // Legal holds.
  assert.match(PAGE, /apiFetch\("\/v1\/lifecycle\/legal-holds",\s*\{\s*method:\s*"POST"/);
});

test("wizard invents no new backend endpoints (no invites/bulk, no /setup API)", () => {
  assert.doesNotMatch(PAGE, /invites\/bulk/, "no bulk-invite endpoint exists — must not call one");
  assert.doesNotMatch(
    PAGE,
    /\/v1\/orgs\/\$\{orgId\}\/setup/,
    "the wizard must not persist new server state",
  );
  assert.doesNotMatch(PAGE, /onboarding\/(complete|state)/, "no new onboarding-state endpoint");
});

// ---------------------------------------------------------------------------
// (B) Success screen + checklist render.
// ---------------------------------------------------------------------------

test("success screen renders on the finish step with a Go-to-workspace CTA", () => {
  assert.match(PAGE, /data-success-screen/, "finish step renders the success screen");
  assert.match(PAGE, /enterprise ready/i, "success copy present");
  assert.match(PAGE, /href="\/home"/, "success CTA links to the /home dashboard");
  assert.match(PAGE, /Go to workspace/, "explicit go-to-workspace label");
});

test("SetupChecklist is a reusable component rendered by the wizard", () => {
  assert.ok(
    existsSync(resolve(SETUP_DIR, "_lib", "SetupChecklist.tsx")),
    "SetupChecklist component exists",
  );
  assert.match(PAGE, /<SetupChecklist\b/, "wizard renders the checklist");
  assert.match(CHECKLIST, /data-section="setup-checklist"/);
  // Checklist derives from the shared model, not its own reads.
  assert.match(CHECKLIST, /from "\.\/wizardModel"/);
  assert.doesNotMatch(CHECKLIST, /apiFetch/, "checklist must not fetch on its own");
});

test("uses the sanctioned error path (toSafeUserError), never raw error.message", () => {
  assert.match(PAGE, /toSafeUserError/);
  assert.doesNotMatch(PAGE, /addToast\([^)]*\.message/);
});
