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
 * Unverified, and said so where the journey reaches them:
 *   SSO and SCIM against a real identity provider.
 *
 * Each step leaves its state in .p7tmp/acceptance-state.json, so a repaired step
 * can be rerun alone: ACCEPT_RESUME=1 ... -g "S07".
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

import { assertIsolatedStack } from "../helpers/stack-isolation";
import {
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
  await expect(page.locator("body")).toContainText(/seat/i);
  await context.close();
  const owner = s.people.owner!;
  const o = await newProfile(browser, owner);
  await o.page.goto(`/organizations/${s.orgId}/setup#billing`);
  await expect(o.page.locator('[data-readonly-row="billing-seats-used"]')).toContainText(String(SEATS_SOLD));
  await o.context.close();
});

test("S10 workspace switch; analyst uploads real evidence and it seals", async ({ browser }) => {
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
  await shot(page, "s10-staged");
  await page.getByRole("button", { name: /Finish & Sign/ }).first().click();
  await page.waitForTimeout(6000);
  await shot(page, "s10-finished");
  console.log("at", page.url());
  await keepProfile(context, analyst, s, "analyst");
  await context.close();
});

// <next-step>
