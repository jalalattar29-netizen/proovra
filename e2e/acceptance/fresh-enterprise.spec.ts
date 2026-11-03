/**
 * A BRAND-NEW ENTERPRISE CUSTOMER, THROUGH THE PRODUCT.
 *
 * One synthetic company travels from the operator's provisioning console to
 * supported offboarding in a real browser. Nothing is seeded for the customer and
 * nothing here writes SQL. Mail comes from the recording transport's file, which
 * is that person's inbox, and codes come from a real TOTP of the secret the page
 * showed.
 *
 * Labelled fixture shortcuts, which count as no proof of onboarding:
 *   FIXTURE-1  The operator account is seeded. A platform operator is staff, not a
 *              customer step. Its authenticator is enrolled through the product.
 *
 * Closure runs on the real worker's own timer. The stack shortens its period
 * (LIFECYCLE_SWEEP_INTERVAL_MS, stack.mjs); nothing here calls the tick.
 *
 * Unverified, and said so where the journey reaches them:
 *   SSO and SCIM against a real identity provider. Google and Apple sign-in.
 *
 * Each step leaves its state in .p7tmp/acceptance-state.json, so a repaired step
 * can be rerun alone: ACCEPT_RESUME=1 ... -g "S07".
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chooseListbox } from "../helpers/listbox";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { assertIsolatedStack } from "../helpers/stack-isolation";
import {
  API_BASE,
  answerStepUp,
  registerAccount,
  keepProfile,
  linkFromMail,
  loadState,
  mailbox,
  newProfile,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  person,
  saveState,
  shot,
  samplePng,
  signIn,
  switchWorkspace,
  signOut,
  submitPassword,
  totp,
  wrongCode,
} from "./lib/journey";

const s = loadState();
test.describe.configure({ mode: "serial" });

// Seats bound the people beside the owner (owner decision 2026-10-25): the owner takes none.
const SEATS_SOLD = 3;
const ROOT = resolve(__dirname, "..", "..");

type ManifestSummary = {
  recordCount: number;
  objectCount: number;
  heldRecordCount: number;
  missingObjects: number;
};
type ManifestFile = {
  records: Array<{
    evidenceId: string;
    legalHold: boolean;
    objects: Array<{ kind: string; sha256: string | null }>;
  }>;
};

/**
 * The organization export manifest, by the operator script the data-return runbook
 * names, in the stack's own allowlisted environment. Nothing is read from a page.
 */
function organizationManifest(orgId: string, name: string): { summary: ManifestSummary; file: ManifestFile } {
  const out = resolve(ROOT, ".p7tmp", `${name}.json`);
  const stdout = execFileSync(process.execPath, ["e2e/acceptance/stack.mjs", "manifest", orgId, out], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      ACCEPT_STACK_INSTANCE: process.env.ACCEPT_STACK_INSTANCE ?? "",
    },
  });
  const line = stdout.split("\n").reverse().find((l) => l.startsWith('{"organizationId"'));
  expect(line, stdout.slice(-400)).toBeTruthy();
  return { summary: JSON.parse(line!) as ManifestSummary, file: JSON.parse(readFileSync(out, "utf8")) as ManifestFile };
}

async function confirmDialog(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("dialog").getByRole("button", { name }).click();
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
}

test.beforeAll(async () => {
  // Fail closed: nothing runs against a stack that could reach a live service.
  await assertIsolatedStack();
});
test.afterEach(() => saveState(s));

test("S01 operator signs in and holds a factor [FIXTURE-1: seeded operator]", async ({ browser }) => {
  const op = (s.people.operator ??= { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD, name: "Platform operator" });
  const { context, page } = await newProfile(browser);
  await signIn(page, op);
  await page.goto("/settings#security");
  await settle(page);
  if (!op.totpSecret) {
    const start = page.locator("[data-cc-mfa-enroll-start]");
    await expect(start).toBeVisible();
    await start.click();
    await expect(page.locator("[data-cc-mfa-enrolling]")).toBeVisible();
    op.totpSecret = (await page.locator("[data-cc-mfa-manual-secret]").innerText()).trim();
    await page.locator("[data-cc-mfa-verify-code]").fill(await totp(op));
    await page.locator("[data-cc-mfa-verify-submit]").click();
    await page.locator("[data-cc-mfa-codes-acknowledge]").check();
    await page.locator("[data-cc-mfa-codes-done]").click();
  }
  await expect(page.locator("[data-cc-mfa-card]")).toContainText("enabled");
  await keepProfile(context, op, s, "operator");
  await context.close();
});

test("S02 operator provisions the customer; the owner is invited by email", async ({ browser }) => {
  const op = s.people.operator!;
  const owner = person(s, "owner", "Ingrid Halden");
  const { context, page } = await newProfile(browser, op);
  await page.goto("/admin/provisioning");
  await page.getByTestId("provision-org-name").fill(s.company);
  await page.getByTestId("provision-owner-email").fill(owner.email);
  await page.getByTestId("provision-seats").fill(String(SEATS_SOLD));
  await page.getByTestId("provision-workspace-name").fill("Claims Investigations");
  await page.getByTestId("provision-submit").click();
  await confirmDialog(page, /Provision customer/);
  await answerStepUp(page, op);
  const pending = page.getByTestId("provision-success-pending");
  await expect(pending).toBeVisible();
  await shot(page, "s02-provisioned");
  const text = await pending.innerText();
  s.orgId = text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
  expect(s.orgId).toBeTruthy();
  await keepProfile(context, op, s, "operator");
  await context.close();
  const link = await linkFromMail(owner.email, /invite/i);
  s.facts.ownerInviteLink = link;
});

test("S03 operator states the contract before the owner arrives", async ({ browser }) => {
  const op = s.people.operator!;
  const { context, page } = await newProfile(browser, op);
  await page.goto(`/admin/customers/${s.orgId}`);
  await expect(page.getByTestId("customer-contract-panel")).toBeVisible();
  await shot(page, "s03-customer");
  await page.getByTestId("contract-term-legalHold").check();
  await page.getByTestId("contract-term-reference").fill(`HM-${s.runId}`);
  await page.getByTestId("contract-terms-save").click();
  await answerStepUp(page, op);
  await expect(page.getByText("Contract terms saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("contract-term-legalHold")).toBeChecked();
  await expect(page.getByTestId("contract-term-seatCount")).toHaveValue(String(SEATS_SOLD));
  await context.close();
});

test("S04 owner accepts the invitation from a new account", async ({ browser }) => {
  const owner = s.people.owner!;
  const { context, page } = await newProfile(browser);
  // A person with no account opens the link in the email, and is sent to sign in.
  await page.goto(s.facts.ownerInviteLink!);
  // Signed out, the invitation shows alone: no sidebar, no workspace chip.
  await expect(page.locator('[data-action="accept-invite"]')).toBeVisible();
  await expect(page.locator("[data-signed-out-invitation]")).toBeVisible();
  await expect(page.locator("[data-app-context-chip]")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Workspace unavailable");
  await shot(page, "s04-invitation-signed-out");
  await page.locator('[data-action="accept-invite"]').click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  expect(page.url()).toContain("next=");
  await page.getByRole("link", { name: /create|sign up|register/i }).first().click();
  await page.waitForURL(/\/register/);
  await registerAccount(page, owner);
  await page.goto(s.facts.ownerInviteLink!);
  await page.locator('[data-action="accept-invite"]').click();
  // The accept activates the contract and creates the workspace; the owner lands in setup.
  await page.waitForURL(/\/organizations\/[^/]+\/setup/, { timeout: 30_000 });
  await expect(page.locator('[data-page="organization-setup-wizard"]')).toBeVisible();
  await expect(page.locator('[data-page="organization-setup-wizard"]')).toHaveAttribute("data-caller-role", "ORG_OWNER");
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S05 first setup: company, workspace and the contract as the owner sees it", async ({ browser }) => {
  const owner = s.people.owner!;
  const { context, page } = await newProfile(browser, owner);
  const wizard = page.locator('[data-page="organization-setup-wizard"]');
  await page.goto(`/organizations/${s.orgId}/setup`);
  await expect(wizard).toHaveAttribute("data-step-id", "company");
  await expect(page.locator('[data-input="company-name"]')).toHaveValue(s.company);
  await page.locator('[data-input="legal-name"]').fill(`${s.company} AS`);
  await page.locator('[data-input="legal-email"]').fill(`legal.${s.runId}@halden-marine.example.test`);
  await page.locator('[data-input="timezone"]').fill("Europe/Oslo");
  await page.locator('[data-action="step-save"]').click();
  await expect(page.locator("[data-step-saved]")).toBeVisible();
  await page.locator('[data-action="wizard-next"]').click();
  await expect(wizard).toHaveAttribute("data-step-id", "workspace");
  await expect(page.locator('[data-input="workspace-name"]')).toHaveValue("Claims Investigations");
  await page.locator('[data-progress-step="billing"]').click();
  await expect(wizard).toHaveAttribute("data-step-id", "billing");
  await expect(page.locator('[data-readonly-row="billing-contract-status"]')).toContainText("Active");
  await expect(page.locator('[data-readonly-row="billing-seats"]')).toContainText(String(SEATS_SOLD));
  await expect(page.locator(`[data-readonly-row="billing-seats-used"]`)).toContainText("0");
  await shot(page, "s05-billing");
  // The company information survives a hard refresh.
  await page.reload();
  await expect(page.locator('[data-input="legal-name"]')).toHaveValue(`${s.company} AS`);
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S06 owner sets MFA for everyone: a factor first, then the policy behind step-up", async ({ browser }) => {
  const owner = s.people.owner!;
  const { context, page } = await newProfile(browser, owner);
  await page.goto("/settings#security");
  await settle(page);
  await page.locator("[data-cc-mfa-enroll-start]").click();
  await expect(page.locator("[data-cc-mfa-enrolling]")).toBeVisible();
  owner.totpSecret = (await page.locator("[data-cc-mfa-manual-secret]").innerText()).trim();
  await page.locator("[data-cc-mfa-verify-code]").fill(await totp(owner));
  await page.locator("[data-cc-mfa-verify-submit]").click();
  await page.locator("[data-cc-mfa-codes-acknowledge]").check();
  await page.locator("[data-cc-mfa-codes-done]").click();
  await expect(page.locator("[data-cc-mfa-card]")).toContainText("enabled");

  const wizard = page.locator('[data-page="organization-setup-wizard"]');
  await page.goto(`/organizations/${s.orgId}/setup#security`);
  await expect(wizard).toHaveAttribute("data-step-id", "security");
  await page.locator('[data-input="mfa-level"]').click();
  await page.getByRole("option", { name: /All members/ }).click();
  await page.locator('[data-action="step-save"]').click();
  await answerStepUp(page, owner);
  await expect(page.locator("[data-step-saved]")).toBeVisible();
  // The policy now covers the password session that set it, and the page says what to do.
  await expect(page.locator("[data-setup-session-refused]")).toContainText("Sign out and sign in again");
  await shot(page, "s06-session-refused");

  // RT-006: the owner's first challenge, through the browser. A wrong code is retried.
  await signOut(page);
  await submitPassword(page, owner.email, owner.password);
  await page.waitForURL(/\/auth\/mfa-challenge/, { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await page.locator('input[name="code"]').fill(wrongCode(owner));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.locator("[data-cc-mfa-error]")).toContainText("did not match");
  await page.locator('input[name="code"]').fill(await totp(owner));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/mfa-challenge"), { timeout: 30_000 });

  // SSO and SCIM show as not configured. A real IdP is unavailable here: unverified.
  await page.goto(`/organizations/${s.orgId}/setup#security`);
  await expect(wizard).toHaveAttribute("data-step-id", "security");
  await expect(page.locator("[data-setup-session-refused]")).toHaveCount(0);
  await expect(page.locator("[data-readiness-row]").first()).toHaveAttribute("data-readiness-state", "todo");
  await page.locator('[data-action="wizard-next"]').click();
  await expect(wizard).toHaveAttribute("data-step-id", "retention");
  await page.locator('[data-action="step-save"]').click();
  await expect(page.locator("[data-step-saved]")).toBeVisible();
  await expect(page.locator('[data-checklist-criterion="mfaChosen"]')).toHaveAttribute("data-checklist-state", /done/);
  await expect(page.locator('[data-checklist-criterion="retentionSet"]')).toHaveAttribute("data-checklist-state", /done/);
  await shot(page, "s06-security");
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S06B the posture pages report what the wizard set: retention in force, MFA for all", async ({ browser }) => {
  const owner = s.people.owner!;
  const { context, page } = await newProfile(browser, owner);
  await page.goto(`/organizations/${s.orgId}/admin/governance`);
  await settle(page);
  await expect(page.getByTestId("kpi-retention-policies")).toContainText("1");
  await expect(page.getByTestId("retention-policy-row").first()).toContainText("(default)");
  await expect(page.getByTestId("coverage-retention")).not.toContainText("0%");
  await shot(page, "s06b-governance");
  await page.goto(`/organizations/${s.orgId}/admin/retention`);
  await settle(page);
  await expect(page.getByTestId("retention-workspace-policies")).toContainText("1 policy in force across 1 of 1 workspace");
  await shot(page, "s06b-retention-tab");
  await page.goto(`/organizations/${s.orgId}/admin/security`);
  await settle(page);
  await expect(page.getByTestId("sec-mfa-level")).toHaveText("All members");
  await expect(page.getByTestId("sec-mfaRequiredFlag-off")).toHaveCount(0);
  await shot(page, "s06b-security-tab");
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S07 owner invites members from the wizard, naming their workspace access", async ({ browser }) => {
  const owner = s.people.owner!;
  const { context, page } = await newProfile(browser, owner);
  await page.goto(`/organizations/${s.orgId}/setup#invite`);
  const wizard = page.locator('[data-page="organization-setup-wizard"]');
  await expect(wizard).toHaveAttribute("data-step-id", "invite");
  const invite = async (key: string, name: string, role: RegExp, access: RegExp) => {
    const p = person(s, key, name);
    await page.locator('[data-input="invite-email"]').fill(p.email);
    await page.locator('[data-input="invite-role"]').click();
    await page.getByRole("option", { name: role }).click();
    await page.locator('[data-input="invite-workspace-access"]').click();
    await page.getByRole("option", { name: access }).click();
    await page.locator('[data-action="send-invite"]').click();
    return p;
  };
  await invite("admin", "Aksel Berg", /^Admin$/, /^Admin$/);
  await expect(page.locator("[data-invited-count]")).toHaveAttribute("data-invited-count", "1");
  await invite("analyst", "Sana Rahman", /^Member$/, /^Member$/);
  await expect(page.locator("[data-invited-count]")).toHaveAttribute("data-invited-count", "2");
  await invite("auditor", "Tor Lie", /^Member$/, /^Viewer$/);
  await expect(page.locator("[data-invited-count]")).toHaveAttribute("data-invited-count", "3");
  // A fifth invitation may be sent; a seat is taken when it is accepted (S09).
  await invite("overflow", "Nora Vik", /^Member$/, /^Member$/);
  await expect(page.locator("[data-invited-count]")).toHaveAttribute("data-invited-count", "4");
  await shot(page, "s07-invites");
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

/** Register from the invitation, accept it, then sign in: MFA is required and no factor exists. */
async function joinAndEnrol(browser: Browser, key: string): Promise<void> {
  const p = s.people[key]!;
  const { context, page } = await newProfile(browser);
  const link = await linkFromMail(p.email, /invite/i);
  await registerAccount(page, p);
  await page.goto(link);
  await page.locator('[data-action="accept-invite"]').click();
  await expect(page.locator('[data-state="accepted"]')).toContainText("with access to one workspace");
  await shot(page, `s08-${key}-accepted`);
  await signOut(page);
  await page.waitForTimeout(500);
  expect(await signIn(page, p), "a required member with no factor enrols during sign-in").toBe("enrolled");
  await settle(page);
  await shot(page, `s08-${key}-enrolled`);
  await keepProfile(context, p, s, key);
  await context.close();
}

test("S08 a required member with no factor enrols at sign-in, then passes the challenge (RT-006)", async ({ browser }) => {
  await joinAndEnrol(browser, "analyst");
  const analyst = s.people.analyst!;
  const { context, page } = await newProfile(browser, analyst);
  await page.goto("/home");
  await signOut(page);
  expect(await signIn(page, analyst)).toBe("challenge");
  await settle(page);
  await switchWorkspace(page, "Claims Investigations");
  await keepProfile(context, analyst, s, "analyst");
  await context.close();
});

test("S09 seats: the sold count is reached and the next acceptance is refused", async ({ browser }) => {
  await joinAndEnrol(browser, "admin");
  await joinAndEnrol(browser, "auditor");
  const overflow = s.people.overflow!;
  const { context, page } = await newProfile(browser);
  const link = await linkFromMail(overflow.email, /invite/i);
  await registerAccount(page, overflow);
  await page.goto(link);
  await page.locator('[data-action="accept-invite"]').click();
  await settle(page);
  await shot(page, "s09-seat-refused");
  await expect(page.locator('[data-state="workspace-refused"]')).toContainText("no seat free");
  await context.close();
  const owner = s.people.owner!;
  const o = await newProfile(browser, owner);
  await o.page.goto(`/organizations/${s.orgId}/setup#billing`);
  await expect(o.page.locator('[data-readonly-row="billing-seats-used"]')).toContainText(String(SEATS_SOLD));
  await o.context.close();
});

test("S09B RT-015: acceptance is one step after sign-in, for whoever owes it, and is not asked again", async ({ browser, request }) => {
  // An account made outside the web form (the app's API path) has accepted nothing yet.
  const late = person(s, "late", "Mia Strand");
  const made = await request.post(`${API_BASE}/v1/auth/email/register`, { data: { email: late.email, password: late.password } });
  expect(made.status(), await made.text()).toBeLessThan(300);
  const token = new URL(await linkFromMail(late.email, /verify/i)).searchParams.get("token");
  const verified = await request.post(`${API_BASE}/v1/auth/email/verify`, { data: { token, password: late.password } });
  expect(verified.status(), await verified.text()).toBeLessThan(300);

  const { context, page } = await newProfile(browser);
  expect(await signIn(page, late)).toBe("password");
  await settle(page);
  const step = page.locator("[data-legal-step]");
  await expect(step).toBeVisible();
  await shot(page, "s09b-legal-step");
  await expect(page.locator("[data-legal-step-accept]")).toBeDisabled();
  await page.locator("[data-legal-step-agree]").check();
  await page.locator("[data-legal-step-accept]").click();
  await expect(step).toHaveCount(0);
  await page.reload();
  await settle(page);
  await expect(step).toHaveCount(0);
  await signOut(page);
  expect(await signIn(page, late)).toBe("password");
  await settle(page);
  await expect(step).toHaveCount(0);
  await context.close();

  // A person who already accepted passes the MFA challenge and is asked nothing.
  const analyst = s.people.analyst!;
  const a = await newProfile(browser);
  expect(await signIn(a.page, analyst)).toBe("challenge");
  await settle(a.page);
  await expect(a.page.locator("[data-legal-step]")).toHaveCount(0);
  await keepProfile(a.context, analyst, s, "analyst");
  await a.context.close();
});

test("S10 workspace switch; analyst uploads real evidence, it seals and reports", async ({ browser }) => {
  const analyst = s.people.analyst!;
  const { context, page } = await newProfile(browser, analyst);
  await page.goto("/home");
  await settle(page);
  await switchWorkspace(page, "Claims Investigations");
  await page.goto("/capture");
  await settle(page);
  await page.locator('input[type="file"][aria-label="Upload evidence files"]').setInputFiles({
    name: `hull-damage-${s.runId}.png`,
    mimeType: "image/png",
    buffer: samplePng(s.runId),
  });
  await expect(page.getByText("1 material added").first()).toBeVisible();
  await page.getByRole("button", { name: "Review & Sign", exact: true }).last().click();
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 60_000 });
  s.facts.evidenceId = page.url().match(/evidence\/([0-9a-f-]{36})/)![1]!;
  // The worker seals and reports in the background: the page settles on its own record.
  await expect(async () => {
    await page.reload();
    await expect(page.locator('[data-evidence-action="download-report"]')).toBeEnabled({ timeout: 3000 });
    await expect(page.getByText("Reported").first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 120_000, intervals: [3000] });
  const pdf = page.waitForEvent("download");
  await page.locator('[data-evidence-action="download-report"]').click();
  const file = await (await pdf).path();
  expect(readFileSync(file).subarray(0, 4).toString()).toBe("%PDF");
  const zip = page.waitForEvent("download");
  await page.locator('[data-evidence-action="download-package"]').click();
  expect(readFileSync(await (await zip).path()).subarray(0, 2).toString()).toBe("PK");
  await shot(page, "s10-sealed");
  await keepProfile(context, analyst, s, "analyst");
  await context.close();
});

test("S11 admin opens a case, adds the record, restricts it to one member", async ({ browser }) => {
  const admin = s.people.admin!;
  const { context, page } = await newProfile(browser, admin);
  await page.goto("/home");
  await settle(page);
  await switchWorkspace(page, "Claims Investigations");
  await page.goto("/cases");
  await settle(page);
  await page.locator("[data-create-case-trigger]").first().click();
  await page.getByPlaceholder("e.g. Insurance claim #4823").fill((s.facts.caseTitle = `MV Aurora hull claim ${s.runId}-${Date.now() % 100000}`));
  await page.getByRole("dialog").getByRole("button", { name: /create/i }).click();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}/, { timeout: 30_000 });
  s.facts.caseId = page.url().match(/cases\/([0-9a-f-]{36})/)![1]!;
  await settle(page);

  await page.locator('[data-tab-id="evidence"]').click();
  await page.locator("[data-matter-evidence-link-open]").click();
  const picker = page.locator('[role="dialog"]').filter({ has: page.locator("[data-matter-evidence-link-search-input]") });
  await expect(picker.getByText(`hull-damage-${s.runId}.png`).first()).toBeVisible();
  await picker.getByText(`hull-damage-${s.runId}.png`).first().click();
  await page.locator("[data-matter-evidence-link-submit]").click();
  await expect(page.locator("[data-matter-evidence-link-submit]")).toHaveCount(0);
  await expect(page.locator("main")).toContainText(`hull-damage-${s.runId}.png`);

  await page.locator('[data-tab-id="access"]').click();
  await page.locator("[data-workspace-member-select] button[data-placeholder]").click();
  await page.getByRole("option", { name: /analyst\./ }).click();
  await page.locator("button[data-matter-access-grant]").click();
  await confirmDialog(page, /Give access and restrict/);
  await expect(page.locator("[data-matter-access-grant]").first()).toBeVisible();
  await expect(page.getByText(/now has access to this case/)).toBeVisible();
  await shot(page, "s11-restricted");
  await keepProfile(context, admin, s, "admin");
  await context.close();
});

test("S12 restricted access: the named member opens the case, a colleague cannot", async ({ browser }) => {
  const analyst = s.people.analyst!;
  const a = await newProfile(browser, analyst);
  await a.page.goto("/home");
  await settle(a.page);
  await switchWorkspace(a.page, "Claims Investigations");
  await a.page.goto(`/cases/${s.facts.caseId}`);
  await settle(a.page);
  await expect(a.page.locator("main")).toContainText(s.facts.caseTitle!);
  await a.context.close();

  const auditor = s.people.auditor!;
  const b = await newProfile(browser, auditor);
  await b.page.goto("/home");
  await settle(b.page);
  await switchWorkspace(b.page, "Claims Investigations");
  await b.page.goto("/cases");
  await settle(b.page);
  await expect(b.page.locator("main")).not.toContainText(s.facts.caseTitle!);
  await b.page.goto(`/cases/${s.facts.caseId}`);
  await settle(b.page);
  await expect(b.page.locator("main")).not.toContainText(s.facts.caseTitle!);
  await shot(b.page, "s12-auditor-refused");
  await b.page.goto(`/evidence/${s.facts.evidenceId}`);
  await settle(b.page);
  await shot(b.page, "s12-auditor-evidence");
  await keepProfile(b.context, auditor, s, "auditor");
  await b.context.close();
});

test("S13 review: a reviewer claims, begins and decides; the decision survives a refresh", async ({ browser }) => {
  const admin = s.people.admin!;
  const { context, page } = await newProfile(browser, admin);
  await page.goto(`/evidence/${s.facts.evidenceId}`);
  await settle(page);
  await page.locator('[data-evidence-tab="review"]').click();
  await expect(page.locator("[data-evidence-review-action]").first()).toBeVisible();
  // A resumed run may find the review already claimed and begun by this reviewer.
  if (await page.locator('[data-evidence-review-action="CLAIM"]').isVisible()) {
    await page.locator('[data-evidence-review-action="CLAIM"]').click();
    await expect(page.locator('[data-evidence-review-outcome="success"]')).toBeVisible();
    await page.locator('[data-evidence-review-action="BEGIN_REVIEW"]').click();
    await expect(page.locator('[data-evidence-review-action="BEGIN_REVIEW"]')).toHaveCount(0);
  }
  await page.locator('[data-evidence-review-action="APPROVE_INTERNAL"]').click();
  await page.waitForTimeout(700);
  await shot(page, "s13-approve");
  const reason = page.locator("[data-evidence-review-reason-submit]");
  if (await reason.isVisible().catch(() => false)) {
    await page.locator("[data-evidence-review-reason] textarea").fill("Hull photographs match the survey report.");
    await reason.click();
  } else {
    await page.getByRole("dialog").getByRole("button").last().click();
  }
  // A decision asks for step-up only when the review gate does: the workspace
  // flag, or an adaptive risk above LOW. This session is a known, low-risk
  // sign-in, so the gate may let it through; when it asks, the panel's own
  // dialog answers it.
  await page.waitForTimeout(700);
  if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) {
    await answerStepUp(page, admin);
  }
  await shot(page, "s13-after-approve");
  await expect(page.locator('[data-evidence-review-outcome="success"]')).toBeVisible();
  await page.reload();
  await settle(page);
  await page.locator('[data-evidence-tab="review"]').click();
  await expect(page.locator("[data-evidence-review-decision]").first()).toContainText(/approv/i);
  await context.close();
});

test("S14 external sharing: a scoped outside reviewer is invited and decides through the portal", async ({ browser }) => {
  const admin = s.people.admin!;
  const ext = person(s, "external", "Lena Moe");
  if (mailbox(ext.email).length === 0) {
    const { context, page } = await newProfile(browser, admin);
    await page.goto("/review/external");
    await settle(page);
    await page.locator('[data-tab="bulk"]').click();
    await page.locator('[data-bulk-scope-kind="CASE"]').click();
    await page.locator("[data-bulk-scope-option]").first().click();
    await page.locator("[data-bulk-paste]").fill(`${ext.email},${ext.name},Nordic Surveyors`);
    await page.locator("[data-bulk-default-hours]").fill("48");
    await page.locator("[data-bulk-issue-submit]").click();
    await answerStepUp(page, admin);
    await expect(page.getByText("Issued 1 of 1 invitation")).toBeVisible();
    await page.locator('[data-tab="pending"]').click();
    await expect(page.locator("main")).toContainText(ext.email);
    await context.close();
  }
  const link = await linkFromMail(ext.email, /review|invit/i);
  const e = await newProfile(browser);
  await e.page.goto(link);
  await e.page.locator("[data-portal-accept-open-with-token]").click();
  await expect(e.page.getByText("Assigned reviews")).toBeVisible();
  await expect(e.page.locator("body")).not.toContainText("undefined");
  await expect(e.page.locator("body")).not.toContainText("PORTAL_NOT_A_LEGAL_OPINION");
  await e.page.locator("[data-portal-open-review]").first().click();
  await settle(e.page);
  await shot(e.page, "s14-work");
  await e.page.getByPlaceholder("Add a comment to the workflow…").fill("Damage pattern consistent with the survey.");
  await e.page.locator("[data-portal-root-comment-submit]").click();
  await expect(e.page.locator("[data-portal-comment-thread]").first()).toContainText("Damage pattern");
  await e.page.locator("[data-portal-decision-rationale]").fill("Reviewed the linked record.");
  await e.page.locator('[data-portal-decision-btn="APPROVE"]').click();
  await expect(e.page.locator("[data-portal-decision-status]")).toBeVisible();
  await e.page.reload();
  await settle(e.page);
  await shot(e.page, "s14-decided");
  await expect(e.page.getByText("You have not recorded a decision")).toHaveCount(0);
  await e.context.close();
});

test("S15 Legal Hold from the contract, against the record; retention stays in force", async ({ browser }) => {
  // The case owner places it: the record sits in a restricted case, closed even to the workspace owner.
  const admin = s.people.admin!;
  const { context, page } = await newProfile(browser, admin);
  await page.goto("/home");
  await settle(page);
  await switchWorkspace(page, "Claims Investigations");
  await page.goto("/evidence-lifecycle/retention");
  await settle(page);
  await expect(page.locator("[data-retention-release]").first()).toBeVisible();
  await page.goto("/evidence-lifecycle/legal-holds");
  await settle(page);
  await chooseListbox(page.locator("main [role=combobox]").first(), "EVIDENCE");
  await page.getByPlaceholder("Hold name").fill(`Aurora litigation ${s.runId}`);
  await page.getByPlaceholder("Legal basis").fill("Anticipated hull claim dispute");
  await page.locator('[data-record-picker="evidence"] button').first().click();
  await page.waitForTimeout(400);
  await shot(page, "s15-form");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await answerStepUp(page, admin);
  const row = page.locator("[data-legal-hold-row]", { hasText: `Aurora litigation ${s.runId}` });
  await expect(row).toBeVisible();
  await shot(page, "s15-held");

  // The hold bites on the record: it cannot be sent to trash, and that is explained.
  await page.goto(`/evidence/${s.facts.evidenceId}`);
  await settle(page);
  const trash = page.locator('[data-evidence-action="header-trash"]');
  console.log("trash disabled?", await trash.getAttribute("data-evidence-trash-disabled"), await trash.getAttribute("title"));
  await shot(page, "s15-evidence-held");
  await expect(trash).toHaveAttribute("data-evidence-trash-disabled", "true");
  await keepProfile(context, admin, s, "admin");
  await context.close();
});

test("S15B the organization's export: the manifest reconciles to the sealed bytes, and its reports download", async ({ browser }) => {
  const { summary, file } = organizationManifest(s.orgId!, "manifest-under-hold");
  console.log("manifest", JSON.stringify(summary));
  expect(summary.recordCount).toBeGreaterThanOrEqual(1);
  expect(summary.missingObjects).toBe(0);
  expect(summary.heldRecordCount).toBeGreaterThanOrEqual(1);
  const record = file.records.find((r) => r.evidenceId === s.facts.evidenceId);
  expect(record, "the sealed record is in the manifest").toBeTruthy();
  expect(record!.legalHold, "and flagged, because the hold from S15 stands").toBe(true);
  const original = record!.objects.find((o) => o.kind === "ORIGINAL" || o.kind === "PART");
  expect(original?.sha256).toBe(createHash("sha256").update(samplePng(s.runId)).digest("hex"));
  expect(record!.objects.map((o) => o.kind)).toEqual(expect.arrayContaining(["REPORT"]));
  s.facts.manifestRecordCount = String(summary.recordCount);
  s.facts.manifestObjectCount = String(summary.objectCount);

  // The reports the owner takes away, through the page's own buttons.
  const owner = s.people.owner!;
  const { context, page } = await newProfile(browser, owner);
  await page.goto(`/organizations/${s.orgId}/admin/reports`);
  await settle(page);
  for (const [id, expected] of [["members", s.people.analyst!.email], ["audit", "ORG_MEMBER_INVITED"]] as const) {
    const download = page.waitForEvent("download");
    await page.getByTestId(`report-download-${id}`).click();
    const csv = readFileSync(await (await download).path(), "utf8");
    expect(csv, id).toContain(expected);
  }
  await shot(page, "s15b-reports");
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S16A a hard refresh mid-journey keeps the record and the workspace", async ({ browser }) => {
  const analyst = s.people.analyst!;
  const { context, page } = await newProfile(browser, analyst);
  await page.goto("/home");
  await settle(page);
  await switchWorkspace(page, "Claims Investigations");
  await page.goto(`/cases/${s.facts.caseId}`);
  await settle(page);
  await expect(page.locator("main")).toContainText(s.facts.caseTitle!);
  await page.reload();
  await settle(page);
  await expect(page.locator("main")).toContainText(s.facts.caseTitle!);
  await expect(page.locator("[data-context-chip-name]")).toContainText("Claims Investigations");
  await keepProfile(context, analyst, s, "analyst");
  await context.close();
});

test("S16B sign-out and sign-in mid-journey: the record, its report and the decision are still there", async ({ browser }) => {
  const analyst = s.people.analyst!;
  const { context, page } = await newProfile(browser, analyst);
  await page.goto("/home");
  await settle(page);
  await signOut(page);
  // A session that ended stays ended: the app sends a signed-out person to sign in.
  await page.goto(`/evidence/${s.facts.evidenceId}`);
  await settle(page);
  await expect(page.locator("main")).not.toContainText(`hull-damage-${s.runId}`);
  expect(await signIn(page, analyst)).toBe("challenge");
  await settle(page);
  await switchWorkspace(page, "Claims Investigations");
  await page.goto(`/evidence/${s.facts.evidenceId}`);
  await settle(page);
  await expect(page.getByText("Reported").first()).toBeVisible();
  // The hold from S15 is still in force, and it blocks exports (GOV-012, a founder decision).
  await expect(page.getByText("Export blocked").first()).toBeVisible();
  await expect(page.locator('[data-evidence-action="download-report"]')).toBeDisabled();
  await page.locator('[data-evidence-tab="review"]').click();
  await expect(page.locator("[data-evidence-review-decision]").first()).toContainText(/approv/i);
  await keepProfile(context, analyst, s, "analyst");
  await context.close();
});

test("S16C switching workspace mid-journey changes what is read, and back again", async ({ browser }) => {
  const analyst = s.people.analyst!;
  const { context, page } = await newProfile(browser, analyst);
  await page.goto("/home");
  await settle(page);
  await switchWorkspace(page, "Claims Investigations");
  // Personal Space shows none of the organization's records.
  await page.locator("[data-app-context-chip] button").first().click();
  await page.locator('[data-context-group="PERSONAL"] [data-context-option]').first().click();
  await expect(page.locator("[data-context-chip-name]")).toContainText(/Personal/);
  await page.goto("/evidence");
  await settle(page);
  await expect(page.locator("main")).not.toContainText(`hull-damage-${s.runId}`);
  await switchWorkspace(page, "Claims Investigations");
  await page.goto("/evidence");
  await settle(page);
  await expect(page.locator("main")).toContainText(`hull-damage-${s.runId}`);
  await keepProfile(context, analyst, s, "analyst");
  await context.close();
});

test("S17 role change and member suspension take effect, and restoring brings access back", async ({ browser }) => {
  const owner = s.people.owner!;
  const auditor = s.people.auditor!;
  const { context, page } = await newProfile(browser, owner);
  await page.goto(`/organizations/${s.orgId}/admin/members`);
  await settle(page);
  const row = page.locator("[data-membership-id]", { hasText: auditor.email });
  const id = (await row.getAttribute("data-membership-id"))!;
  await page.getByTestId(`member-role-select-${id}`).click();
  await page.getByRole("option", { name: /^Auditor/ }).click();
  await expect(row).toHaveAttribute("data-member-role", "ORG_AUDITOR");
  await page.getByTestId(`member-suspend-${id}`).click();
  await page.getByTestId(`member-suspend-reason-${id}`).fill("Leave of absence");
  await page.getByTestId(`member-suspend-confirm-${id}`).click();
  await page.waitForTimeout(700);
  await shot(page, "s17-suspend");
  if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) await answerStepUp(page, owner);
  await expect(page.getByTestId(`member-status-${id}`)).toHaveAttribute("data-member-status", "SUSPENDED");

  const a = await newProfile(browser, auditor);
  await a.page.goto("/home");
  await settle(a.page);
  await shot(a.page, "s17-suspended-member");
  await expect(a.page.locator("[data-context-chip-name]")).not.toContainText("Claims Investigations");
  await a.context.close();

  await page.getByTestId(`member-restore-${id}`).click();
  await page.waitForTimeout(700);
  const confirm = page.getByRole("dialog").getByRole("button", { name: /restore/i });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.waitForTimeout(700);
  if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) await answerStepUp(page, owner);
  await expect(page.getByTestId(`member-status-${id}`)).toHaveAttribute("data-member-status", "ACTIVE");
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S18 operator suspends the customer, members are refused, operator reactivates", async ({ browser }) => {
  const op = s.people.operator!;
  const analyst = s.people.analyst!;
  const { context, page } = await newProfile(browser, op);
  await page.goto(`/admin/customers/${s.orgId}`);
  await settle(page);
  await page.getByTestId("customer-suspend-reason").fill("Unpaid invoice, acceptance");
  await page.getByTestId("customer-suspend").click();
  await page.waitForTimeout(700);
  await page.getByRole("dialog").getByRole("textbox").fill("SUSPEND");
  await page.getByRole("dialog").getByRole("button", { name: "Suspend customer" }).click();
  await answerStepUp(page, op);
  await expect(page.getByTestId("customer-resume")).toBeVisible();
  await shot(page, "s18-suspended");

  const a = await newProfile(browser, analyst);
  await a.page.goto("/home");
  await settle(a.page);
  await a.page.goto(`/evidence/${s.facts.evidenceId}`);
  await settle(a.page);
  await shot(a.page, "s18-member-refused");
  await expect(a.page.locator("main")).not.toContainText(`hull-damage-${s.runId}`);

  await page.getByTestId("customer-resume").click();
  await page.waitForTimeout(700);
  const back = page.getByRole("dialog").getByRole("button", { name: /resume/i });
  if (await back.isVisible().catch(() => false)) await back.click();
  await answerStepUp(page, op);
  await expect(page.getByTestId("customer-suspend")).toBeVisible();

  // Suspension revoked every session, so the member signs in again.
  expect(await signIn(a.page, analyst)).toBe("challenge");
  await settle(a.page);
  await switchWorkspace(a.page, "Claims Investigations");
  await a.page.goto(`/evidence/${s.facts.evidenceId}`);
  await settle(a.page);
  await expect(a.page.locator("main")).toContainText(`hull-damage-${s.runId}`);
  await keepProfile(a.context, analyst, s, "analyst");
  await a.context.close();
  await context.close();
});

test("S19 offboarding: a member leaves, with their seat freed and their access gone", async ({ browser }) => {
  const owner = s.people.owner!;
  const auditor = s.people.auditor!;
  // The suspension in S18 revoked every session of the organization.
  const { context, page } = await newProfile(browser);
  await signIn(page, owner);
  await settle(page);
  await page.goto(`/organizations/${s.orgId}/admin/members`);
  await settle(page);
  const row = page.locator("[data-membership-id]", { hasText: auditor.email });
  const id = (await row.getAttribute("data-membership-id"))!;
  await page.getByTestId(`member-remove-${id}`).click();
  await page.waitForTimeout(600);
  await shot(page, "s19-remove");
  await page.getByRole("dialog").getByRole("button", { name: /remove/i }).last().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) await answerStepUp(page, owner);
  await expect(page.getByTestId(`member-status-${id}`)).toHaveAttribute("data-member-status", "REVOKED");
  await page.goto(`/organizations/${s.orgId}/setup#billing`);
  await expect(page.locator('[data-readonly-row="billing-seats-used"]')).toContainText(String(SEATS_SOLD - 1));
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S19B bulk invite names the workspace, and the invitee lands in it", async ({ browser }) => {
  const owner = s.people.owner!;
  const invitee = person(s, "bulk", "Eva Nilsen");
  const { context, page } = await newProfile(browser, owner);
  await page.goto(`/organizations/${s.orgId}/admin/bulk-invite`);
  await settle(page);
  await page.getByTestId("bulk-invite-paste").fill(invitee.email);
  await expect(page.getByTestId("bulk-invite-workspace")).toContainText("Claims Investigations");
  await page.getByTestId("bulk-invite-workspace-role").click();
  await page.getByRole("option", { name: /^Viewer$/ }).click();
  await page.getByTestId("bulk-invite-preview").click();
  await expect(page.getByTestId("bulk-invite-preview-table")).toContainText("Would invite");
  await page.getByTestId("bulk-invite-send").click();
  await expect(page.getByTestId("bulk-invite-result-table")).toContainText(/Invited/);
  await shot(page, "s19b-bulk-sent");
  await keepProfile(context, owner, s, "owner");
  await context.close();

  await joinAndEnrol(browser, "bulk");
  const joined = await newProfile(browser, invitee);
  await joined.page.goto("/home");
  await settle(joined.page);
  await switchWorkspace(joined.page, "Claims Investigations");
  await expect(joined.page.locator("[data-context-chip-name]")).toContainText("Claims Investigations");
  await joined.context.close();
});

test("S20 Legal Hold release takes a note and a step-up, and exports return", async ({ browser }) => {
  const admin = s.people.admin!;
  const { context, page } = await newProfile(browser);
  await signIn(page, admin);
  await settle(page);
  await switchWorkspace(page, "Claims Investigations");
  await page.goto("/evidence-lifecycle/legal-holds");
  await settle(page);
  const row = page.locator("tr", { hasText: `Aurora litigation ${s.runId}` });
  await expect(row.getByText("Active")).toBeVisible();
  // The note is the product's dialog, never a browser prompt.
  page.on("dialog", (d) => {
    throw new Error(`a browser dialog opened: ${d.message()}`);
  });
  await row.getByRole("button", { name: "Release" }).click();
  const submit = page.locator("[data-confirm-action-submit]");
  await expect(submit).toBeDisabled();
  await page.locator("[data-confirm-action-reason-input]").fill("Claim settled, acceptance");
  await shot(page, "s20-release-dialog");
  await submit.click();
  await answerStepUp(page, admin);
  await expect(page.getByText("Legal hold released.")).toBeVisible();
  await expect(row.getByText("Active")).toHaveCount(0);
  await page.goto(`/evidence/${s.facts.evidenceId}`);
  await settle(page);
  await expect(page.locator('[data-evidence-action="download-report"]')).toBeEnabled();
  await expect(page.locator('[data-evidence-action="header-trash"]')).toHaveAttribute("data-evidence-trash-disabled", "false");
  await context.close();
});

test("S21 contract termination with a date: the customer is told, and the operator can withdraw it", async ({ browser }) => {
  const op = s.people.operator!;
  const { context, page } = await newProfile(browser, op);
  await page.goto(`/admin/customers/${s.orgId}`);
  await settle(page);
  await page.getByTestId("customer-terminate-reason").fill("Contract ending, acceptance");
  const inAWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await page.getByTestId("customer-terminate-date").fill(inAWeek);
  await page.getByTestId("customer-terminate").click();
  await page.getByRole("dialog").getByRole("textbox").fill("TERMINATE");
  await page.getByRole("dialog").getByRole("button", { name: "Schedule termination" }).click();
  await answerStepUp(page, op);
  await expect(page.getByText("Termination scheduled.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("customer-terminate-cancel")).toBeVisible();

  const owner = s.people.owner!;
  const o = await newProfile(browser);
  await signIn(o.page, owner);
  await settle(o.page);
  await o.page.goto(`/organizations/${s.orgId}`);
  await settle(o.page);
  await expect(o.page.locator("[data-org-closure-status]").first()).toContainText("Your contract is ending");
  await shot(o.page, "s21-owner-told");
  await keepProfile(o.context, owner, s, "owner");
  await o.context.close();

  await page.getByTestId("customer-terminate-cancel").click();
  await page.waitForTimeout(700);
  if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) await answerStepUp(page, op);
  await expect(page.getByText(/Termination withdrawn/)).toBeVisible();
  await page.reload();
  await settle(page);
  await page.getByTestId("customer-resume").click();
  await page.waitForTimeout(700);
  const back = page.getByRole("dialog").getByRole("button", { name: /resume/i });
  if (await back.isVisible().catch(() => false)) await back.click();
  await page.waitForTimeout(700);
  if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) await answerStepUp(page, op);
  await expect(page.getByTestId("customer-suspend")).toBeVisible();
  await keepProfile(context, op, s, "operator");
  await context.close();
});

test("S22 contract termination, no date: the real worker's sweep closes it, the end is final, evidence stays", async ({ browser }) => {
  const op = s.people.operator!;
  const { context, page } = await newProfile(browser, op);
  await page.goto(`/admin/customers/${s.orgId}`);
  await settle(page);
  await page.getByTestId("customer-terminate-reason").fill("Contract ended, acceptance");
  await page.getByTestId("customer-terminate").click();
  await page.getByRole("dialog").getByRole("textbox").fill("TERMINATE");
  await page.getByRole("dialog").getByRole("button", { name: "Schedule termination" }).click();
  await answerStepUp(page, op);
  await expect(page.getByText("Termination scheduled.")).toBeVisible();

  // Nothing here calls the tick: the worker's own timer does this.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("customer-contract-final")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 120_000, intervals: [4000] });
  await settle(page);
  await shot(page, "s22-after-sweep");
  await expect(page.getByTestId("customer-terminate-cancel")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("0 evidence");
  await context.close();

  // Evidence stays: the manifest after closure holds what it held before.
  const { summary } = organizationManifest(s.orgId!, "manifest-after-closure");
  console.log("manifest after closure", JSON.stringify(summary));
  expect(summary.missingObjects).toBe(0);
  expect(summary.recordCount).toBe(Number(s.facts.manifestRecordCount));
  expect(summary.objectCount).toBeGreaterThanOrEqual(Number(s.facts.manifestObjectCount));
  expect(summary.heldRecordCount).toBe(0);
});

// <next-step>
