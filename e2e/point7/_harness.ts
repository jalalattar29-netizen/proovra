/**
 * PHASE 12 — POINT 7: the browser harness.
 *
 * WHAT IS REAL, AND WHY IT MATTERS THAT IT IS
 * ---------------------------------------------------------------------------
 * A real Chromium drives the real Next.js application against the real Fastify
 * API against a real PostgreSQL 16. Nothing in the application is replaced:
 * not the platform-context provider, not the workspace resolver, not the plan
 * projection, not the API client. Substituting any of those and calling the
 * result "browser proof" is the specific dishonesty this layer exists to
 * refuse — it would prove that a mock behaves the way the test author expected
 * a mock to behave.
 *
 * Network interception is used for exactly four things, all of which are about
 * the boundary rather than the behaviour:
 *
 *   1. RECORDING requests, so a UI action can be correlated with the request
 *      it actually emitted (and, crucially, with the request it did NOT);
 *   2. DELAYING a real response, so a stale response can arrive after a
 *      workspace switch — the response is the server's, only its timing is
 *      ours;
 *   3. BLOCKING genuine third parties (the Google and Apple sign-in widgets)
 *      so a hermetic run makes no unintended egress;
 *   4. proving a prohibited request was never emitted.
 *
 * DURABLE STATE IS READ WITH RAW SQL
 * ---------------------------------------------------------------------------
 * Deliberately not through Prisma. The assertions in this layer are about what
 * the database CONTAINS after a browser action, and reading it back through
 * the same ORM and the same models the write path used would let one shared
 * misunderstanding satisfy both sides. `pg` and a SELECT cannot.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { expect, type Page, type Request } from "@playwright/test";
import { Client } from "pg";

/**
 * The two origins, defaulted to the ones the run actually builds against.
 *
 * `127.0.0.1` and `localhost` are DIFFERENT ORIGINS, and the difference is not
 * cosmetic here. The web bundle inlines `NEXT_PUBLIC_API_BASE` at BUILD time and
 * the served CSP `connect-src` is derived from it, so a bundle built against one
 * and driven from the other has its fetches blocked by CSP; and once that is
 * allowed, the session cookie is still not sent, because a cookie is per-host.
 * The API's `CORS_ORIGINS` is likewise pinned to `http://127.0.0.1:3007` by the
 * test bootstrap. Defaulting to `localhost` meant the correct run was the one
 * that remembered to export two variables.
 */
export const WEB_BASE = process.env.WEB_BASE ?? "http://127.0.0.1:3007";
export const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:8091";

/**
 * The disposable database this run drives.
 *
 * Deliberately its OWN variable rather than `DATABASE_URL`: the repository's
 * `DATABASE_URL` carries production-shaped values, and a harness that reads it
 * would be one missing export away from pointing a test suite at production.
 */
const P7_DATABASE_URL = process.env.P7_DATABASE_URL ?? "";

/** Where specs append the scenarios they proved. */
export const BROWSER_PROOF_FILE = ".p7tmp/browser-proven.jsonl";

// ===========================================================================
// Database
// ===========================================================================

export async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  if (!P7_DATABASE_URL) {
    throw new Error(
      "point7 browser harness: P7_DATABASE_URL is not set. The harness will " +
        "NOT fall back to DATABASE_URL under any circumstance.",
    );
  }
  if (!/point7|test/i.test(P7_DATABASE_URL)) {
    throw new Error(
      "point7 browser harness: refusing to run against a database whose name " +
        "does not identify it as a Point-7 test database.",
    );
  }
  const client = new Client({ connectionString: P7_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function sql<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withDb(async (c) => (await c.query(text, values)).rows as T[]);
}

export async function countRows(
  table: string,
  where: string,
  values: unknown[],
): Promise<number> {
  const rows = await sql<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ${table} WHERE ${where}`,
    values,
  );
  return Number(rows[0]?.n ?? "0");
}

// ===========================================================================
// Accounts
// ===========================================================================

export type BrowserAccount = {
  userId: string;
  email: string;
  password: string;
  personalTeamId: string | null;
};

const PASSWORD = "P7-browser-Passw0rd!";

/**
 * The E2E rate-limit reset secret.
 *
 * Every spec in the matrix registers and signs in from 127.0.0.1, so they all
 * share the per-IP auth buckets — five registrations a minute, ten logins.
 * Twenty-seven scenarios saturate that within seconds, and the resulting 429s
 * are an artefact of the harness rather than a property of the product.
 *
 * The repository already provides the sanctioned answer: a test-only endpoint
 * behind a three-layer gate (404 in production, 404 without a ≥32-char secret,
 * 404 without the matching header) that clears ONLY rate-limit buckets and
 * touches no domain data. It changes no limit and no window — the next request
 * simply starts from the baseline a fresh process would have. That is a
 * harness concern being reset, not a production rule being weakened.
 */
const E2E_BYPASS_SECRET =
  (process.env.E2E_AUTH_BYPASS_SECRET ?? "").trim() ||
  "e2e-bypass-do-not-use-in-prod-7f2c3a91b4d9e8f10c2b3a4d5e6f70819";

export async function resetRateLimits(): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/_test/rate-limit/reset`, {
    method: "POST",
    headers: { "X-E2E-Auth-Bypass": E2E_BYPASS_SECRET },
  });
  if (res.status === 404) {
    throw new Error(
      "point7: the rate-limit reset endpoint answered 404. The API must run " +
        "with NODE_ENV !== production and a matching E2E_AUTH_BYPASS_SECRET.",
    );
  }
}

/**
 * Create a usable account through the REAL registration route, then bring it
 * to a state a real signed-up user would be in.
 *
 * Registration goes through the production HTTP endpoint — password hashing,
 * validation and User creation are the real ones. Email verification and legal
 * acceptance are then set directly, because they are INITIAL STATE (a verified
 * mailbox and a clicked checkbox), not behaviour under test; driving a mail
 * round-trip here would prove the mail provider works and nothing about
 * commercial plans.
 */
export async function createAccount(input: {
  label: string;
  plan: "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE";
  credits?: number;
}): Promise<BrowserAccount> {
  const email = `p7b-${input.label}-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}@test.proovra.local`;

  await resetRateLimits();
  const res = await fetch(`${API_BASE}/v1/auth/email/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, displayName: input.label }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(
      `point7: registration failed (${res.status}): ${await res.text()}`,
    );
  }

  const rows = await sql<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [email],
  );
  const userId = rows[0]?.id;
  if (!userId) throw new Error(`point7: registered user ${email} not found`);

  await sql(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [userId]);

  // Current legal acceptances — routes behind the legal gate answer 428 before
  // any tenancy resolution, which would mask every behaviour under test.
  const required = JSON.parse(
    readFileSync(
      resolve(process.cwd(), ".p7tmp/required-legal-versions.json"),
      "utf8",
    ),
  ) as Record<string, string>;
  for (const [policyKey, policyVersion] of Object.entries(required)) {
    await sql(
      `INSERT INTO user_legal_acceptances (user_id, policy_key, policy_version, source)
       VALUES ($1, $2, $3, 'point7-browser')
       ON CONFLICT DO NOTHING`,
      [userId, policyKey, policyVersion],
    );
  }

  // Exactly one active entitlement at the requested plan.
  await sql(`UPDATE entitlements SET active = false WHERE user_id = $1`, [userId]);
  await sql(
    `INSERT INTO entitlements (user_id, plan, active, credits, updated_at)
     VALUES ($1, $2::"PlanType", true, $3, NOW())`,
    [userId, input.plan, input.credits ?? 0],
  );

  return { userId, email, password: PASSWORD, personalTeamId: null };
}

/** Read the account's bootstrapped Personal Space, once it exists. */
export async function personalTeamId(userId: string): Promise<string | null> {
  const rows = await sql<{ id: string }>(
    `SELECT id FROM teams WHERE owner_user_id = $1 AND is_personal = true LIMIT 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

// ===========================================================================
// Browser session
// ===========================================================================

/**
 * Block the genuine third-party sign-in widgets.
 *
 * The login page embeds Google's and Apple's hosted button scripts. They are
 * external processes, they are not under test, and letting them load makes the
 * run non-hermetic and slow. Blocking them is a boundary substitution, not a
 * behaviour substitution.
 */
export const BROWSER_NETWORK_LEDGER = ".p7tmp/browser-network.jsonl";

function recordBrowserDestination(outcome: "ALLOWED" | "DENIED", url: string): void {
  try {
    const file = resolve(process.cwd(), BROWSER_NETWORK_LEDGER);
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    const host = new URL(url).hostname;
    appendFileSync(file, `${JSON.stringify({ outcome, host })}\n`, "utf8");
  } catch {
    // Evidence, not a dependency.
  }
}

/**
 * PHASE 12 — POINT 7 CORRECTIVE PASS: the browser's outbound guard.
 *
 * The previous pass blocked the Google and Apple sign-in widgets by name. That
 * is an allowlist maintained by remembering, which is the same failure mode
 * that let the server processes reach production Sentry — so it is inverted
 * here: every request to a host this run did not start is ABORTED and
 * RECORDED, and the ledger becomes part of the proof.
 *
 * The abort is deliberate rather than a pass-through: a browser that silently
 * loaded a third-party telemetry script would still be contacting a real
 * external service during a run that claims to be hermetic.
 */
export async function blockThirdParties(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return route.continue();
    }
    const local =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost");
    if (local || url.startsWith("data:") || url.startsWith("blob:")) {
      recordBrowserDestination("ALLOWED", url);
      return route.continue();
    }
    recordBrowserDestination("DENIED", url);
    return route.abort();
  });
}

// ===========================================================================
// The test mailbox
// ===========================================================================

/**
 * Where the API's LOCAL RECORDING email provider stores what it accepted.
 *
 * PHASE 12 — POINT 7 (final pass). The browser and the API are different
 * processes, so an in-memory recorder would be invisible here. This file is
 * the seam, and it is what makes an invitation journey a real one: the test
 * opens the link a recipient would have received instead of reading the token
 * out of `team_invites`.
 *
 * Reading the token from the database looked equivalent and was not. It proved
 * that a row existed. It could not tell whether a message was ever accepted,
 * whether the link in it was the link the route intended, or whether a retry
 * would have sent a second one — and it passed identically in a run where
 * every send was refused at the socket.
 */
export const RECORDED_EMAIL_FILE =
  process.env.EMAIL_RECORDER_FILE ?? ".p7tmp/recorded-emails.jsonl";

export type RecordedEmailEntry = {
  deliveryIntentId: string | null;
  templateKind: string | null;
  recipientAlias: string;
  idempotencyAlias: string;
  attempt: number;
  result: "acknowledged" | "retryable" | "permanent" | "ambiguous";
  providerMessageId: string | null;
  subject: string;
  actionableLink: string | null;
  atUtc: string;
};

/** The recipient alias, derived exactly as the recording provider derives it. */
export function recipientAlias(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

/** Everything the recorder has stored so far. */
export function readMailbox(): RecordedEmailEntry[] {
  const path = resolve(process.cwd(), RECORDED_EMAIL_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecordedEmailEntry);
}

/**
 * Wait for a message addressed to `email`, optionally of a given template.
 *
 * Polls the file rather than the database, because the question being asked is
 * "did the recipient get a message?" and the database cannot answer it.
 */
export async function waitForRecordedEmail(input: {
  email: string;
  templateKind?: string;
  timeoutMs?: number;
}): Promise<RecordedEmailEntry> {
  const alias = recipientAlias(input.email);
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  let last: RecordedEmailEntry[] = [];
  for (;;) {
    last = readMailbox().filter(
      (m) =>
        m.recipientAlias === alias &&
        (input.templateKind === undefined || m.templateKind === input.templateKind),
    );
    const acknowledged = last.filter((m) => m.result === "acknowledged");
    if (acknowledged.length > 0) return acknowledged[acknowledged.length - 1]!;
    if (Date.now() > deadline) {
      throw new Error(
        `point7: no acknowledged ${input.templateKind ?? "any"} message for that ` +
          `recipient after ${input.timeoutMs ?? 10_000}ms ` +
          `(${last.length} non-acknowledged entries for the alias). ` +
          "A blocked real-provider attempt is NOT a delivery.",
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Messages for one recipient, whatever their outcome. */
export function mailboxFor(email: string, templateKind?: string): RecordedEmailEntry[] {
  const alias = recipientAlias(email);
  return readMailbox().filter(
    (m) =>
      m.recipientAlias === alias &&
      (templateKind === undefined || m.templateKind === templateKind),
  );
}

// ===========================================================================
// The test handset
// ===========================================================================

/**
 * Where the API's LOCAL RECORDING messaging provider stores what it accepted.
 *
 * PHASE 13. The same seam as the mailbox above, for the boundary the mailbox
 * could not cover. Publishing and unpublishing evidence to public verify are
 * gated by `requireStepUpForSensitiveAction`, which is satisfied ONLY by an
 * approved challenge whose one-time code arrives over SMS or WhatsApp. Twilio
 * Verify generates that code on its own side and never returns it, so nothing
 * local could read it back and the journey was not merely unproven — it was
 * unreachable, and every attempt died at a refused socket with the challenge
 * still PENDING.
 *
 * Reading the challenge row out of the database would NOT be equivalent, for
 * the same reason it was not equivalent for invitations: the row holds no code
 * (the service is explicit that the code is never persisted), so a database
 * read could only fake an approval by writing one — which proves the gate can
 * be written around, not that a user can pass it.
 */
export const RECORDED_MESSAGE_FILE =
  process.env.MESSAGING_RECORDER_FILE ?? ".p7tmp/recorded-messages.jsonl";

export type RecordedMessageEntry = {
  kind: "message" | "verification_start" | "verification_check";
  channel: "SMS" | "WHATSAPP";
  recipientAlias: string;
  idempotencyAlias: string;
  attempt: number;
  result:
    | "accepted"
    | "duplicate_collapsed"
    | "rejected"
    | "pending"
    | "approved"
    | "denied";
  providerMessageId: string | null;
  providerVerificationSid: string | null;
  /** The one-time code — present ONLY on a `verification_start` entry. */
  code: string | null;
  body: string;
  atUtc: string;
};

/**
 * The recipient alias, derived exactly as the recording provider derives it.
 *
 * Identical formula to {@link recipientAlias} above — trim, lowercase,
 * sha256, first 16 hex characters — so the two boundaries carry one aliasing
 * idea. The number itself never appears in the recorder file.
 */
export function recipientPhoneAlias(e164: string): string {
  return createHash("sha256")
    .update(e164.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

/** Everything the messaging recorder has stored so far. */
export function readMessages(): RecordedMessageEntry[] {
  const path = resolve(process.cwd(), RECORDED_MESSAGE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecordedMessageEntry);
}

/**
 * Wait for a one-time code sent to `recipient`, and hand it back.
 *
 * Polls the file rather than the database, because the question being asked is
 * "could a user have completed this challenge?" and the database cannot answer
 * it — the code is deliberately never persisted there.
 *
 * Returns the LATEST `verification_start` for the recipient, so a spec that
 * re-renders the challenge screen gets the code the user would currently be
 * looking at. A repeated start collapses onto the pending verification in the
 * provider, so that is the same code, not a newer one.
 */
export async function waitForRecordedMessage(input: {
  recipient: string;
  kind?: RecordedMessageEntry["kind"];
  timeoutMs?: number;
}): Promise<RecordedMessageEntry> {
  const alias = recipientPhoneAlias(input.recipient);
  const kind = input.kind ?? "verification_start";
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  let last: RecordedMessageEntry[] = [];
  for (;;) {
    last = readMessages().filter(
      (m) => m.recipientAlias === alias && m.kind === kind,
    );
    const usable = last.filter(
      (m) => m.result === "pending" || m.result === "accepted" || m.result === "approved",
    );
    if (usable.length > 0) return usable[usable.length - 1]!;
    if (Date.now() > deadline) {
      throw new Error(
        `point7: no ${kind} entry for that recipient after ` +
          `${input.timeoutMs ?? 10_000}ms (${last.length} non-usable entries ` +
          "for the alias). A blocked real-provider attempt is NOT a delivery, " +
          "and a PENDING challenge with no recorded code means the messaging " +
          "boundary was skipped rather than exercised.",
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * The one-time code a user would have retyped, as a string.
 *
 * The thin wrapper a step-up spec actually wants. The journey is:
 *
 *   1. `POST /v1/identity-security/step-up/start`  { teamId, purpose,
 *      resourceKind, resourceId, phone, channel } → { challenge.id }
 *   2. `await waitForStepUpCode({ recipient: phone })`
 *   3. `POST /v1/identity-security/step-up/check` { teamId, challengeId,
 *      phone, code } → APPROVED
 *   4. the guarded call, carrying `x-proovra-step-up-challenge-id: <challengeId>`
 *      — e.g. `POST /v1/governance/evidence/:id/publish`
 *
 * Anything that reaches past step 2 into the database is asserting that a row
 * exists, not that the gate can be passed: the challenge row deliberately holds
 * no code, so a database read could only fake an approval by writing one.
 */
export async function waitForStepUpCode(input: {
  recipient: string;
  timeoutMs?: number;
}): Promise<string> {
  const entry = await waitForRecordedMessage({
    recipient: input.recipient,
    kind: "verification_start",
    timeoutMs: input.timeoutMs,
  });
  if (!entry.code) {
    throw new Error(
      "point7: a verification_start was recorded with no code. The recording " +
        "messaging provider is the only provider that mints one locally — this " +
        "means a different provider served the request.",
    );
  }
  return entry.code;
}

/** Recorder entries for one recipient, whatever their kind or outcome. */
export function handsetFor(
  recipient: string,
  kind?: RecordedMessageEntry["kind"],
): RecordedMessageEntry[] {
  const alias = recipientPhoneAlias(recipient);
  return readMessages().filter(
    (m) => m.recipientAlias === alias && (kind === undefined || m.kind === kind),
  );
}

// ===========================================================================
// The product-run outbound ledger, as seen from a spec
// ===========================================================================

/**
 * The API process's outbound ledger for THIS run.
 *
 * A spec reads it to assert the negative that matters: that a journey which
 * depends on an external boundary completed WITHOUT anything reaching for the
 * real one. Asserting only that the journey succeeded would have passed in the
 * previous run too, where eighteen provider attempts were quietly refused.
 */
export const PRODUCT_LEDGER_FILE =
  process.env.P7_PRODUCT_LEDGER ?? ".p7tmp/product-run-network.jsonl";

export type LedgerEntry = {
  runId: string;
  buildId: string;
  phase: string;
  process: string;
  scenarioId: string;
  host: string;
  category: string;
  outcome: "ALLOWED" | "BLOCKED";
  transportAuthority: string;
  boundedCallSite: string;
  atUtc: string;
};

/** Non-loopback entries only — loopback is the disposable stack, not egress. */
export function readProductLedger(): LedgerEntry[] {
  const path = resolve(process.cwd(), PRODUCT_LEDGER_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerEntry)
    .filter((e) => e.category !== "loopback-disposable");
}

export type RequestLog = {
  all: Request[];
  /** API requests only, in order. */
  api(): Request[];
  urls(): string[];
  /** Requests whose URL contains a fragment — the correlation primitive. */
  matching(fragment: string): Request[];
};

export function recordRequests(page: Page): RequestLog {
  const all: Request[] = [];
  page.on("request", (r) => all.push(r));
  return {
    all,
    api: () => all.filter((r) => r.url().startsWith(API_BASE)),
    urls: () => all.map((r) => r.url()),
    matching: (fragment: string) => all.filter((r) => r.url().includes(fragment)),
  };
}

/**
 * THE COOKIE BANNER IS A PRECONDITION, NOT A SUBJECT.
 *
 * The consent manager renders a modal over the page until the visitor answers
 * it, and it is `position: fixed` — so Playwright resolves a button, finds it
 * visible and enabled, and then every click is intercepted by
 * `#cc-main`. A long UI journey does not fail an assertion; it burns its
 * timeout retrying a click that can never land.
 *
 * It did not use to appear here. `vanilla-cookieconsent` defaults
 * `hideFromBots` to true, which suppressed the banner whenever
 * `navigator.webdriver` was set — every automated run. That default was turned
 * OFF deliberately (`f1d4ba49`): it does not merely hide the banner, it skips
 * building the consent DOM at all, which left "Manage cookie preferences" in
 * Settings unable to open a dialog for any real person the heuristic misfired
 * on. Hiding a consent control from the people most likely to want it is a
 * worse bug than a blocked test.
 *
 * So the banner is answered the way a returning user's browser answers it:
 * with the record the manager writes once consent has been given. These
 * accounts are signed-in operators driving product journeys, not first-time
 * visitors deciding about cookies, and nothing in Point 7 asserts anything
 * about the banner. `lastConsentTimestamp` and `expirationTime` are required —
 * a record without them is treated as invalid and the banner returns.
 */
const ANSWERED_COOKIE_CONSENT = JSON.stringify({
  // NECESSARY ONLY — and that is not merely the polite default.
  //
  // Accepting analytics here switched the analytics client ON, and its calls
  // fail against the point7 API with "Invalid analytics payload". Every point7
  // journey ends in `assertClean`, which requires an empty console, so a
  // consent record that opted IN failed seven journeys that had nothing to do
  // with consent. Declining non-essential categories is the answer a
  // privacy-respecting default gives anyway.
  categories: ["necessary"],
  revision: 1,
  data: null,
  consentTimestamp: "2026-01-01T00:00:00.000Z",
  consentId: "point7-consent",
  services: { necessary: [], preferences: [], analytics: [], marketing: [] },
  languageCode: "en",
  lastConsentTimestamp: "2026-01-01T00:00:00.000Z",
  expirationTime: 4102444800000,
});

/** Seed the consent record before any page script runs, on every navigation. */
async function answerCookieBanner(page: Page): Promise<void> {
  await page.addInitScript((value: string) => {
    document.cookie = `cc_cookie=${encodeURIComponent(value)};path=/`;
  }, ANSWERED_COOKIE_CONSENT);
}

/**
 * Sign in through the REAL login form.
 *
 * Not by injecting a token, not by seeding a cookie: the point of a browser
 * layer is that the session was established the way a user establishes one, so
 * everything downstream — the cookie, the platform-context bootstrap, the
 * workspace restoration — is the production path.
 */
export async function login(page: Page, account: BrowserAccount): Promise<void> {
  await resetRateLimits();
  await blockThirdParties(page);
  await answerCookieBanner(page);
  await page.goto(`${WEB_BASE}/login`, { waitUntil: "domcontentloaded" });
  const form = page.locator('form:has(input[type="password"])').first();
  await form.locator('input[type="email"]').fill(account.email);
  await form.locator('input[type="password"]').fill(account.password);
  // The real form requires the legal acknowledgement before it will submit —
  // a real user ticks it, so the harness does too rather than bypassing the
  // form and posting to the endpoint.
  const legal = form.locator('input[type="checkbox"]').first();
  if ((await legal.count()) > 0 && !(await legal.isChecked())) {
    await legal.check();
  }
  const loginResponse = page.waitForResponse(
    (r) => r.url().includes("/v1/auth/email/login"),
    { timeout: 30_000 },
  );
  await form.locator('button[type="submit"]').first().click();
  const res = await loginResponse;
  expect(
    res.status(),
    `login for ${account.email} failed: ${await res.text().catch(() => "")}`,
  ).toBeLessThan(300);
  // The session is established when the app has left /login.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
}

/** The platform-context envelope this browser session is actually holding. */
export async function envelopeFromBrowser(page: Page): Promise<Record<string, unknown>> {
  const body = await page.evaluate(async (apiBase) => {
    const r = await fetch(`${apiBase}/v1/platform/context`, {
      credentials: "include",
      headers: { "x-platform-context-version": "3" },
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, API_BASE);
  expect(body.status).toBe(200);
  return body.json as Record<string, unknown>;
}

/**
 * Issue a request from INSIDE the authenticated page.
 *
 * This is how a "direct API call" is made honestly: it carries the browser's
 * own credentials and origin, so a denial proves the SERVER refused rather
 * than that the harness forgot a cookie.
 */
export async function directApiCall(
  page: Page,
  input: { method: string; path: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ([apiBase, method, path, body]) => {
      const r = await fetch(`${apiBase}${path}`, {
        method: method as string,
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : {},
        ...(body ? { body: body as string } : {}),
      });
      return { status: r.status, body: await r.text() };
    },
    [
      API_BASE,
      input.method,
      input.path,
      input.body === undefined ? null : JSON.stringify(input.body),
    ] as const,
  );
}

// ===========================================================================
// Proof recording
// ===========================================================================

/**
 * Record that a scenario was proven at the BROWSER layer.
 *
 * Appended AFTER the assertions pass. Playwright runs specs in separate
 * workers, so the ids travel to disk and one recorder writes the artifact —
 * see `recordScenarioProof({ scenarios })`.
 */
export function provenBrowserScenario(suiteRelPath: string, id: string): void {
  const file = resolve(process.cwd(), BROWSER_PROOF_FILE);
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ suite: suiteRelPath, id })}\n`, "utf8");
}
