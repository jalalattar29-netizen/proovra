/**
 * PHASE 13 §2 — BROWSER fixtures for the step-up and error-envelope journeys.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `apps/web/__tests__/phase13-api-error-envelope.test.ts` already drives the
 * real `apiFetch` against a stubbed `fetch` and proves the two defects at the
 * unit layer — NEW-030 gave `ApiError` a `body`, and NEW-032 made a NESTED CODE
 * WITH NO MESSAGE the standard shape rather than a fall-through to the generic
 * branch. What a stubbed `fetch` cannot prove is the thing the defects actually
 * broke: that a REAL denial from a REAL route reaches a REAL component in a
 * production browser build and changes what the user sees.
 *
 * So this file provides only boundary machinery — fixture state, response
 * correlation, and an RFC-6238 code generator standing in for the user's phone.
 * Nothing in the application is substituted: not `apiFetch`, not
 * `extractStepUp`, not `StepUpVerify`, not the routes. Every denial asserted by
 * the accompanying spec is produced by constructing the SERVER-SIDE PRECONDITION
 * the route checks, never by intercepting or rewriting a response.
 *
 * THE COPY TABLE IS PART OF THE PROOF
 * ---------------------------------------------------------------------------
 * `DENIAL_COPY` pins the EXACT sentence each denial code is supposed to
 * produce, and `GENERIC_FALLBACK_COPY` pins the sentences that mean the branch
 * did NOT fire. Asserting only "some error appeared" is precisely the assertion
 * that stayed green throughout the period when `err.body` was `undefined` and
 * every specific branch in the application silently rendered the generic
 * fallback instead.
 *
 * NAMING: this file deliberately does NOT end in `.spec.ts`. The point7
 * Playwright project takes `e2e/point7` as its testDir, so a helper matching the
 * default testMatch would be collected as an empty suite and reported as a
 * failure.
 */

import { expect, type Page } from "@playwright/test";

// The TOTP primitives are imported from the PRODUCTION implementation rather
// than reimplemented here. A second RFC-6238 implementation in the test tree
// could agree with itself while disagreeing with the server, which would make
// a green run mean nothing; and a code the server rejects would be
// indistinguishable from a step-up defect.
import {
  computeTotpCode,
  decodeBase32,
  timeStep,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from "../../services/api/src/services/security/mfa-totp";

import { API_BASE, WEB_BASE, directApiCall, sql } from "./_harness";

// ===========================================================================
// The server-side literals these journeys depend on
// ===========================================================================

/**
 * The typed confirmation phrases, as the ROUTES define them.
 *
 * Restated here rather than imported because the routes hold them as
 * function-local `const`s that are not exported — so this is the one place a
 * rename would have to be mirrored, and the specs assert the SERVER's own
 * `confirmation_mismatch` message text, which embeds the phrase. A drift
 * therefore fails loudly rather than silently weakening an assertion.
 */
export const WORKSPACE_CLOSURE_PHRASE = "close this workspace";
export const ORG_CLOSURE_PHRASE = "close this organization";

/**
 * The EXACT user-facing sentence each denial code must produce.
 *
 * Every one of these is rendered by a branch keyed on
 * `err.body?.error?.code` — the sixteen call sites NEW-030 broke. Three of the
 * five codes (`owner_required`, `target_not_member`, `closure_blocked`) are
 * sent by the server as a nested code with NO `message` at all, which is the
 * exact body shape NEW-032 was about: before the fix those arrived as a plain
 * `Error` with code `API_ERROR` and no `body`, so these sentences were
 * unreachable and the user got the generic fallback instead.
 *
 *   owner_required          services/api/src/routes/organizations.routes.ts:2090
 *   target_not_member       services/api/src/routes/organizations.routes.ts:2183
 *   closure_blocked         services/api/src/routes/teams.routes.ts:3020
 *   closure_request_active  services/api/src/routes/teams.routes.ts:2986
 *   confirmation_mismatch   services/api/src/routes/teams.routes.ts:2959
 *
 * `confirmation_mismatch` is the SERVER's own message rendered verbatim
 * (`e.body?.error?.message`), which makes it the one case that proves the
 * message field of the envelope survived `apiFetch`, not merely the code.
 */
export const DENIAL_COPY = {
  owner_required: "Only the organization owner can transfer ownership.",
  target_not_member:
    "The selected user is no longer a member of this organization.",
  closure_blocked:
    "Closure is blocked — resolve the listed items and try again.",
  closure_request_active:
    "A closure request for this workspace is already open.",
  confirmation_mismatch: `Type "${WORKSPACE_CLOSURE_PHRASE}" to confirm.`,
} as const;

/**
 * Sentences that mean the specific branch did NOT fire.
 *
 * Two families: the per-call-site fallbacks passed to `toSafeUserError`, and
 * the shared bounded copy `toSafeUserError` itself produces. A test that
 * asserts the specific sentence is present but never asserts these are absent
 * would still pass if the component rendered both.
 */
export const GENERIC_FALLBACK_COPY = [
  "Could not request closure.",
  "Could not transfer ownership.",
  "Please try again. Your evidence data has not been changed.",
  "Please review your input and try again.",
] as const;

/**
 * The bounded copy `toSafeUserError` produces for an UNMAPPED code on a 403.
 *
 * Not a defect on its own — it is the safety net working. It is named here so
 * the unknown-code scenario can assert that the net is what caught the fall,
 * rather than a raw backend string or an empty box.
 */
export const BOUNDED_FORBIDDEN_COPY =
  "This workspace or feature may require additional permissions.";

// ===========================================================================
// Page hygiene: the negatives every scenario owes
// ===========================================================================

export type PageWatch = {
  /** Uncaught exceptions in the page. Never filtered. */
  pageErrors: string[];
  /** Application console errors, after the two documented boundary filters. */
  consoleErrors: string[];
  /** `/v1/*` requests that went to the WEB origin instead of the API origin. */
  webOriginApiRequests: string[];
  /** Assert all three negatives, plus the page's own CSP violation reports. */
  assertClean: (label: string) => Promise<void>;
};

/**
 * Console output the BROWSER ITSELF emits about the transport, which is not an
 * application console error and must not be read as one.
 *
 * Exactly three exemptions, each with a reason and each deliberately narrow:
 *
 *   1. `Failed to load resource: the server responded with a status of 4xx` —
 *      Chromium logs every non-2xx subresource at console `error` level. These
 *      journeys exist to PRODUCE 4xx denials, so treating them as failures
 *      would make "a clean console while a denial is on screen" impossible to
 *      state. Restricted to the 4xx range: a 5xx stays fatal, because a server
 *      fault masquerading as a denial is one of the things Point 7 exists to
 *      catch. Deliberately NOT conditioned on the reporting origin — Chromium
 *      attributes this message inconsistently between the request URL and the
 *      document, and a filter that depends on which one it picked is a filter
 *      that fails for a reason unrelated to the product. A misdirected `/v1`
 *      request is caught by its own dedicated assertion instead, which does not
 *      rely on console attribution at all.
 *   2. `net::ERR_ABORTED` — an abort is a CANCELLED request, never an
 *      application error: navigating away while a fetch is in flight produces
 *      one on every run.
 *   3. `net::ERR_FAILED` / `net::ERR_BLOCKED_BY_CLIENT` for a NON-LOCAL host —
 *      the harness's own outbound guard aborts third-party requests on purpose,
 *      and that abort is what makes the run hermetic. Local hosts are NOT
 *      excused: a failed request to the API or the web app is a real finding.
 *
 * Everything else — React errors, hydration failures, uncaught rejections,
 * CSP reports — is a failure.
 */
function isBoundaryConsoleNoise(text: string, locationUrl: string): boolean {
  if (
    /Failed to load resource: the server responded with a status of 4\d\d/.test(
      text,
    )
  ) {
    return true;
  }
  if (/net::ERR_ABORTED/.test(text)) return true;

  let host = "";
  try {
    host = new URL(locationUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const local =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost");
  if (!local && /net::ERR_(FAILED|BLOCKED_BY_CLIENT)/.test(text)) return true;
  return false;
}

/**
 * Start watching a page for the negatives every scenario in this suite owes.
 *
 * MUST be called before the first navigation: the CSP listener is installed as
 * an init script so it is present in every document the run creates, including
 * the login page. `securitypolicyviolation` is used rather than console
 * scraping because a nonce mismatch under a `script-src` policy can block a
 * bundle without the page ever logging anything the harness could match on —
 * which is exactly how a CSP regression stayed invisible in an earlier pass.
 */
export async function watchPage(page: Page): Promise<PageWatch> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const webOriginApiRequests: string[] = [];

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const url = msg.location()?.url ?? "";
    if (isBoundaryConsoleNoise(text, url)) return;
    consoleErrors.push(`${text}  @ ${url}`);
  });
  page.on("request", (req) => {
    const url = req.url();
    // The one shape AUDIT-002/003 named: a RELATIVE `/v1/…` fetch resolves
    // against the WEB origin, where there is no rewrite, so it 404s against
    // Next and never reaches the API at all.
    if (url.startsWith(WEB_BASE) && url.includes("/v1/")) {
      webOriginApiRequests.push(url);
    }
  });

  await page.addInitScript(() => {
    const w = window as unknown as { __p7CspViolations?: string[] };
    w.__p7CspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      const e = event as SecurityPolicyViolationEvent;
      (w.__p7CspViolations ??= []).push(
        `${e.violatedDirective} blocked ${e.blockedURI}`,
      );
    });
  });

  return {
    pageErrors,
    consoleErrors,
    webOriginApiRequests,
    assertClean: async (label: string) => {
      const csp = await page
        .evaluate(
          () =>
            (window as unknown as { __p7CspViolations?: string[] })
              .__p7CspViolations ?? [],
        )
        .catch(() => [] as string[]);
      expect(pageErrors, `${label}: uncaught exception in the page`).toEqual([]);
      expect(consoleErrors, `${label}: application console error`).toEqual([]);
      expect(csp, `${label}: content-security-policy violation`).toEqual([]);
      expect(
        webOriginApiRequests,
        `${label}: a /v1 request was addressed to the WEB origin`,
      ).toEqual([]);
    },
  };
}

// ===========================================================================
// Response correlation
// ===========================================================================

export type ObservedResponse = {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
};

/**
 * Run a UI action and return the API response it caused.
 *
 * The waiter is armed BEFORE the action so a fast response cannot be missed,
 * and the match is narrowed by METHOD as well as path because these surfaces
 * re-read the same URL with a GET immediately after every mutation — a
 * path-only match would frequently correlate the click with the reload.
 *
 * This observes; it never modifies. The status and body returned here are the
 * server's, and the assertions in the spec compare them with what the DOM then
 * shows, which is the correlation that makes a rendered sentence evidence
 * about the product rather than about the markup.
 *
 * ONE ORDERING RULE THE CALLERS MUST KEEP
 * ---------------------------------------------------------------------------
 * `apiFetch` runs with `retryAuthOnce` on by default, and that retry fires on
 * ANY 401 — including a step-up denial. So a single click that is answered
 * 401 emits TWO identical requests, and the component's catch block runs only
 * after the SECOND one. This helper resolves on the FIRST match, which means a
 * caller must not arm the next waiter until the DOM has visibly reacted (the
 * panel appeared, the message changed). Every caller in the accompanying spec
 * asserts a DOM consequence between two `awaitApiResponse` calls for exactly
 * this reason; skipping that assertion would let the second waiter correlate
 * with the automatic replay of the first click instead of the user's next one.
 */
export async function awaitApiResponse(
  page: Page,
  match: { fragment: string; method?: string },
  action: () => Promise<void>,
  timeoutMs = 25_000,
): Promise<ObservedResponse> {
  const waiter = page.waitForResponse(
    (res) =>
      res.url().startsWith(API_BASE) &&
      res.url().includes(match.fragment) &&
      (match.method === undefined || res.request().method() === match.method),
    { timeout: timeoutMs },
  );
  await action();
  const res = await waiter;
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status(), text, json };
}

/** The `error` object of an observed denial, or null when there is none. */
export function denialEnvelope(
  res: ObservedResponse,
): Record<string, unknown> | null {
  const err = res.json?.["error"];
  return err && typeof err === "object" ? (err as Record<string, unknown>) : null;
}

// ===========================================================================
// TOTP — the test acting as the user's authenticator app
// ===========================================================================

/**
 * The current RFC-6238 code for a Base32 secret.
 *
 * The secret comes from the PRODUCT's own one-time enrolment display
 * (`POST /v1/identity/mfa/enroll/start` returns `secretBase32`, exactly as a
 * user who cannot scan a QR code receives it), so this function is doing what
 * the user's phone does and nothing more.
 *
 * Seeding an `mfa_factors` row by raw SQL is NOT an option and the reason is
 * structural: the TOTP secret is sealed with AES-256-GCM under a key resolved
 * inside the API process (`MFA_SECRET_KEK_BASE64`, or a scrypt-derived
 * dev fallback), so a row written from here could only be decrypted by
 * reimplementing that key derivation in the test tree — which would put a copy
 * of a security primitive somewhere it can drift.
 */
export function totpCodeFor(secretBase32: string, stepOffset = 0): string {
  const secret = decodeBase32(secretBase32);
  const step = timeStep(Math.floor(Date.now() / 1000), TOTP_PERIOD_SECONDS);
  return computeTotpCode(secret, step + stepOffset, TOTP_DIGITS);
}

/**
 * A syntactically valid code that is guaranteed WRONG right now.
 *
 * Deliberately not a hardcoded "000000": that has a one-in-a-million chance per
 * step of being the real code, and a suite that fails once a year for a reason
 * nobody can reproduce is worse than no suite. This walks candidates until it
 * finds one outside the server's entire ±1-step acceptance window, so the
 * denial it produces is a property of the code being wrong rather than luck.
 */
export function invalidTotpCodeFor(secretBase32: string): string {
  const secret = decodeBase32(secretBase32);
  const step = timeStep(Math.floor(Date.now() / 1000), TOTP_PERIOD_SECONDS);
  const accepted = new Set(
    [-1, 0, 1].map((d) => computeTotpCode(secret, step + d, TOTP_DIGITS)),
  );
  for (let n = 0; n < accepted.size + 2; n += 1) {
    const candidate = String(n).padStart(TOTP_DIGITS, "0");
    if (!accepted.has(candidate)) return candidate;
  }
  /* c8 ignore next */
  throw new Error("point7: could not construct an invalid TOTP code");
}

/**
 * Enrol a TOTP factor through the REAL enrolment routes, from inside the
 * authenticated page.
 *
 * Both legs are the production endpoints: `enroll/start` mints and seals the
 * secret server-side and hands back the Base32 the user would type into their
 * app; `enroll/verify` requires a code computed from that secret and is what
 * moves the factor from ENROLLING to ACTIVE. Nothing about the account's MFA
 * state is written by the harness.
 */
export async function enrolTotpFactor(
  page: Page,
): Promise<{ factorId: string; secretBase32: string }> {
  const start = await directApiCall(page, {
    method: "POST",
    path: "/v1/identity/mfa/enroll/start",
    body: { label: "p7 authenticator" },
  });
  expect(start.status, `mfa enroll/start: ${start.body}`).toBeLessThan(300);
  const started = JSON.parse(start.body) as {
    factorId: string;
    secretBase32: string;
  };
  expect(started.secretBase32.length).toBeGreaterThan(0);

  const verify = await directApiCall(page, {
    method: "POST",
    path: "/v1/identity/mfa/enroll/verify",
    body: { factorId: started.factorId, code: totpCodeFor(started.secretBase32) },
  });
  expect(verify.status, `mfa enroll/verify: ${verify.body}`).toBeLessThan(300);

  const rows = await sql<{ status: string }>(
    `SELECT status FROM mfa_factors WHERE id = $1`,
    [started.factorId],
  );
  expect(rows[0]?.status, "the enrolled factor must be ACTIVE").toBe("ACTIVE");
  return started;
}

/**
 * Remove the account's password so the ONLY step-up proof it can offer is its
 * authenticator.
 *
 * This is fixture state describing a real account shape — an OAuth-only account
 * that later enrolled TOTP — and it is what makes `methods` load-bearing:
 * `StepUpVerify` renders the password field whenever `methods` contains
 * "password", so an account with both would render the same panel whether or
 * not `methods` survived the envelope. With only "mfa" available, the panel can
 * only render the authenticator field if the array actually arrived.
 *
 * Applied AFTER sign-in, because a password account signs in with its password.
 */
export async function dropPasswordCredential(userId: string): Promise<void> {
  await sql(`UPDATE users SET password_hash = NULL WHERE id = $1`, [userId]);
  const rows = await sql<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [userId],
  );
  expect(rows[0]?.password_hash).toBeNull();
}

// ===========================================================================
// Workspace + organization fixtures
// ===========================================================================

/**
 * Create an OWNED workspace through the real route, from inside the page.
 *
 * `POST /v1/teams` is plan-gated, so the calling account must be PRO or better;
 * the created row's `ownerUserId` is the caller, which is the bar the closure
 * and transfer routes check (a stricter bar than the OWNER team-role the UI
 * reads for its affordances).
 */
export async function createOwnedWorkspace(
  page: Page,
  name: string,
): Promise<string> {
  const res = await directApiCall(page, {
    method: "POST",
    path: "/v1/teams",
    body: { name },
  });
  expect(res.status, `create owned workspace: ${res.body}`).toBeLessThan(300);
  return (JSON.parse(res.body) as { id: string }).id;
}

/**
 * Give a workspace an active billing relationship.
 *
 * The single cheapest way to produce a REAL `closure_blocked`: the workspace
 * closure preflight raises BILLING_SUBSCRIPTION_ACTIVE for a team whose
 * `billingStatus` is ACTIVE or PAST_DUE
 * (services/api/src/services/identity/account-lifecycle-preflight.service.ts:330).
 * The blocker is computed by the production preflight; only the state it reads
 * is seeded.
 */
export async function makeWorkspaceBillingActive(teamId: string): Promise<void> {
  await sql(
    `UPDATE teams SET billing_status = 'ACTIVE', updated_at = NOW() WHERE id = $1`,
    [teamId],
  );
}

/** Every closure request row for a workspace, newest first. */
export async function workspaceClosureRows(
  teamId: string,
): Promise<Array<{ id: string; status: string }>> {
  return sql<{ id: string; status: string }>(
    `SELECT id, status FROM workspace_closure_requests
      WHERE team_id = $1 ORDER BY requested_at_utc DESC`,
    [teamId],
  );
}

export type ProvisionedOrg = {
  organizationId: string;
  workspaceId: string;
};

/**
 * Provision a CUSTOMER Organization with one ORGANIZATION workspace, an owner
 * and one ordinary member.
 *
 * Seeded rather than driven, and deliberately so: enterprise provisioning is
 * Point 4's subject, and what these scenarios are about is how a member's
 * BROWSER behaves once the organization exists. The shape mirrors the one the
 * plan matrix already provisions, so a schema change breaks both together
 * rather than leaving one silently seeding an organization the resolver no
 * longer recognises.
 */
export async function provisionOrganizationWithMember(input: {
  ownerUserId: string;
  memberUserId: string;
}): Promise<ProvisionedOrg> {
  const name = `p7-su-org-${Date.now().toString(36)}`;
  const org = (
    await sql<{ id: string }>(
      `INSERT INTO organizations (name, billing_owner_user_id, status, kind, updated_at)
       VALUES ($1, $2, 'ACTIVE'::"OrganizationStatus", 'CUSTOMER'::"OrganizationKind", NOW())
       RETURNING id`,
      [name, input.ownerUserId],
    )
  )[0]!;
  await sql(
    `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
     VALUES ($1, $2, 'ORG_OWNER'::"OrganizationRole", NOW())`,
    [org.id, input.ownerUserId],
  );
  await sql(
    `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
     VALUES ($1, $2, 'ORG_MEMBER'::"OrganizationRole", NOW())`,
    [org.id, input.memberUserId],
  );
  const ws = (
    await sql<{ id: string }>(
      `INSERT INTO teams (name, owner_user_id, billing_owner_user_id, is_personal,
                          organization_id, workspace_kind, billing_plan, billing_status, updated_at)
       VALUES ($1, $2, $2, false, $3, 'ORGANIZATION'::"WorkspaceKind",
               'ENTERPRISE'::"PlanType", 'ACTIVE', NOW())
       RETURNING id`,
      [`${name}-ws`, input.ownerUserId, org.id],
    )
  )[0]!;
  await sql(
    `INSERT INTO team_members (team_id, user_id, role, status)
     VALUES ($1, $2, 'OWNER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
    [ws.id, input.ownerUserId],
  );
  await sql(
    `INSERT INTO organization_security_policies (organization_id, team_id, no_personal_space, updated_at)
     VALUES ($1, $2, false, NOW())`,
    [org.id, ws.id],
  );
  await sql(
    `INSERT INTO enterprise_contracts (organization_id, status, updated_at)
     VALUES ($1, 'ACTIVE'::"EnterpriseContractStatus", NOW())`,
    [org.id],
  );
  return { organizationId: org.id, workspaceId: ws.id };
}

/** The organization role a user currently holds, or null when not a member. */
export async function orgRoleOf(
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const rows = await sql<{ role: string }>(
    `SELECT role FROM organization_memberships
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  return rows[0]?.role ?? null;
}
