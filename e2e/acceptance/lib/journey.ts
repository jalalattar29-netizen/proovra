/**
 * Helpers for the fresh-enterprise journey. A person here is what a person is in
 * the product: a mailbox (the recording transport's file), an authenticator app
 * (real TOTP against the secret the page showed) and a browser profile.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { computeTotpCode, decodeBase32, timeStep, TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "../../../services/api/src/services/security/mfa-totp";
import { answerCookieBanner } from "../../helpers/consent";

const ROOT = resolve(__dirname, "..", "..", "..");
const STATE_FILE = resolve(ROOT, ".p7tmp", "acceptance-state.json");
const EMAILS = resolve(ROOT, ".p7tmp", "recorded-emails.jsonl");
export const SHOT_DIR = resolve(ROOT, ".p7tmp", "acceptance-shots");
export const API_BASE = process.env.API_BASE ?? "http://localhost:8391";
export const WEB_BASE = process.env.WEB_BASE ?? "http://localhost:3511";

export const PASSWORD = "Accept4nce-Fixture-Passphrase!";
/** The seeded operator. A platform operator is not a customer-facing onboarding step. */
export const OPERATOR_EMAIL = "platform-admin@fixture.local";
export const OPERATOR_PASSWORD = "fixture-local-only-password";

export type Person = {
  email: string;
  password: string;
  name: string;
  totpSecret?: string;
  recoveryCodes?: string[];
  storage?: string;
  lastTotpStep?: number;
};

export type JourneyState = {
  runId: string;
  company: string;
  orgId?: string;
  workspaceId?: string;
  people: Record<string, Person>;
  facts: Record<string, string>;
};

export function loadState(): JourneyState {
  if (process.env.ACCEPT_RESUME === "1" && existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as JourneyState;
  }
  // The seeded operator keeps its authenticator from run to run; everything else is new.
  const previous = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as JourneyState) : null;
  const runId = Date.now().toString(36);
  return {
    runId,
    company: `Halden Marine Claims ${runId}`,
    people: previous?.people.operator ? { operator: previous.people.operator } : {},
    facts: {},
  };
}

export function saveState(s: JourneyState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function person(s: JourneyState, key: string, name: string): Person {
  s.people[key] ??= { email: `${key}.${s.runId}@halden-marine.example.test`, password: PASSWORD, name };
  return s.people[key]!;
}

// --- authenticator -----------------------------------------------------------

/**
 * The code an authenticator shows, never one the server has already seen: a TOTP
 * step is single use, so the helper moves to the next step, as far as the server's
 * one-step window allows, and otherwise waits like a person would.
 */
export async function totp(p: Person): Promise<string> {
  const secret = p.totpSecret;
  if (!secret) throw new Error(`${p.email} has no authenticator`);
  for (;;) {
    const now = timeStep(Math.floor(Date.now() / 1000), TOTP_PERIOD_SECONDS);
    const next = p.lastTotpStep === undefined ? now : Math.max(now, p.lastTotpStep + 1);
    if (next <= now + 1) {
      p.lastTotpStep = next;
      return computeTotpCode(decodeBase32(secret), next, TOTP_DIGITS);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function wrongCode(p: Person): string {
  const step = timeStep(Math.floor(Date.now() / 1000), TOTP_PERIOD_SECONDS);
  const accepted = new Set([-1, 0, 1].map((d) => computeTotpCode(decodeBase32(p.totpSecret!), step + d, TOTP_DIGITS)));
  for (let n = 0; ; n += 1) {
    const c = String(n).padStart(TOTP_DIGITS, "0");
    if (!accepted.has(c)) return c;
  }
}

// --- mailbox -----------------------------------------------------------------

type Mail = { recipientAlias: string; subject?: string; actionableLink?: string | null; [k: string]: unknown };

/** The recorder stores a hash of the recipient, never the address. */
function recipientAlias(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function mailbox(address: string): Mail[] {
  if (!existsSync(EMAILS)) return [];
  const alias = recipientAlias(address);
  return readFileSync(EMAILS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Mail)
    .filter((m) => m.recipientAlias === alias);
}

/** Wait for the newest mail to `address` whose subject or link matches, and return its link. */
export async function linkFromMail(address: string, match: RegExp, timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = mailbox(address)
      .reverse()
      .find((m) => match.test(`${m.subject ?? ""} ${m.actionableLink ?? ""}`));
    if (hit?.actionableLink) return hit.actionableLink;
    if (Date.now() > deadline) {
      throw new Error(`no mail matching ${match} for ${address}; have: ${mailbox(address).map((m) => m.subject).join(" | ")}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- browser -----------------------------------------------------------------

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SHOT_DIR, `${name}.png`), fullPage: false }).catch(() => undefined);
}

export async function newProfile(browser: Browser, p?: Person): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    baseURL: WEB_BASE,
    acceptDownloads: true,
    ...(p?.storage && existsSync(p.storage) ? { storageState: p.storage } : {}),
  });
  const page = await context.newPage();
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().startsWith(API_BASE) && (r.status() !== 401 || /decision/.test(r.url()))) {
      void r.text().then((b) => console.log(`[api ${r.status()}] ${r.request().method()} ${r.url().slice(API_BASE.length).split("?")[0]} ${b.slice(0, 240)}`)).catch(() => undefined);
    }
  });
  await answerCookieBanner(page);
  return { context, page };
}

export async function keepProfile(context: BrowserContext, p: Person, s: JourneyState, key: string): Promise<void> {
  mkdirSync(resolve(ROOT, ".p7tmp", "acceptance-profiles"), { recursive: true });
  p.storage = resolve(ROOT, ".p7tmp", "acceptance-profiles", `${key}.json`);
  await context.storageState({ path: p.storage });
  saveState(s);
}

export async function submitPassword(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator('input[placeholder="Email"]:visible').first().fill(email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(password);
  // RT-015: sign-in asks nothing; acceptance is a step after it, when one is owed.
  await expect(page.locator("input.auth-legal-checkbox")).toHaveCount(0);
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
}

/** A new account through the public form, and its email verification from the mailbox. */
export async function registerAccount(page: Page, p: Person): Promise<void> {
  await page.goto("/register");
  await page.locator('input[placeholder="Email"]:visible').first().fill(p.email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(p.password);
  await page.locator('input[placeholder="Confirm password"]:visible').first().fill(p.password);
  await page.locator("input.auth-legal-checkbox:visible").first().check();
  await page.locator('[data-auth-email-cta="REGISTER"]:visible').first().click();
  await expect(page.getByRole("heading", { name: "Verify your email address" })).toBeVisible();
  await page.goto(await linkFromMail(p.email, /verify/i));
  const password = page.locator('input[type="password"]:visible').first();
  await expect(password).toBeVisible();
  await password.fill(p.password);
  await page.getByRole("button", { name: "Verify my email" }).click();
  await page.waitForURL(/\/home/, { timeout: 30_000 });
}

/** Enrol at the sign-in surface: read the setup key, type a real code, keep the recovery codes. */
export async function enrolAtSignIn(page: Page, p: Person): Promise<void> {
  await page.waitForURL(/\/auth\/mfa-challenge\?.*enroll=1/, { timeout: 30_000 });
  await expect(page.locator("[data-cc-mfa-manual-secret]")).toBeVisible();
  p.totpSecret = (await page.locator("[data-cc-mfa-manual-secret]").innerText()).trim();
  await page.locator('[data-cc-mfa-input="enroll-totp"]').fill(await totp(p));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.locator('[data-cc-mfa-enroll-step="recovery-codes"]')).toBeVisible();
  p.recoveryCodes = await page.locator("[data-cc-mfa-recovery-codes] li").allInnerTexts();
  expect(p.recoveryCodes.length).toBeGreaterThan(0);
  await page.locator("[data-cc-mfa-enroll-finish]").click();
}

/** The whole sign-in, whichever door the server opens. */
export async function signIn(page: Page, p: Person): Promise<"password" | "challenge" | "enrolled"> {
  await submitPassword(page, p.email, p.password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  if (/enroll=1/.test(page.url())) {
    await enrolAtSignIn(page, p);
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/mfa-challenge"), { timeout: 30_000 });
    return "enrolled";
  }
  if (/\/auth\/mfa-challenge/.test(page.url())) {
    await page.locator('input[name="code"]').fill(await totp(p));
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/mfa-challenge"), { timeout: 30_000 });
    return "challenge";
  }
  return "password";
}

/** Sign out from the account menu, as a person does. */
export async function signOut(page: Page): Promise<void> {
  await page.locator("[data-app-topbar-account] button").first().click();
  await page.locator('[data-account-menu-item="signout"]').click();
  await page.waitForURL((u) => !/\/(home|organizations|settings|teams)/.test(u.pathname), { timeout: 30_000 });
}

/** Switch workspace with the header chip, as a person does. */
export async function switchWorkspace(page: Page, name: string): Promise<void> {
  const chip = page.locator("[data-context-chip-name]");
  await expect(chip).not.toHaveText(/Loading/, { timeout: 20_000 });
  if ((await chip.innerText()).includes(name)) return;
  await page.locator("[data-app-context-chip] button").first().click();
  await page.locator('[data-context-group="ORGANIZATION"] [data-context-option]', { hasText: name }).first().click();
  const proceed = page.locator("[data-context-switch-confirm-proceed]");
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
  await expect(chip).toContainText(name);
}

/** A real, valid PNG whose bytes differ per run, so every capture is new evidence. */
export function samplePng(seed: string): Buffer {
  const width = 64;
  const height = 64;
  const row = Buffer.alloc(1 + width * 3);
  const hash = createHash("sha256").update(seed).digest();
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = hash[x % 32]!;
    row[2 + x * 3] = hash[(x + 7) % 32]!;
    row[3 + x * 3] = hash[(x + 13) % 32]!;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Answer the step-up dialog the product raised, with the authenticator. */
export async function answerStepUp(page: Page, p: Person): Promise<void> {
  const form = page.locator('[data-step-up-form="code"]');
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.locator("input").first().fill(await totp(p));
  await form.locator('button[type="submit"]').first().click();
  await expect(page.locator("[data-step-up-state]")).toHaveCount(0, { timeout: 30_000 });
}
