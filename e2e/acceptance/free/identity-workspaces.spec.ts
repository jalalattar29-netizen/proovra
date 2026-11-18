/**
 * FREE PLAN ACCEPTANCE — IDENTITY, WORKSPACES, ROLES, CLOSURE.
 *
 * Runs only against the isolated acceptance stack (e2e/acceptance/stack.mjs).
 * Every person here is new and carries the `fid-` prefix; nothing created by
 * another journey file is read or changed.
 *
 *   $env:ACCEPT_STATE_NAME='free-identity'; npx playwright test \
 *     --config e2e/acceptance/playwright.config.ts free/identity-workspaces
 *
 * Labelled fixture shortcuts (each is SQL against the stack's own Postgres and is
 * named in the step title):
 *   FX-SEED     the platform operator is seeded (staff, not a customer step).
 *   FX-EXPIRE   a session is ended in the database to stand in for its expiry.
 *   FX-LEGAL    a user's stored terms acceptance is set to an older version, which
 *               is what a newer terms publication looks like to that user.
 *   FX-NOPROOF  a user's recovery codes are marked used (the user "spent" them),
 *               so the account has no trusted recovery proof left.
 *   FX-HOLDER   a verified Google-provider account row holding an address is
 *               inserted, because no Google/Apple provider exists on this stack.
 *   FX-COOLOFF  a closure request's 7-day cooling-off end is moved to the past;
 *               the worker's own lifecycle sweep then executes the closure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateRawSync, inflateSync } from "node:zlib";

import { expect, request as pwRequest, test, type Page } from "@playwright/test";

import { assertIsolatedStack } from "../../helpers/stack-isolation";
import {
  API_BASE,
  WEB_BASE,
  answerStepUp,
  keepProfile,
  linkFromMail,
  loadState,
  mailbox,
  newProfile,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  PASSWORD,
  type Person,
  registerAccount,
  saveState,
  samplePng,
  shot,
  signIn,
  signOut,
  submitPassword,
  switchWorkspace,
  totp,
  wrongCode,
} from "../lib/journey";

const s = loadState();
test.describe.configure({ mode: "serial" });

/** The seeded operator's authenticator key (seed-admin-fixture.ts, local-only). */
const OPERATOR_TOTP = "OBZG633WOJQS2ZTJPB2HK4TFFVWG6Y3BNQWW63TMPEWXI33UOAQQ";
const WS = `Fid Field Office ${s.runId}`;

function fid(key: string, name: string): Person {
  s.people[key] ??= { email: `fid-${key}.${s.runId}@fid-acceptance.example.test`, password: PASSWORD, name };
  return s.people[key]!;
}

/** Read-only or fixture SQL against the stack's own database. */
function sql(q: string): string {
  return execFileSync(
    "docker",
    ["exec", "acc-fa-postgres", "psql", "-U", "pv", "-d", "proovra_acceptance_fixture", "-At", "-c", q],
    { encoding: "utf8" },
  ).trim();
}

function userId(email: string): string {
  const id = sql(`select id from users where lower(email)=lower('${email}') order by created_at desc limit 1`);
  expect(id, `user row for ${email}`).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

type Answer = { status: number; body: string; json: any };

/** A request the page itself makes, from the web origin, with its cookies. */
async function call(page: Page, method: string, path: string, body?: unknown, workspaceId?: string): Promise<Answer> {
  const r = await page.evaluate(
    async ({ url, method, body, workspaceId }) => {
      const headers: Record<string, string> = { "x-web-client": "1" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (workspaceId) headers["x-proovra-workspace-id"] = workspaceId;
      const res = await fetch(url, { method, credentials: "include", headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.text() };
    },
    { url: `${API_BASE}${path}`, method, body, workspaceId },
  );
  let json: any = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    /* not json */
  }
  return { ...r, json };
}

function errCode(a: Answer): string | undefined {
  return a.json?.error?.code ?? a.json?.code ?? a.json?.error ?? a.json?.message;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
}

/** The session cookie the API set, for replay after the session ends. */
async function sessionCookie(page: Page): Promise<string> {
  const c = (await page.context().cookies(API_BASE)).find((x) => x.name === "proovra_session");
  expect(c, "proovra_session cookie").toBeTruthy();
  return c!.value;
}

/** Replay a cookie from a clean client (no browser): what a stolen/old cookie gets. */
async function replay(cookie: string, path = "/v1/users/me"): Promise<number> {
  const ctx = await pwRequest.newContext();
  const r = await ctx.get(`${API_BASE}${path}`, { headers: { cookie: `proovra_session=${cookie}`, "x-web-client": "1" } });
  const st = r.status();
  await ctx.dispose();
  return st;
}

function fact(key: string, value: unknown): void {
  s.facts[key] = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`[fact] ${key} = ${s.facts[key]}`);
}

/** Upload one PNG through /capture and seal it; returns the evidence id. */
async function captureRecord(page: Page, name: string, opts: { location?: boolean } = {}): Promise<string> {
  await page.goto("/capture");
  await settle(page);
  if (opts.location) {
    const toggle = page.locator("input[data-capture-location-toggle]");
    if (!(await toggle.isVisible().catch(() => false))) await page.locator("[data-capture-setup-toggle]").first().click();
    await expect(toggle).toBeVisible();
    if (!(await toggle.isChecked())) await toggle.check({ force: true });
    await expect(page.locator("[data-capture-location-check]")).not.toContainText(/off/i, { timeout: 20_000 });
  }
  await page.locator('input[type="file"][aria-label="Upload evidence files"]').setInputFiles({
    name,
    mimeType: "image/png",
    buffer: samplePng(`${s.runId}-${name}`),
  });
  await expect(page.getByText("1 material added").first()).toBeVisible();
  await page.getByRole("button", { name: "Review & Sign", exact: true }).last().click();
  await page.locator("[data-capture-review-confirm]").click();
  await page.waitForURL(/\/evidence\/[0-9a-f-]{36}/, { timeout: 60_000 });
  return page.url().match(/evidence\/([0-9a-f-]{36})/)![1]!;
}

async function waitReported(page: Page, id: string): Promise<void> {
  await page.goto(`/evidence/${id}`);
  await expect(async () => {
    await page.reload();
    await expect(page.locator('[data-evidence-action="download-report"]')).toBeEnabled({ timeout: 3000 });
    await expect(page.getByText("Reported").first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 150_000, intervals: [3000] });
}

test.beforeAll(async () => {
  // Fail closed: nothing runs against a stack that could reach a live service.
  await assertIsolatedStack();
});
test.afterEach(() => saveState(s));

// ---------------------------------------------------------------------------
// Journey 1 — register, verify, login, logout, session expiry, revocation
// ---------------------------------------------------------------------------

test("S01 J1 register, verify from the mailbox, land on home; sign out revokes the server session", async ({ browser }) => {
  const free = fid("free", "Freya Fidd");
  const { context, page } = await newProfile(browser);
  await registerAccount(page, free);
  await settle(page);
  await expect(page.locator("[data-app-context-chip]")).toBeVisible();
  const verifyMail = mailbox(free.email).find((m) => /verify/i.test(`${m.subject} ${m.actionableLink}`));
  fact("j1.verifyMailSubject", verifyMail?.subject ?? "");
  const id = userId(free.email);
  fact("j1.freeUserId", id);
  expect(sql(`select email_verified_at is not null from users where id='${id}'`)).toBe("t");
  await shot(page, "fid-s01-home-after-verify");

  // Sign out from the account menu; the old cookie is refused afterwards.
  const before = await sessionCookie(page);
  expect(await replay(before)).toBe(200);
  await signOut(page);
  const after = await replay(before);
  fact("j1.oldCookieAfterSignOut", after);
  expect(after).toBe(401);
  const row = sql(
    `select revoked_reason from authenticated_sessions where user_id='${id}' and revoked_at_utc is not null order by revoked_at_utc desc limit 1`,
  );
  fact("j1.revokedReason", row);
  expect(row).toMatch(/LOGOUT/i);
  await page.goto("/home");
  await settle(page);
  await expect(page.locator("[data-signed-out-app-state]")).toBeVisible();
  await shot(page, "fid-s01-signed-out");

  // Sign in again with the password: no MFA yet, straight in.
  expect(await signIn(page, free)).toBe("password");
  await settle(page);
  await expect(page.locator("[data-app-context-chip]")).toBeVisible();
  await keepProfile(context, free, s, "free");
  await context.close();
});

test("S02 J1 session expiry [FX-EXPIRE]: an ended session returns the person to sign-in cleanly", async ({ browser }) => {
  const free = s.people.free!;
  const { context, page } = await newProfile(browser, free);
  await page.goto("/home");
  await settle(page);
  await expect(page.locator("[data-app-context-chip]")).toBeVisible();
  const uid = userId(free.email);
  const live = sql(
    `select id from authenticated_sessions where user_id='${uid}' and revoked_at_utc is null order by issued_at_utc desc limit 1`,
  );
  expect(live).toMatch(/^[0-9a-f-]{36}$/);
  const cookie = await sessionCookie(page);

  // (a) The row's expiry column moved to the past.
  sql(`update authenticated_sessions set expires_at_utc = now() - interval '1 minute' where id='${live}'`);
  const afterExpiryColumn = await replay(cookie);
  fact("j1.statusAfterExpiresAtInPast", afterExpiryColumn);

  // (b) The session ended server-side (what the expiry sweep / revocation does).
  sql(`update authenticated_sessions set revoked_at_utc = now(), revoked_reason='FIXTURE_EXPIRY' where id='${live}'`);
  await expect.poll(() => replay(cookie), { timeout: 20_000 }).toBe(401);

  // The open page: a client-side navigation now meets the ended session.
  await page.locator('a[href="/evidence"]').first().click().catch(() => undefined);
  await page.waitForTimeout(2500);
  const ended = page.locator("[data-session-ended-notice], [data-signed-out-app-state]");
  await expect(ended.first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "fid-s02-session-ended-open-page");
  fact("j1.openPageState", (await page.locator("[data-session-ended-notice]").count()) > 0 ? "session-ended-notice" : "signed-out-app-state");

  // A fresh load: the signed-out state, nothing of the account, and a way to sign in.
  await page.goto("/home");
  await settle(page);
  await expect(page.locator("[data-signed-out-app-state]")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(free.email);
  await shot(page, "fid-s02-signed-out");
  await page.getByTestId("signed-out-sign-in").click();
  await page.waitForURL(/\/login/);
  fact("j1.signInUrlAfterExpiry", new URL(page.url()).pathname + new URL(page.url()).search);
  expect(await signIn(page, free)).toBe("password");
  await settle(page);
  await expect(page.locator("[data-app-context-chip]")).toBeVisible();
  await keepProfile(context, free, s, "free");
  await context.close();
});

// ---------------------------------------------------------------------------
// Journey 2 — legal re-acceptance
// ---------------------------------------------------------------------------

test("S03 J2 legal re-acceptance [FX-LEGAL]: writes refused (428) until accepted, then succeed; documents public", async ({ browser }) => {
  const free = s.people.free!;
  const uid = userId(free.email);
  const versions = sql(`select policy_key||'='||policy_version from user_legal_acceptances where user_id='${uid}' order by 1`);
  fact("j2.acceptedBefore", versions.replace(/\n/g, ","));
  sql(`update user_legal_acceptances set policy_version='2026-01-01' where user_id='${uid}' and policy_key='terms'`);

  const { context, page } = await newProfile(browser, free);
  await page.goto("/home");
  await settle(page);
  const step = page.locator("[data-legal-step]");
  await expect(step).toBeVisible();
  await shot(page, "fid-s03-legal-step");
  const status = await call(page, "GET", "/v1/users/legal-status");
  fact("j2.legalStatus", status.json);
  expect(status.json.requiresReacceptance).toBe(true);
  expect(status.json.missingPolicies).toEqual(expect.arrayContaining(["terms"]));

  // A write is refused while acceptance is owed.
  const refused = await call(page, "POST", "/v1/cases", { name: `fid legal probe ${s.runId}` });
  fact("j2.writeWhileOwed", { status: refused.status, code: errCode(refused) });
  expect(refused.status).toBe(428);
  expect(errCode(refused)).toBe("LEGAL_REACCEPT_REQUIRED");

  // "Not now", then a real product write from the UI: the step comes back mid-action.
  await page.locator("[data-legal-step-dismiss]").click();
  await expect(step).toHaveCount(0);
  await page.goto("/capture");
  await settle(page);
  if (!(await step.isVisible().catch(() => false))) {
    await page.locator('input[type="file"][aria-label="Upload evidence files"]').setInputFiles({
      name: `fid-legal-${s.runId}.png`,
      mimeType: "image/png",
      buffer: samplePng(`${s.runId}-legal`),
    });
    await page.getByRole("button", { name: "Review & Sign", exact: true }).last().click().catch(() => undefined);
    await page.locator("[data-capture-review-confirm]").click().catch(() => undefined);
  }
  await expect(step).toBeVisible({ timeout: 30_000 });
  await shot(page, "fid-s03-legal-step-mid-action");

  // The terms are reachable from the step and publicly.
  for (const slug of ["terms", "privacy", "cookies"]) {
    const res = await page.request.get(`${WEB_BASE}/legal/${slug}`);
    expect(res.status(), slug).toBe(200);
    expect(await res.text()).toMatch(/Last Updated/i);
  }
  const api = await page.request.get(`${API_BASE}/v1/legal/terms`);
  expect(api.status()).toBe(200);

  await expect(page.locator("[data-legal-step-accept]")).toBeDisabled();
  await page.locator("[data-legal-step-agree]").check();
  await page.locator("[data-legal-step-accept]").click();
  await expect(step).toHaveCount(0, { timeout: 20_000 });
  const after = await call(page, "GET", "/v1/users/legal-status");
  expect(after.json.requiresReacceptance).toBe(false);
  const ok = await call(page, "POST", "/v1/cases", { name: `fid legal probe ${s.runId}` });
  fact("j2.writeAfterAccept", { status: ok.status, code: errCode(ok) });
  expect(ok.status, ok.body.slice(0, 300)).not.toBe(428);
  expect(sql(`select policy_version from user_legal_acceptances where user_id='${uid}' and policy_key='terms'`)).not.toBe("2026-01-01");
  await keepProfile(context, free, s, "free");
  await context.close();
});

// ---------------------------------------------------------------------------
// Journey 5 — Free personal workspace
// ---------------------------------------------------------------------------

test("S04 J5 Free home: meters visible; upgrade and support destinations resolve", async ({ browser }) => {
  const free = s.people.free!;
  const { context, page } = await newProfile(browser, free);
  await page.goto("/home");
  await settle(page);
  await expect(page.locator('[data-self-serve-home][data-self-serve-plan="FREE"]')).toBeVisible();
  await expect(page.locator("[data-home-kpi-row]")).toBeVisible();
  const allowance = page.locator('a[data-home-kpi="allowance"]');
  await expect(allowance).toBeVisible();
  fact("j5.allowanceText", (await allowance.innerText()).replace(/\s+/g, " "));
  await expect(page.locator("[data-sidebar-storage]:visible").first()).toBeVisible();
  await expect(page.locator('[data-sidebar-storage]:visible [role=progressbar][aria-label="Storage used"]').first()).toBeVisible();
  fact("j5.storageDetail", await page.locator("[data-sidebar-storage-detail]:visible").first().innerText());
  await shot(page, "fid-s04-free-home");

  const links = new Map<string, string>();
  for (const sel of ["a[data-intake-upgrade]", 'a[data-home-kpi="allowance"]', "a.app-sidebar-v2-help"]) {
    const a = page.locator(sel).first();
    if (await a.count()) links.set(sel, (await a.getAttribute("href")) ?? "");
  }
  fact("j5.homeLinks", Object.fromEntries(links));
  expect([...links.values()].some((h) => h.startsWith("/billing"))).toBe(true);
  expect([...links.values()].some((h) => h.startsWith("/support"))).toBe(true);

  await allowance.click();
  await page.waitForURL(/\/billing/);
  await settle(page);
  await expect(page.locator("main")).not.toContainText(/Something went wrong|not found/i);
  await expect(page.locator("[data-billing-plan-management]").first()).toBeVisible();
  await shot(page, "fid-s04-billing");
  const billingLinks: Record<string, string | null> = {};
  for (const sel of ["a[data-billing-view-pricing]", "a[data-billing-support-action]"]) {
    billingLinks[sel] = await page.locator(sel).first().getAttribute("href").catch(() => null);
  }
  fact("j5.billingLinks", billingLinks);
  for (const href of new Set(["/support", "/pricing", ...Object.values(billingLinks).filter((h): h is string => !!h)])) {
    const p2 = await context.newPage();
    const res = await p2.goto(href);
    expect(res?.status(), href).toBeLessThan(400);
    await settle(p2);
    await expect(p2.locator("h1").first()).toBeVisible();
    await expect(p2.locator("body")).not.toContainText(/404|page could not be found/i);
    await shot(p2, `fid-s04-dest-${href.replace(/\W+/g, "_")}`);
    await p2.close();
  }
  // "Choose a plan" leads somewhere real (no provider exists; we only check the destination resolves).
  const choose = page.locator('[data-billing-plan-management="CHOOSE"]').first();
  if (await choose.isVisible().catch(() => false)) {
    await choose.click();
    await page.waitForTimeout(1500);
    await settle(page);
    fact("j5.choosePlanLandsOn", new URL(page.url()).pathname);
    await shot(page, "fid-s04-choose-plan");
    await expect(page.locator("body")).not.toContainText(/page could not be found/i);
  }
  await keepProfile(context, free, s, "free");
  await context.close();
});

// ---------------------------------------------------------------------------
// Journey 3 — MFA
// ---------------------------------------------------------------------------

/** Settings enrolment of a TOTP factor, as a person does it. */
async function enrolInSettings(page: Page, p: Person): Promise<void> {
  await page.goto("/settings#security");
  await settle(page);
  await page.locator("[data-cc-mfa-enroll-start]").click();
  await expect(page.locator("[data-cc-mfa-enrolling]")).toBeVisible();
  p.totpSecret = (await page.locator("[data-cc-mfa-manual-secret]").innerText()).trim();
  await page.locator("[data-cc-mfa-verify-code]").fill(await totp(p));
  await page.locator("[data-cc-mfa-verify-submit]").click();
  await expect(page.locator("[data-cc-mfa-recovery-codes]")).toBeVisible();
  p.recoveryCodes = (await page.locator("[data-cc-mfa-recovery-codes] li").allInnerTexts()).map((c) => c.trim());
  expect(p.recoveryCodes.length).toBeGreaterThan(0);
  await page.locator("[data-cc-mfa-codes-acknowledge]").check();
  await page.locator("[data-cc-mfa-codes-done]").click();
  await expect(page.locator("[data-cc-mfa-card]")).toContainText("enabled");
}

const RECOVERY_TOGGLE = '[data-cc-mfa-toggle="use-recovery"], [data-cc-mfa-switch="recovery_code"]';

test("S05 J3 MFA: enrol TOTP, wrong code refused, challenge passes; a recovery code works once", async ({ browser }) => {
  const free = s.people.free!;
  const { context, page } = await newProfile(browser, free);
  const uid = userId(free.email);
  // Resumable: a run that already spent a recovery code continues from the reuse check.
  if (!s.facts["j3.usedRecoveryCode"]) {
  if (!free.totpSecret) {
    await enrolInSettings(page, free);
    fact("j3.recoveryCodeCount", free.recoveryCodes!.length);
    await shot(page, "fid-s05-mfa-enabled");
    saveState(s);
  } else await page.goto("/home");
  await settle(page);
  if (await page.locator("[data-app-topbar-account] button").first().isVisible().catch(() => false)) await signOut(page);
  await submitPassword(page, free.email, free.password);
  await page.waitForURL(/\/auth\/mfa-challenge/, { timeout: 30_000 });
  await settle(page);
  await page.locator('input[name="code"]').fill(wrongCode(free));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.locator("[data-cc-mfa-error]")).toContainText("did not match");
  await shot(page, "fid-s05-wrong-code");
  await page.locator('input[name="code"]').fill(await totp(free));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/mfa-challenge"), { timeout: 30_000 });
  await settle(page);
  await expect(page.locator("[data-app-context-chip]")).toBeVisible();

  // A recovery code at the challenge.
  await signOut(page);
  await page.waitForTimeout(600);
  await submitPassword(page, free.email, free.password);
  await page.waitForURL(/\/auth\/mfa-challenge/, { timeout: 30_000 });
  await settle(page);
  const code = free.recoveryCodes!.shift()!;
  fact("j3.usedRecoveryCode", code);
  await page.locator(RECOVERY_TOGGLE).first().click();
  await page.locator('input[name="recoveryCode"]').fill(code);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/mfa-challenge"), { timeout: 30_000 });
  await settle(page);
  await expect(page.locator("[data-app-context-chip]")).toBeVisible();
  fact("j3.usedRecoveryCodesInDb", sql(`select count(*) from mfa_recovery_codes where user_id='${uid}' and used_at is not null`));
  await signOut(page);
  }
  const code = s.facts["j3.usedRecoveryCode"]!;

  // The same code a second time is refused. (The challenge allows 5 attempts a minute per user: pace.)
  await page.waitForTimeout(61_000);
  await page.goto("/login");
  await submitPassword(page, free.email, free.password);
  await page.waitForURL(/\/auth\/mfa-challenge/, { timeout: 30_000 });
  await settle(page);
  await page.locator(RECOVERY_TOGGLE).first().click();
  await page.locator('input[name="recoveryCode"]').fill(code);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.locator("[data-cc-mfa-error]")).toContainText("not accepted");
  await shot(page, "fid-s05-recovery-reused");
  await page.locator('[data-cc-mfa-toggle="use-totp"], [data-cc-mfa-switch="totp"]').first().click().catch(() => undefined);
  await page.locator('input[name="code"]').fill(await totp(free));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/mfa-challenge"), { timeout: 30_000 });
  await settle(page);

  // Personal recovery request, signed in: a personal workspace has no other approver.
  const teamId = sql(`select current_workspace_id from users where id='${uid}'`);
  fact("j3.personalWorkspaceId", teamId);
  const req = await call(page, "POST", "/v1/identity/mfa-admin/recovery-requests", { teamId, reason: "Lost my phone with the authenticator app on it." });
  fact("j3.personalRecoveryRequest", { status: req.status, body: req.json });
  expect(req.status).toBe(409);
  expect(JSON.stringify(req.json)).toContain("no_eligible_approver");
  expect(Number(sql(`select count(*) from mfa_recovery_requests where user_id='${uid}'`))).toBe(0);
  await keepProfile(context, free, s, "free");
  await context.close();
});

test("S06 J3 no trusted recovery proof left [FX-NOPROOF]: no email-only or support bypass unlocks the account", async ({ browser }) => {
  const lock = fid("lock", "Lars Lockett");
  const { context, page } = await newProfile(browser);
  if (!s.facts["j3.lockReady"]) {
    await registerAccount(page, lock);
    await settle(page);
    await enrolInSettings(page, lock);
    saveState(s);
    // The person spends every recovery code and loses the authenticator.
    sql(`update mfa_recovery_codes set used_at = now() where user_id='${userId(lock.email)}' and used_at is null`);
    fact("j3.lockReady", "1");
    await signOut(page);
    await page.waitForTimeout(600);
  }
  const uid = userId(lock.email);
  lock.password = s.facts["j3.lockResetDone"] ? `${PASSWORD}-reset` : PASSWORD;

  await submitPassword(page, lock.email, lock.password);
  await page.waitForURL(/\/auth\/mfa-challenge/, { timeout: 30_000 });
  await settle(page);
  await page.locator(RECOVERY_TOGGLE).first().click();
  await page.locator('input[name="recoveryCode"]').fill(lock.recoveryCodes![0]!);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.locator("[data-cc-mfa-error]")).toContainText("not accepted");
  // The recovery request panel: no session, so nothing can be filed, and support cannot help.
  const panel = page.locator("[data-cc-mfa-recovery-request-panel]");
  await expect(panel).toBeVisible();
  fact("j3.panelEligibility", (await panel.getAttribute("data-cc-mfa-recovery-eligibility")) ?? "");
  await expect(panel).toHaveAttribute("data-cc-mfa-recovery-eligibility", /no_session|no_workspace/);
  await expect(panel).toContainText("PROOVRA support cannot remove a second factor");
  await expect(page.locator("[data-cc-mfa-recovery-request-submit]")).toBeDisabled();
  await shot(page, "fid-s06-no-proof-challenge");
  // The API refuses the half-signed-in (MFA-pending) state for a recovery request.
  const pendingReq = await call(page, "POST", "/v1/identity/mfa-admin/recovery-requests", { teamId: sql(`select current_workspace_id from users where id='${uid}'`), reason: "Lost authenticator and codes" });
  fact("j3.recoveryRequestWhilePending", { status: pendingReq.status, code: errCode(pendingReq) });
  expect(pendingReq.status).toBe(401);
  const methods = await page.locator("[data-cc-mfa-switch]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cc-mfa-switch")));
  fact("j3.challengeMethodsOffered", methods);
  expect(methods.filter((m) => m && !["totp", "recovery_code"].includes(m))).toEqual([]);
  const supportHref = await page.getByRole("link", { name: /support/i }).first().getAttribute("href", { timeout: 3000 }).catch(() => null);
  fact("j3.supportLinkOnChallenge", supportHref ?? "(none)");

  // The email-only path: a password reset does not remove the second factor.
  await page.goto("/login?forgot=1");
  await settle(page);
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="email"]').fill(lock.email);
  await dialog.locator('button[type="submit"]').click();
  const reset = await linkFromMail(lock.email, /reset/i);
  fact("j3.resetMailLinkPath", new URL(reset).pathname);
  await page.goto(reset);
  await settle(page);
  lock.password = `${PASSWORD}-reset`;
  await page.locator("#reset-password-new").fill(lock.password);
  await page.locator("#reset-password-confirm").fill(lock.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2500);
  fact("j3.lockResetDone", "1");
  await shot(page, "fid-s06-reset-done");
  expect(Number(sql(`select count(*) from mfa_factors where user_id='${uid}' and status='ACTIVE'`))).toBeGreaterThan(0);
  await submitPassword(page, lock.email, lock.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  expect(new URL(page.url()).pathname, "after a reset the factor is still demanded").toBe("/auth/mfa-challenge");
  await expect(page.locator("[data-app-context-chip]")).toHaveCount(0);
  const me = await call(page, "GET", "/v1/users/me");
  fact("j3.meAfterResetWithoutFactor", me.status);
  expect(me.status).toBe(401);
  await shot(page, "fid-s06-still-challenged");
  await context.close();
});

// ---------------------------------------------------------------------------
// Journey 4 — social account linking (provider unavailable here)
// ---------------------------------------------------------------------------

test("S07 J4 existing-account guidance [FX-HOLDER]: verified holder => 409 EXISTING_ACCOUNT_SIGN_IN_REQUIRED and the verify page's card", async ({ browser, request }) => {
  const late = fid("social", "Sol Socia");
  const { context, page } = await newProfile(browser);
  await page.goto("/register");
  await page.locator('input[placeholder="Email"]:visible').first().fill(late.email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(late.password);
  await page.locator('input[placeholder="Confirm password"]:visible').first().fill(late.password);
  await page.locator("input.auth-legal-checkbox:visible").first().check();
  await page.locator('[data-auth-email-cta="REGISTER"]:visible').first().click();
  await expect(page.getByRole("heading", { name: "Verify your email address" })).toBeVisible();
  const link = await linkFromMail(late.email, /verify/i);
  // Meanwhile a Google sign-in verified the same address (no provider here: a row stands in).
  sql(
    `insert into users (id,email,provider,provider_user_id,email_verified_at,created_at,updated_at) values (gen_random_uuid(),'${late.email}','GOOGLE','fid-fixture-google-${s.runId}',now(),now(),now())`,
  );
  await page.goto(link);
  await page.locator('input[type="password"]:visible').first().fill(late.password);
  await page.getByRole("button", { name: "Verify my email" }).click();
  const card = page.getByTestId("verify-existing-account");
  await expect(card).toBeVisible();
  fact("j4.cardText", (await card.innerText()).replace(/\s+/g, " ").slice(0, 300));
  const cardLinks = await card.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  fact("j4.cardLinks", cardLinks);
  await shot(page, "fid-s07-existing-account-card");
  const token = new URL(link).searchParams.get("token");
  const r = await request.post(`${API_BASE}/v1/auth/email/verify`, { data: { token, password: late.password } });
  const body = await r.json().catch(() => ({}));
  fact("j4.verifyApi", { status: r.status(), body });
  expect(r.status()).toBe(409);
  expect(body?.error?.code ?? body?.code).toBe("EXISTING_ACCOUNT_SIGN_IN_REQUIRED");
  expect(sql(`select count(*) from users where lower(email)=lower('${late.email}') and provider='EMAIL' and email_verified_at is null`)).toBe("1");
  const g = await request.post(`${API_BASE}/v1/auth/google`, { data: { idToken: "not-a-real-google-token" } });
  fact("j4.googleWithoutProvider", { status: g.status(), body: (await g.text()).slice(0, 200) });
  expect(g.status()).toBeGreaterThanOrEqual(400);
  await context.close();
});

// ---------------------------------------------------------------------------
// Journey 6 — a Free account in a paid workspace
// ---------------------------------------------------------------------------

/** Exact capture location the owner's browser reports (Oslo harbour). */
const GEO = { latitude: 59.913868, longitude: 10.752245, accuracy: 8 };

/** Minimal ZIP reader (central directory; stored/deflate entries). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const xlen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString("utf8");
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    off += 46 + nlen + xlen + clen;
  }
  return out;
}

/** Every latitude/longitude-looking value in the text entries of a ZIP. */
function coordinatesIn(entries: Map<string, Buffer>): { file: string; key: string; value: string }[] {
  const hits: { file: string; key: string; value: string }[] = [];
  for (const [file, data] of entries) {
    if (!/\.(json|txt|csv|xml|html?|md)$/i.test(file)) continue;
    const text = data.toString("utf8");
    for (const m of text.matchAll(/"?(lat|lng|lon|latitude|longitude)"?\s*[:=]\s*"?(\[withheld\]|-?\d+(?:\.\d+)?)/gi)) {
      hits.push({ file, key: m[1]!, value: m[2]! });
    }
  }
  return hits;
}

/** Text of a PDF's deflated streams, for a coarse "does it say X" check. */
function pdfText(buf: Buffer): string {
  const parts: string[] = [buf.toString("latin1")];
  let i = 0;
  for (;;) {
    const a = buf.indexOf("stream", i, "latin1");
    if (a < 0) break;
    let start = a + 6;
    if (buf[start] === 0x0d) start += 1;
    if (buf[start] === 0x0a) start += 1;
    const end = buf.indexOf("endstream", start, "latin1");
    if (end < 0) break;
    try {
      parts.push(inflateSync(buf.subarray(start, end)).toString("latin1"));
    } catch {
      /* not deflate */
    }
    i = end + 9;
  }
  return parts.join("\n");
}

function teamId(): string {
  return s.facts.wsId ?? (s.facts.wsId = sql(`select id from teams where name='${WS}' order by created_at desc limit 1`));
}

function memberRowId(email: string): string {
  return sql(`select tm.id from team_members tm join users u on u.id=tm.user_id where tm.team_id='${teamId()}' and lower(u.email)=lower('${email}')`);
}

async function signedInProfile(browser: import("@playwright/test").Browser, key: string) {
  const p = s.people[key]!;
  const prof = await newProfile(browser, p);
  await prof.page.goto("/home");
  await settle(prof.page);
  if (await prof.page.locator("[data-signed-out-app-state]").isVisible().catch(() => false)) {
    await signIn(prof.page, p);
    await settle(prof.page);
  }
  return prof;
}

test("S08 J6 [FX-SEED] operator provisions a paid customer; its owner is invited by email", async ({ browser }) => {
  const op = (s.people.operator ??= { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD, name: "Platform operator" });
  op.totpSecret = OPERATOR_TOTP;
  const owner = fid("owner", "Olga Owens");
  s.company = `Fid Paid Customer ${s.runId}`;
  const { context, page } = await newProfile(browser);
  await signIn(page, op);
  await page.goto("/admin/provisioning");
  await settle(page);
  await page.getByTestId("provision-org-name").fill(s.company);
  await page.getByTestId("provision-owner-email").fill(owner.email);
  await page.getByTestId("provision-seats").fill("3");
  await page.getByTestId("provision-workspace-name").fill(WS);
  await page.getByTestId("provision-submit").click();
  await page.getByRole("dialog").getByRole("button", { name: /Provision customer/ }).click();
  await answerStepUp(page, op);
  const pending = page.getByTestId("provision-success-pending");
  await expect(pending).toBeVisible();
  s.orgId = (await pending.innerText()).match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
  expect(s.orgId).toBeTruthy();
  fact("j6.orgId", s.orgId!);
  await shot(page, "fid-s08-provisioned");
  await context.close();
  fact("j6.ownerInviteLink", await linkFromMail(owner.email, /invite/i));
});

test("S09 J6 owner joins, holds a factor, and invites the Free user and a peer by email", async ({ browser }) => {
  const owner = s.people.owner!;
  const { context, page } = await newProfile(browser);
  await registerAccount(page, owner);
  await page.goto(s.facts["j6.ownerInviteLink"]!);
  await page.locator('[data-action="accept-invite"]').click();
  await page.waitForURL(/\/organizations\/[^/]+\/setup/, { timeout: 30_000 });
  await enrolInSettings(page, owner);
  saveState(s);
  fact("j6.orgPlan", sql(`select coalesce(billing_plan::text,'') from teams where id='${teamId()}'`));
  await page.goto(`/organizations/${s.orgId}/setup#invite`);
  await expect(page.locator('[data-page="organization-setup-wizard"]')).toHaveAttribute("data-step-id", "invite");
  for (const [key, name] of [["free", ""], ["peer", "Petra Peer"]] as const) {
    const p = key === "free" ? s.people.free! : fid(key, name);
    await page.locator('[data-input="invite-email"]').fill(p.email);
    await page.locator('[data-input="invite-workspace-access"]').click();
    await page.getByRole("option", { name: /^Member$/ }).click();
    await page.locator('[data-action="send-invite"]').click();
    await expect(page.locator("[data-invited-count]")).toContainText(p.email.split("@")[0]!.slice(0, 8), { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
  await expect(page.locator("[data-invited-count]")).toHaveAttribute("data-invited-count", "2");
  await shot(page, "fid-s09-invites");
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S10 J6 the Free user accepts from the mailbox; the peer joins with a new account", async ({ browser }) => {
  const free = s.people.free!;
  const link = await linkFromMail(free.email, /invite/i);
  fact("j6.freeInviteSubject", mailbox(free.email).reverse().find((m) => /invite/i.test(`${m.subject} ${m.actionableLink}`))?.subject ?? "");
  const { context, page } = await signedInProfile(browser, "free");
  await page.goto(link);
  await page.locator('[data-action="accept-invite"]').click();
  await expect(page.locator('[data-state="accepted"]')).toBeVisible();
  await shot(page, "fid-s10-free-accepted");
  // The Free personal plan is unchanged by joining a paid workspace.
  expect(sql(`select role||'/'||status from team_members where id='${memberRowId(free.email)}'`)).toMatch(/^MEMBER\/ACTIVE$/);
  await keepProfile(context, free, s, "free");
  await context.close();

  const peer = s.people.peer!;
  const p = await newProfile(browser);
  const plink = await linkFromMail(peer.email, /invite/i);
  await registerAccount(p.page, peer);
  await p.page.goto(plink);
  await p.page.locator('[data-action="accept-invite"]').click();
  await expect(p.page.locator('[data-state="accepted"]')).toBeVisible();
  await keepProfile(p.context, peer, s, "peer");
  await p.context.close();
});

test("S11 J6/J7 owner captures two records in the paid workspace, one with exact browser location", async ({ browser }) => {
  const owner = s.people.owner!;
  const { context, page } = await signedInProfile(browser, "owner");
  await context.grantPermissions(["geolocation"], { origin: new URL(page.url()).origin });
  await context.setGeolocation(GEO);
  await switchWorkspace(page, WS);
  const r1 = await captureRecord(page, `fid-located-${s.runId}.png`, { location: true });
  fact("j7.locatedId", r1);
  const r2 = await captureRecord(page, `fid-plain-${s.runId}.png`);
  fact("j6.plainId", r2);
  await waitReported(page, r1);
  await waitReported(page, r2);
  const stored = sql(`select lat||','||lng||','||coalesce(location_source::text,'') from evidence where id='${r1}'`);
  fact("j7.storedLocation", stored);
  expect(stored).toMatch(/^59\.91/);
  expect(sql(`select team_id from evidence where id='${r1}'`)).toBe(teamId());
  await shot(page, "fid-s11-located-reported");
  await keepProfile(context, owner, s, "owner");
  await context.close();
});

test("S12 J6 workspace switching both ways shows each workspace's own records", async ({ browser }) => {
  const free = s.people.free!;
  const { context, page } = await signedInProfile(browser, "free");
  await switchWorkspace(page, WS);
  await page.goto("/evidence");
  await settle(page);
  await expect(page.locator(`li[data-evidence-row="${s.facts["j6.plainId"]}"]`)).toBeVisible();
  await shot(page, "fid-s12-paid-library");
  await page.locator("[data-app-context-chip] button").first().click();
  await page.locator('[data-context-group="PERSONAL"] [data-context-option]').first().click();
  const proceed = page.locator("[data-context-switch-confirm-proceed]");
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
  await expect(page.locator("[data-context-chip-name]")).toContainText(/Personal/);
  await page.goto("/evidence");
  await settle(page);
  await expect(page.locator(`li[data-evidence-row="${s.facts["j6.plainId"]}"]`)).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(`fid-plain-${s.runId}`);
  await shot(page, "fid-s12-personal-library");
  await page.reload();
  await settle(page);
  await expect(page.locator("[data-context-chip-name]")).toContainText(/Personal/);
  await switchWorkspace(page, WS);
  await page.goto("/evidence");
  await settle(page);
  await expect(page.locator(`li[data-evidence-row="${s.facts["j6.plainId"]}"]`)).toBeVisible();
  await keepProfile(context, free, s, "free");
  await context.close();
});

/** Owner changes a member's workspace role on /teams/<id>, answering the step-up. */
async function setRole(page: Page, email: string, label: "Viewer" | "Member"): Promise<void> {
  const rowId = memberRowId(email);
  await page.goto(`/teams/${teamId()}`);
  await settle(page);
  await page.locator(`button#member-role-${rowId}`).click();
  await page.getByRole("option", { name: new RegExp(`^${label}$`) }).click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) await answerStepUp(page, s.people.owner!);
  else {
    const input = page.locator("[data-step-up-code-input]");
    if (await input.isVisible().catch(() => false)) {
      await input.fill(await totp(s.people.owner!));
      await page.locator("[data-step-up-verify]").click();
    }
  }
  const dbRole = label === "Viewer" ? "VIEWER" : "MEMBER";
  await expect.poll(() => sql(`select role from team_members where id='${rowId}'`), { timeout: 20_000 }).toBe(dbRole);
}

test("S13 J6 role change Contributor(Member) -> Viewer -> back takes effect for the member without stale UI", async ({ browser }) => {
  const free = s.people.free!;
  const m = await signedInProfile(browser, "free");
  await switchWorkspace(m.page, WS);
  await m.page.goto("/capture");
  await settle(m.page);
  await expect(m.page.locator('input[type="file"][aria-label="Upload evidence files"]')).toBeAttached();

  const o = await signedInProfile(browser, "owner");
  await setRole(o.page, free.email, "Viewer");
  await shot(o.page, "fid-s13-owner-set-viewer");

  // The member's page that was open before the change: navigate inside the app.
  await m.page.locator('[data-sidebar-nav-id="workspace.evidence"] a, a[href="/evidence"]').first().click().catch(() => undefined);
  await settle(m.page);
  await m.page.locator('[data-sidebar-nav-id="workspace.capture"] a, a[href="/capture"]').first().click().catch(() => undefined);
  await settle(m.page);
  const gateNoReload = await m.page.locator('[data-testid="route-gate-workspace.capture"]').getAttribute("data-page-route-gate-state").catch(() => null);
  fact("j6.captureGateWithoutReload", gateNoReload ?? "(no gate rendered: capture surface still offered)");
  await shot(m.page, "fid-s13-member-no-reload");
  // What the server says, whatever the page shows.
  const create = await call(m.page, "GET", "/v1/platform/context", undefined, teamId());
  fact("j6.contextRoleAfterChange", create.json?.currentWorkspace?.role ?? create.json?.workspace?.role ?? JSON.stringify(create.json).match(/"role":"[A-Z_]+"/g)?.slice(0, 3).join(","));
  await m.page.reload();
  await settle(m.page);
  await expect(m.page.locator('[data-testid="route-gate-workspace.capture"]')).toHaveAttribute("data-page-route-gate-state", "DENIED_NO_CAPABILITY");
  await shot(m.page, "fid-s13-member-viewer-capture-denied");

  await setRole(o.page, free.email, "Member");
  await m.page.reload();
  await settle(m.page);
  await expect(m.page.locator('[data-testid="route-gate-workspace.capture"][data-page-route-gate-state="DENIED_NO_CAPABILITY"]')).toHaveCount(0);
  await expect(m.page.locator('input[type="file"][aria-label="Upload evidence files"]')).toBeAttached();
  await keepProfile(o.context, s.people.owner!, s, "owner");
  await keepProfile(m.context, free, s, "free");
  await o.context.close();
  await m.context.close();
});

test("S13B J6 stale role window: a demoted member's already-open app, used without reload", async ({ browser }) => {
  const free = s.people.free!;
  const m = await signedInProfile(browser, "free");
  await switchWorkspace(m.page, WS);
  await m.page.goto("/evidence");
  await settle(m.page);
  const link = m.page.locator('a[data-sidebar-nav-id="workspace.capture"]').first();
  fact("j6.sidebarCaptureStateBefore", (await link.getAttribute("data-sidebar-access-state")) ?? "");

  const o = await signedInProfile(browser, "owner");
  await setRole(o.page, free.email, "Viewer");

  // No reload: wait past the focus-refresh throttle and re-focus the tab, as a person returning to it.
  await m.page.bringToFront();
  await m.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await m.page.waitForTimeout(1500);
  fact("j6.sidebarCaptureStateAfterNoReload", (await link.getAttribute("data-sidebar-access-state")) ?? "");
  await link.click();
  await m.page.waitForURL(/\/capture/);
  await settle(m.page);
  const gate = await m.page.locator('[data-testid="route-gate-workspace.capture"]').getAttribute("data-page-route-gate-state").catch(() => null);
  fact("j6.captureGateClientNav", gate ?? "(none)");
  // Production does not refresh the context on focus (flag off): the open page
  // learns the new role from the first refused write (fixed 2026-11-18, F9).
  const offered = await m.page.locator('input[type="file"][aria-label="Upload evidence files"]').count();
  fact("j6.captureUploadOfferedToViewer", offered);
  await shot(m.page, "fid-s13b-viewer-stale-capture");
  if (offered > 0) {
    const writes: string[] = [];
    m.page.on("response", (r) => {
      if (r.request().method() !== "GET" && r.url().startsWith(API_BASE) && /evidence|capture/.test(r.url()))
        void r.text().then((b) => writes.push(`${r.status()} ${r.request().method()} ${r.url().slice(API_BASE.length).split("?")[0]} ${b.slice(0, 160)}`)).catch(() => undefined);
    });
    await m.page.locator('input[type="file"][aria-label="Upload evidence files"]').setInputFiles({
      name: `fid-stale-viewer-${s.runId}.png`,
      mimeType: "image/png",
      buffer: samplePng(`${s.runId}-stale-viewer`),
    });
    await m.page.waitForTimeout(1500);
    await m.page.getByRole("button", { name: "Review & Sign", exact: true }).last().click().catch(() => undefined);
    await m.page.locator("[data-capture-review-confirm]").click({ timeout: 5000 }).catch(() => undefined);
    await m.page.waitForTimeout(5000);
    await shot(m.page, "fid-s13b-viewer-stale-upload");
    fact("j6.staleViewerWrites", writes);
    // Does the refused autosave stop on its own? Count while the person does nothing.
    const idleStart = writes.length;
    await m.page.waitForTimeout(20_000);
    fact("j6.staleViewerPostsDuring20sIdle", writes.length - idleStart);
    expect.soft(writes.length - idleStart, "a refused autosave must stop, not retry while the person is idle").toBeLessThan(5);
    // F9 — the refused draft stops, and the context refresh it triggers closes the
    // route: the gate replaces the Capture page (and with it the draft's own
    // "Your role cannot add records here" line, which shows only until then).
    await expect(m.page.locator('[data-testid="route-gate-workspace.capture"][data-page-route-gate-state="DENIED_NO_CAPABILITY"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(m.page.getByRole("heading", { name: "Permission required" })).toBeVisible();
    fact("j6.sidebarCaptureStateAfterRefusal", (await link.getAttribute("data-sidebar-access-state")) ?? "");
    fact("j6.staleViewerVisibleAlert", (await m.page.locator('[role="alert"], [data-toast], .app-toast').allInnerTexts().catch(() => [])).join(" | ").slice(0, 400));
    fact("j6.staleViewerUrlAfter", new URL(m.page.url()).pathname);
    const created = sql(`select count(*) from evidence where team_id='${teamId()}' and created_by_user_id='${userId(free.email)}'`);
    fact("j6.evidenceCreatedByViewer", created);
    expect(created, "a Viewer must not create a record in the paid workspace").toBe("0");
  }
  await setRole(o.page, free.email, "Member");
  await keepProfile(o.context, s.people.owner!, s, "owner");
  await keepProfile(m.context, free, s, "free");
  await o.context.close();
  await m.context.close();
});

test("S13C J6 control: an allowed capture draft's autosave while the person is idle", async ({ browser }) => {
  const { context, page } = await signedInProfile(browser, "free");
  await page.locator("[data-app-context-chip] button").first().click();
  await page.locator('[data-context-group="PERSONAL"] [data-context-option]').first().click();
  const proceed = page.locator("[data-context-switch-confirm-proceed]");
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
  await expect(page.locator("[data-context-chip-name]")).toContainText(/Personal/);
  await page.goto("/capture");
  await settle(page);
  const writes: string[] = [];
  page.on("response", (r) => {
    if (r.request().method() !== "GET" && r.url().includes("/v1/capture/sessions")) writes.push(`${r.status()} ${r.request().method()}`);
  });
  await page.locator('input[type="file"][aria-label="Upload evidence files"]').setInputFiles({
    name: `fid-idle-draft-${s.runId}.png`,
    mimeType: "image/png",
    buffer: samplePng(`${s.runId}-idle-draft`),
  });
  await expect(page.getByText("1 material added").first()).toBeVisible();
  await page.waitForTimeout(5000);
  const settled = writes.length;
  await page.waitForTimeout(20_000);
  fact("j6.allowedDraftWritesFirst5s", writes.slice(0, settled));
  fact("j6.allowedDraftWritesDuring20sIdle", writes.length - settled);
  expect.soft(writes.length - settled, "an idle draft with nothing changed must not keep saving").toBeLessThan(5);
  await keepProfile(context, s.people.free!, s, "free");
  await context.close();
});

// ---------------------------------------------------------------------------
// Journey 7 — Viewer and exact location; Journey 9 — audit log parity
// ---------------------------------------------------------------------------

test("S14 J7 Viewer: report with exact location refused (403) and pointed to the external-disclosure package", async ({ browser }) => {
  const free = s.people.free!;
  const r1 = s.facts["j7.locatedId"]!;
  const o = await signedInProfile(browser, "owner");
  await setRole(o.page, free.email, "Viewer");

  const { context, page } = await signedInProfile(browser, "free");
  await switchWorkspace(page, WS);
  await page.goto(`/evidence/${r1}`);
  await settle(page);
  const api = await call(page, "GET", `/v1/evidence/${r1}/report/latest`, undefined, teamId());
  fact("j7.viewerReportApi", { status: api.status, code: errCode(api), message: api.json?.message ?? api.json?.error?.message });
  expect(api.status).toBe(403);
  expect(errCode(api)).toBe("REPORT_REQUIRES_LOCATION_ACCESS");
  const ev = await call(page, "GET", `/v1/evidence/${r1}`, undefined, teamId());
  fact("j7.viewerSeesLatLng", JSON.stringify(ev.json).match(/"(lat|lng)":[^,}]+/g) ?? []);
  await page.locator('[data-evidence-action="download-report"]').click();
  await expect(page.getByText(/external disclosure package/i).first()).toBeVisible();
  await shot(page, "fid-s14-viewer-report-refused");

  // The external-disclosure package as the Viewer downloads it.
  await page.goto(`/evidence/${r1}?tab=artifacts`);
  await settle(page);
  const btn = page.locator('[data-testid^="download-external-package-v"]').first();
  await expect(btn).toBeVisible();
  fact("j7.extButton", (await btn.getAttribute("data-testid")) ?? "");
  const dl = page.waitForEvent("download");
  await btn.click();
  const zip = readFileSync(await (await dl).path());
  expect(zip.subarray(0, 2).toString()).toBe("PK");
  const entries = unzip(zip);
  const coords = coordinatesIn(entries);
  fact("j7.extPackageEntries", [...entries.keys()]);
  fact("j7.extPackageCoordinatesDefault", coords);
  expect(coords.map((c) => c.value).filter((v) => v !== "[withheld]" && /\.\d{3,}/.test(v)), "no exact coordinate in the external package").toEqual([]);
  await shot(page, "fid-s14-viewer-artifacts");
  await keepProfile(context, free, s, "free");
  await context.close();
  await keepProfile(o.context, s.people.owner!, s, "owner");
  await o.context.close();
});

test("S15 J7 owner: discloses the location, regenerates; the external package rounds to ~2 decimals; owner's report keeps exact", async ({ browser }) => {
  const r1 = s.facts["j7.locatedId"]!;
  const { context, page } = await signedInProfile(browser, "owner");
  await switchWorkspace(page, WS);
  // The owner's report downloads.
  await page.goto(`/evidence/${r1}`);
  await settle(page);
  const rep = await call(page, "GET", `/v1/evidence/${r1}/report/latest`, undefined, teamId());
  fact("j7.ownerReportApi", { status: rep.status, keys: rep.json ? Object.keys(rep.json) : [] });
  expect(rep.status).toBe(200);
  // The report opens in a new tab (artifact window); the PDF arrives there as a download.
  const got = new Promise<import("@playwright/test").Download>((res) =>
    page.context().once("page", (tab) => tab.once("download", res)),
  );
  await page.locator('[data-evidence-action="download-report"]').click();
  const pdfDownload = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no report download")), 30_000))]);
  fact("j7.ownerReportFile", pdfDownload.suggestedFilename());
  const pdf = readFileSync((await pdfDownload.path())!);
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  const text = pdfText(pdf);
  const exact = sql(`select lat||' '||lng from evidence where id='${r1}'`).split(" ");
  fact("j7.ownerPdfMentionsExactLat", text.includes(exact[0]!) || text.includes(Number(exact[0]).toFixed(5)) || text.includes(Number(exact[0]).toFixed(4)));
  // The owner's full verification package carries the exact coordinates.
  const zipDl = page.waitForEvent("download");
  await page.locator('[data-evidence-action="download-package"]').click();
  const full = unzip(readFileSync(await (await zipDl).path()));
  const fullCoords = coordinatesIn(full);
  fact("j7.ownerFullPackageCoordinates", fullCoords.slice(0, 6));

  // Disclose the recorded location on the verification page, then issue an updated report.
  await page.goto(`/evidence/${r1}?tab=artifacts`);
  await settle(page);
  await page.locator('[data-verification-disclosure-mode="CONTENT_PREVIEW"]').click();
  const loc = page.locator("[data-verification-disclosure-location]");
  if (!(await loc.isChecked())) await loc.check({ force: true });
  const save = page.locator('[data-verification-disclosure-action="save"]');
  if (await save.isEnabled()) await save.click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) await answerStepUp(page, s.people.owner!);
  await expect.poll(() => sql(`select show_recorded_location from evidence where id='${r1}'`), { timeout: 20_000 }).toBe("t");
  await shot(page, "fid-s15-disclosure-saved");
  const before = await page.locator('[data-testid^="download-external-package-v"]').count();
  const regen = page.locator('[data-evidence-action="generate-updated-report"], [data-evidence-action="artifact-stale-refresh"]').first();
  if (await regen.isVisible().catch(() => false)) {
    await regen.click();
    await page.waitForTimeout(800);
    await page.getByRole("dialog").locator("textarea").first().fill("Owner disclosed the recorded location for external parties.");
    await page.getByTestId("updated-report-confirm").click();
    if (await page.locator('[data-step-up-form="code"]').isVisible().catch(() => false)) await answerStepUp(page, s.people.owner!);
  }
  fact("j7.regenerateOffered", await regen.isVisible().catch(() => false));
  await expect(async () => {
    await page.reload();
    await expect(page.locator('[data-testid^="download-external-package-v"]')).toHaveCount(before + 1, { timeout: 3000 });
  }).toPass({ timeout: 150_000, intervals: [4000] });
  const versions = await page.locator('[data-testid^="download-external-package-v"]').evaluateAll((b) => b.map((x) => x.getAttribute("data-testid")));
  fact("j7.extVersions", versions);
  const newest = versions.map((v) => Number(v!.replace(/\D+/g, ""))).sort((a, b) => b - a)[0]!;
  const dl = page.waitForEvent("download");
  await page.locator(`[data-testid="download-external-package-v${newest}"]`).first().click();
  const ext = unzip(readFileSync(await (await dl).path()));
  const coords = coordinatesIn(ext);
  fact("j7.extPackageCoordinatesDisclosed", coords);
  const numeric = coords.filter((c) => c.value !== "[withheld]");
  expect(numeric.length, "the disclosed external package carries coordinates").toBeGreaterThan(0);
  for (const c of numeric) expect(c.value, `${c.file} ${c.key}`).toMatch(/^-?\d+(\.\d{1,2})?$/);
  await shot(page, "fid-s15-ext-v" + newest);
  await keepProfile(context, s.people.owner!, s, "owner");
  await context.close();
});

test("S15B J7 Viewer downloads the disclosed external package (v-latest): coordinates rounded to 2 decimals", async ({ browser }) => {
  const r1 = s.facts["j7.locatedId"]!;
  const o = await signedInProfile(browser, "owner");
  await setRole(o.page, s.people.free!.email, "Viewer");
  const { context, page } = await signedInProfile(browser, "free");
  await switchWorkspace(page, WS);
  await page.goto(`/evidence/${r1}?tab=artifacts`);
  await settle(page);
  const versions = await page.locator('[data-testid^="download-external-package-v"]').evaluateAll((b) => b.map((x) => x.getAttribute("data-testid")));
  const newest = versions.map((v) => Number(v!.replace(/\D+/g, ""))).sort((a, b) => b - a)[0]!;
  const dl = page.waitForEvent("download");
  await page.locator(`[data-testid="download-external-package-v${newest}"]`).first().click();
  const ext = unzip(readFileSync(await (await dl).path()));
  const coords = coordinatesIn(ext).filter((c) => c.value !== "[withheld]");
  fact("j7.viewerExtLatestCoordinates", { version: newest, coords: coords.slice(0, 4) });
  expect(coords.length).toBeGreaterThan(0);
  for (const c of coords) expect(c.value).toMatch(/^-?\d+(\.\d{1,2})?$/);
  const rep = await call(page, "GET", `/v1/evidence/${r1}/report/latest`, undefined, teamId());
  fact("j7.viewerReportAfterDisclosure", { status: rep.status, code: errCode(rep) });
  await shot(page, "fid-s15b-viewer-ext-latest");
  await keepProfile(context, s.people.free!, s, "free");
  await context.close();
  await keepProfile(o.context, s.people.owner!, s, "owner");
  await o.context.close();
});

test("S16 J9 Audit Transparency parity: Viewer has no Settings 'Audit log' and the API refuses; owner sees it and the API answers", async ({ browser }) => {
  const v = await signedInProfile(browser, "free");
  await switchWorkspace(v.page, WS);
  expect(sql(`select role from team_members where id='${memberRowId(s.people.free!.email)}'`)).toBe("VIEWER");
  await v.page.goto("/settings");
  await settle(v.page);
  await expect(v.page.locator('[data-settings-nav-item]').first()).toBeVisible();
  await expect(v.page.locator('[data-settings-nav-item="audit"]')).toHaveCount(0);
  const va = await call(v.page, "GET", "/v1/audit-transparency?limit=200", undefined, teamId());
  fact("j9.viewerApi", { status: va.status, code: errCode(va), reason: va.json?.error?.reason });
  expect(va.status).toBe(403);
  await v.page.goto("/audit-transparency");
  await settle(v.page);
  fact("j9.viewerDirectUrlGate", (await v.page.locator('[data-testid="route-gate-workspace.audit_transparency"]').getAttribute("data-page-route-gate-state").catch(() => null)) ?? "(no gate)");
  await shot(v.page, "fid-s16-viewer-audit");
  await keepProfile(v.context, s.people.free!, s, "free");
  await v.context.close();

  const o = await signedInProfile(browser, "owner");
  await switchWorkspace(o.page, WS);
  await o.page.goto("/settings");
  await settle(o.page);
  await expect(o.page.locator('[data-settings-nav-item="audit"]')).toBeVisible();
  const oa = await call(o.page, "GET", "/v1/audit-transparency?limit=200", undefined, teamId());
  fact("j9.ownerApi", { status: oa.status, items: Array.isArray(oa.json?.items) ? oa.json.items.length : Object.keys(oa.json ?? {}) });
  expect(oa.status).toBe(200);
  await o.page.locator('[data-settings-nav-item="audit"]').click();
  await expect(o.page.locator('[data-settings-handoff="audit"]')).toBeVisible();
  await shot(o.page, "fid-s16-owner-audit");
  await keepProfile(o.context, s.people.owner!, s, "owner");
  await o.context.close();
});

// ---------------------------------------------------------------------------
// Journey 6 — restricted records and stale bulk selections
// ---------------------------------------------------------------------------

test("S17 J6 restricted record: a selection made before the owner restricts it is refused; the record is gone, also by URL", async ({ browser }) => {
  const free = s.people.free!;
  const r2 = s.facts["j6.plainId"]!;
  const o = await signedInProfile(browser, "owner");
  await setRole(o.page, free.email, "Member");

  // The member selects the record in the library.
  const m = await signedInProfile(browser, "free");
  await switchWorkspace(m.page, WS);
  await m.page.goto("/evidence");
  await settle(m.page);
  await expect(m.page.locator(`li[data-evidence-row="${r2}"]`)).toBeVisible();
  await m.page.locator(`input#evidence-select-${r2}`).check();
  await expect(m.page.getByText(/1 selected/).first()).toBeVisible();
  await shot(m.page, "fid-s17-member-selected");

  // The owner puts the record in a case and restricts the case to the peer.
  await switchWorkspace(o.page, WS);
  if (!s.facts.caseId) {
    await o.page.goto("/cases");
    await settle(o.page);
    await o.page.locator("[data-create-case-trigger]").first().click();
    s.facts.caseTitle = `Fid restricted matter ${s.runId}`;
    await o.page.getByPlaceholder("e.g. Insurance claim #4823").fill(s.facts.caseTitle);
    await o.page.getByRole("dialog").getByRole("button", { name: /create/i }).click();
    await o.page.waitForURL(/\/cases\/[0-9a-f-]{36}/, { timeout: 30_000 });
    s.facts.caseId = o.page.url().match(/cases\/([0-9a-f-]{36})/)![1]!;
    saveState(s);
  }
  await o.page.goto(`/cases/${s.facts.caseId}`);
  await settle(o.page);
  await o.page.locator('[data-tab-id="evidence"]').click();
  await settle(o.page);
  if (!(await o.page.locator("main").innerText()).includes(`fid-plain-${s.runId}.png`)) {
    await o.page.locator("[data-matter-evidence-link-open]").click();
    const picker = o.page.locator('[role="dialog"]').filter({ has: o.page.locator("[data-matter-evidence-link-search-input]") });
    await picker.getByText(`fid-plain-${s.runId}.png`).first().click();
    await o.page.locator("[data-matter-evidence-link-submit]").click();
    await expect(o.page.locator("[data-matter-evidence-link-submit]")).toHaveCount(0);
  }
  await expect(o.page.locator("main")).toContainText(`fid-plain-${s.runId}.png`);
  await o.page.locator('[data-tab-id="access"]').click();
  await settle(o.page);
  await o.page.locator("[data-workspace-member-select] button[data-placeholder]").click();
  await o.page.getByRole("option", { name: /fid-peer\./ }).click();
  await o.page.locator("[data-matter-access-grant-form] button[data-matter-access-grant]").first().click();
  await o.page.getByRole("dialog").getByRole("button", { name: /Give access and restrict/ }).click();
  await expect(o.page.locator('[data-matter-access-mode="restricted"]')).toBeVisible();
  await shot(o.page, "fid-s17-owner-restricted");

  // The member's stale selection: run a bulk action now.
  await m.page.getByRole("combobox", { name: "Bulk action" }).click();
  await m.page.locator('li[role=option][data-value="ARCHIVE"]').click();
  const bulk = m.page.waitForResponse((r) => r.url().includes("/v1/evidence/bulk"));
  await m.page.locator("[data-evidence-run-bulk]").click();
  await m.page.locator("[data-bulk-confirm-submit]").click();
  const res = await bulk;
  const body = await res.json().catch(() => ({}));
  fact("j6.staleBulkAfterRestrict", { status: res.status(), body });
  expect(body.successCount ?? 0).toBe(0);
  await expect(m.page.locator("[data-bulk-result-failed]")).toBeVisible();
  fact("j6.staleBulkReasonShown", await m.page.locator("[data-bulk-result-reasons] li").first().getAttribute("data-bulk-result-reason").catch(() => null));
  await shot(m.page, "fid-s17-member-stale-bulk");
  expect(sql(`select archived_at is null from evidence where id='${r2}'`)).toBe("t");
  await m.page.locator("[data-bulk-result-close]").click().catch(() => undefined);

  // The record is gone from the library and by direct URL.
  await m.page.goto("/evidence");
  await settle(m.page);
  await expect(m.page.locator(`li[data-evidence-row="${r2}"]`)).toHaveCount(0);
  await m.page.goto(`/evidence/${r2}`);
  await settle(m.page);
  await expect(m.page.locator("main")).not.toContainText(`fid-plain-${s.runId}`);
  await expect(m.page.getByText(/not available|Unable to load/i).first()).toBeVisible();
  const direct = await call(m.page, "GET", `/v1/evidence/${r2}`, undefined, teamId());
  fact("j6.memberDirectApi", { status: direct.status, body: direct.body.slice(0, 120) });
  expect(direct.status).toBe(404);
  await shot(m.page, "fid-s17-member-direct-url");

  // The peer, who was given access, still opens it.
  const p = await signedInProfile(browser, "peer");
  await switchWorkspace(p.page, WS);
  await p.page.goto(`/evidence/${r2}`);
  await settle(p.page);
  await expect(p.page.locator("main")).toContainText(`fid-plain-${s.runId}`);
  await p.context.close();

  await keepProfile(o.context, s.people.owner!, s, "owner");
  await o.context.close();
  await keepProfile(m.context, free, s, "free");
  await m.context.close();
});

test("S18 J6 stale selection across a workspace change: selection clears; a forged cross-workspace action is refused", async ({ browser }) => {
  const free = s.people.free!;
  const r1 = s.facts["j7.locatedId"]!;
  const { context, page } = await signedInProfile(browser, "free");
  await switchWorkspace(page, WS);
  await page.goto("/evidence");
  await settle(page);
  await page.locator(`input#evidence-select-${r1}`).check();
  await expect(page.locator("[data-evidence-run-bulk]")).toBeVisible();
  // Switch to Personal in the same tab.
  await page.locator("[data-app-context-chip] button").first().click();
  await page.locator('[data-context-group="PERSONAL"] [data-context-option]').first().click();
  const proceed = page.locator("[data-context-switch-confirm-proceed]");
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
  await expect(page.locator("[data-context-chip-name]")).toContainText(/Personal/);
  await settle(page);
  await expect(page.locator("[data-evidence-run-bulk]")).toHaveCount(0);
  await expect(page.locator(`li[data-evidence-row="${r1}"]`)).toHaveCount(0);
  await shot(page, "fid-s18-selection-cleared");

  // The same ids, sent while Personal is the workspace: nothing in the paid workspace is touched.
  const personal = sql(`select current_workspace_id from users where id='${userId(free.email)}'`);
  fact("j6.currentWorkspaceAfterSwitch", personal);
  const forged = await call(page, "POST", "/v1/evidence/bulk", { action: "ARCHIVE", evidenceIds: [r1] }, personal);
  fact("j6.forgedCrossWorkspaceBulk", { status: forged.status, body: forged.json ?? forged.body.slice(0, 200) });
  expect(forged.json?.successCount ?? 0).toBe(0);
  expect(sql(`select archived_at is null from evidence where id='${r1}'`)).toBe("t");
  // A second tab still on the paid workspace (two tabs, two contexts).
  await keepProfile(context, free, s, "free");
  await context.close();
});

// ---------------------------------------------------------------------------
// Journey 8 — account closure (Free user)
// ---------------------------------------------------------------------------

test("S19 J8 closure [FX-COOLOFF]: request, the worker closes it, every session ends, sign-in refused, public verify minimal", async ({ browser }) => {
  const close = fid("close", "Clara Closure");
  const a = await newProfile(browser);
  if (!s.facts["j8.evidenceId"]) {
    await registerAccount(a.page, close);
    await settle(a.page);
    const id = await captureRecord(a.page, `fid-closing-${s.runId}.png`);
    fact("j8.evidenceId", id);
    await waitReported(a.page, id);
  } else {
    await signIn(a.page, close);
    await settle(a.page);
  }
  const id = s.facts["j8.evidenceId"]!;
  await a.page.goto(`/evidence/${id}?tab=artifacts`);
  await settle(a.page);
  const url = a.page.locator("[data-verification-access-url]");
  await expect(url).toBeVisible({ timeout: 30_000 });
  const verifyUrl = await url.inputValue();
  fact("j8.verifyUrl", verifyUrl);
  const verifyPath = new URL(verifyUrl).pathname;

  const pub = await browser.newContext({ baseURL: WEB_BASE });
  const pv = await pub.newPage();
  await pv.goto(verifyPath);
  await settle(pv);
  const beforeText = await pv.locator("body").innerText();
  await shot(pv, "fid-s19-public-verify-before");

  // A second session (another device).
  const b = await newProfile(browser);
  await signIn(b.page, close);
  await settle(b.page);
  const cookieA = await sessionCookie(a.page);
  const cookieB = await sessionCookie(b.page);
  expect(await replay(cookieB)).toBe(200);

  // The closure flow in settings.
  await a.page.goto("/settings#privacy");
  await settle(a.page);
  const section = a.page.locator("section[data-cc-privacy-closure]");
  await expect(section).toBeVisible();
  await a.page.locator("[data-cc-closure-open]").click();
  await expect(a.page.locator("[data-cc-closure-form]")).toBeVisible();
  await expect(a.page.locator("[data-cc-closure-submit]")).toBeDisabled();
  await a.page.locator("#closure-confirm").fill("close my account");
  await a.page.locator("[data-cc-closure-submit]").click();
  const stepUp = a.page.locator("[data-cc-step-up-verify]");
  await expect(stepUp).toBeVisible();
  await stepUp.locator("[data-cc-step-up-input]").fill(close.password);
  await stepUp.locator("[data-cc-step-up-submit]").click();
  await expect(a.page.locator('[data-cc-closure-status="COOLING_OFF"]')).toBeVisible();
  await shot(a.page, "fid-s19-cooling-off");
  const uid = userId(close.email);
  const reqRow = sql(`select id||'|'||status||'|'||cooling_off_ends_at_utc from account_closure_requests where user_id='${uid}' order by created_at desc limit 1`);
  fact("j8.closureRequest", reqRow);
  // During cooling-off the sessions stay.
  expect(await replay(cookieB)).toBe(200);

  // FX-COOLOFF: the 7 days pass. The worker's own sweep executes it.
  sql(`update account_closure_requests set cooling_off_ends_at_utc = now() - interval '1 minute' where id='${reqRow.split("|")[0]}'`);
  await expect
    .poll(() => sql(`select status from account_closure_requests where id='${reqRow.split("|")[0]}'`), { timeout: 180_000, intervals: [5000] })
    .toMatch(/COMPLETED|CLOSED|EXECUTED/);
  fact("j8.closureFinalStatus", sql(`select status||'|'||coalesce(failure_code,'') from account_closure_requests where id='${reqRow.split("|")[0]}'`));

  // Every session is refused.
  expect(await replay(cookieA)).toBe(401);
  expect(await replay(cookieB)).toBe(401);
  fact("j8.sessionRevocations", sql(`select string_agg(distinct coalesce(revoked_reason,'(none)'),',') from authenticated_sessions where user_id='${uid}'`));
  await b.page.goto("/home");
  await settle(b.page);
  await expect(b.page.locator("[data-signed-out-app-state]")).toBeVisible();
  await shot(b.page, "fid-s19-other-session-refused");
  await b.context.close();

  // Sign-in is refused.
  await submitPassword(a.page, close.email, close.password);
  await a.page.waitForTimeout(2500);
  expect(new URL(a.page.url()).pathname).toBe("/login");
  await shot(a.page, "fid-s19-signin-refused");
  const login = await pwRequest.newContext();
  const lr = await login.post(`${API_BASE}/v1/auth/email/login`, { data: { email: close.email, password: close.password } });
  fact("j8.loginAfterClosure", { status: lr.status(), body: (await lr.text()).slice(0, 160) });
  expect(lr.status()).toBe(401);
  await login.dispose();
  await a.context.close();

  // Public verify: what is designed to be public, and nothing personal.
  await pv.goto(verifyPath);
  await settle(pv);
  const afterText = await pv.locator("body").innerText();
  await shot(pv, "fid-s19-public-verify-after");
  fact("j8.publicVerifyAfterExcerpt", afterText.replace(/\s+/g, " ").slice(0, 400));
  for (const leak of [close.email, close.email.split("@")[0]!, close.name, `fid-closing-${s.runId}`]) {
    expect(afterText, `public verify must not show ${leak}`).not.toContain(leak);
  }
  const apiPub = await pub.request.get(`${API_BASE}/public/verify/${verifyPath.split("/").pop()}`);
  const apiText = await apiPub.text();
  fact("j8.publicVerifyApiStatus", apiPub.status());
  for (const leak of [close.email, close.name, `fid-closing-${s.runId}`, uid]) expect(apiText).not.toContain(leak);
  expect(apiText).not.toMatch(/"(lat|lng)":\s*-?\d/);
  fact("j8.publicVerifyBeforeHadName", beforeText.includes(`fid-closing-${s.runId}`));
  await pub.close();
});
