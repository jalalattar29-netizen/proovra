/**
 * Tiny API client for Playwright E2E. Avoids importing the web's
 * `lib/api.ts` so the helpers can drive the stack from a Node process
 * before/without the browser surface.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { request as pwRequest, APIRequestContext } from "@playwright/test";

export const API_BASE = process.env.API_BASE ?? "http://localhost:8081";

/**
 * Phase 2.7Z+ — E2E auth rate-limit bypass token.
 *
 * Read from the test process env. When set (and matching the API's
 * `E2E_AUTH_BYPASS_SECRET`), every guest-auth request sends a
 * `X-E2E-Auth-Bypass` header so the API skips the 5/min/IP guest
 * rate limit for that request. Production NEVER sets this env var,
 * and the API independently refuses to honor the bypass when
 * `NODE_ENV === "production"`.
 *
 * If unset locally, the helper falls back to the documented
 * test-only default that ships in `.env.audit-local.example`. The
 * fallback is intentionally a long stable string so a developer
 * who copied the example env never has to think about this.
 */
const E2E_BYPASS_SECRET =
  (process.env.E2E_AUTH_BYPASS_SECRET ?? "").trim() ||
  "e2e-bypass-do-not-use-in-prod-7f2c3a91b4d9e8f10c2b3a4d5e6f70819";

/**
 * Phase 2.7Z+ — Clear the rate-limit buckets via the in-process
 * test-only reset endpoint.
 *
 * Why this changed:
 *   The previous helper ran `docker exec proovra_redis redis-cli ...`
 *   via `execSync` with `stdio: "ignore"`. That command relied on
 *   `xargs -r` being available in the host shell, which is not
 *   universal (notably Git Bash on Windows). When `xargs -r` was
 *   missing OR when no keys matched OR when the docker-compose
 *   container name drifted, the scrubber silently failed and
 *   subsequent tests inherited polluted bucket state.
 *
 *   The endpoint-based approach is host-shell-agnostic and reports
 *   the operation back to the helper, so silent failures are
 *   impossible. The endpoint clears BOTH the in-memory limiter map
 *   and the `ratelimit:*` Redis keyspace in a single call.
 *
 * Hard rules:
 *
 *   - The endpoint is `POST /v1/_test/rate-limit/reset`, gated by
 *     the same three-layer E2E defense as the auth-bypass helper
 *     (NODE_ENV != production + 32+ char env secret + header match).
 *     Production returns 404 from this path — the surface is
 *     undiscoverable.
 *
 *   - This helper is the ONLY way E2E tests interact with rate-
 *     limit state. It does not weaken production semantics; the
 *     limiter behavior on a real request remains identical.
 *
 *   - On endpoint unreachable / network error / 404 (env not set
 *     on the API), the helper degrades gracefully and logs a
 *     debug line. The test still proceeds; if the bucket happens
 *     to be empty (fresh API process) the test passes; if it's
 *     full, that test's assertion drives the failure cleanly.
 */
const E2E_BYPASS_SECRET_FOR_RESET =
  (process.env.E2E_AUTH_BYPASS_SECRET ?? "").trim() ||
  "e2e-bypass-do-not-use-in-prod-7f2c3a91b4d9e8f10c2b3a4d5e6f70819";

export async function clearTestRateLimits(): Promise<void> {
  try {
    const r = await fetch(`${API_BASE}/v1/_test/rate-limit/reset`, {
      method: "POST",
      headers: { "X-E2E-Auth-Bypass": E2E_BYPASS_SECRET_FOR_RESET },
    });
    // 200 — buckets cleared (response body has counts; we don't need them).
    // 404 — endpoint disabled (E2E_AUTH_BYPASS_SECRET unset, NODE_ENV=production,
    //       or header mismatch). Acceptable on CI without the env set —
    //       tests will rely on a fresh per-job API process for isolation.
    // Anything else — log but don't throw; the bucket state will simply
    // determine the next test's behavior honestly.
    if (r.status !== 200 && r.status !== 404) {
      // eslint-disable-next-line no-console
      console.warn(
        `[clearTestRateLimits] unexpected status ${r.status}; bucket state may leak`,
      );
    }
  } catch {
    // Network error (API briefly down during restart). Don't fail the
    // test setup; the test's own assertions handle the consequences.
  }
}

export type GuestSession = {
  token: string;
  userId: string;
  /** The registered address. Enterprise provisioning is keyed by it. */
  email: string;
  api: APIRequestContext;
};

export async function makeApi(token?: string): Promise<APIRequestContext> {
  // Phase 2.7Z+ — always send the E2E bypass header. The API only
  // honors it when its own env-set secret matches AND NODE_ENV is
  // not production. Sending the header on every request (including
  // those that aren't rate-limited) is harmless: the API ignores it
  // on non-rate-limited routes.
  const headers: Record<string, string> = {
    "X-E2E-Auth-Bypass": E2E_BYPASS_SECRET,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return pwRequest.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: headers,
  });
}

/**
 * VERIFICATION HAPPENS IN THE DATABASE, BECAUSE IT CANNOT HAPPEN ANY OTHER
 * WAY HERE.
 *
 * `POST /v1/auth/email/login` refuses an unverified account (403
 * EMAIL_NOT_VERIFIED, and correctly so). The only route that clears the flag
 * is `POST /v1/auth/email/verify`, which needs the emailed token — and this
 * stack has notifications disabled (`verificationSent: false`) while the token
 * is stored only as a SHA-256 hash, so there is nothing to replay.
 *
 * The work is done by `services/api/scripts/e2e-account.mjs`, in its own
 * process, for two reasons: `pg` is a dependency of that package and ESM
 * resolves from the importing FILE, and that script refuses any DATABASE_URL
 * whose host is not local. Spawned rather than imported so neither
 * `import.meta` nor `createRequire` appears in a file Playwright transpiles to
 * CommonJS — both were tried, and both break collection with "exports is not
 * defined in ES module scope".
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `Could not find the workspace root above ${process.cwd()} — the e2e ` +
      "session helper needs it to locate services/api.",
  );
}

function prepareAccount(email: string, plan?: string): void {
  const root = repoRoot();
  const args = [join(root, "services", "api", "scripts", "e2e-account.mjs"), `--email=${email}`];
  if (plan) args.push(`--plan=${plan}`);
  const run = spawnSync(process.execPath, args, {
    cwd: join(root, "services", "api"),
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(
      `Could not prepare the e2e account ${email} (exit ${run.status}): ` +
        `${(run.stderr || run.stdout || "").trim()}`,
    );
  }
}

/** Options for the session a spec wants. */
export type SessionOptions = {
  /**
   * The workspace's plan. FREE is the honest default — it is what a new
   * account actually gets — so a spec that needs an output FREE does not
   * include (a report, a verification package) must say so, rather than
   * meeting `REPORT_NOT_INCLUDED_IN_PLAN` and reading it as a defect.
   */
  plan?: "FREE" | "PRO" | "TEAM";
};

/**
 * The password every session in this suite is created with.
 *
 * Exported because a spec that changes a password has to prove it knows the
 * current one, and hard-coding a second copy of this string in a spec is how
 * the two drift apart.
 */
export const SESSION_PASSWORD = "E2e-Session-Passw0rd-x9";

let sessionCounter = 0;

/**
 * THE SESSION EVERY SPEC IN THIS DIRECTORY DEPENDS ON.
 *
 * It used to be `POST /v1/auth/guest`. That route no longer exists — the
 * product replaced anonymous capture with email/password accounts — and the
 * whole suite had been failing on its absence:
 *
 *   Error: Guest auth failed (HTTP 404): {"error":{"code":"NOT_FOUND",…}}
 *
 * Measured on the first run of this workflow that was readable at all (the
 * project selection had been collecting 1,033 tests instead of 254, and the
 * job burned five hours): 139 of 254 tests failed, on that one line.
 *
 * So a session is now what a person's is: a registered, verified account with
 * its own personal workspace. The CONTRACT callers depend on is unchanged — an
 * authenticated request context owning a FRESH, EMPTY personal workspace,
 * isolated from every other test's. The name is kept because that contract is
 * what the 26 spec files ask for; the word "guest" is what the product
 * changed.
 */
export async function createGuestSession(
  options: SessionOptions = {},
): Promise<GuestSession> {
  sessionCounter += 1;
  // Unique per call and per process: these accounts accumulate in one
  // database within a job, and two specs registering the same address would
  // couple two tests that share nothing else.
  const email = `e2e-${process.pid}-${Date.now()}-${sessionCounter}@example.test`;
  const password = SESSION_PASSWORD;

  const anon = await makeApi();
  const registered = await anon.post("/v1/auth/email/register", {
    data: { email, password, name: "E2E session" },
  });
  if (!registered.ok()) {
    throw new Error(
      `Registration failed (HTTP ${registered.status()}): ${await registered.text()}`,
    );
  }

  prepareAccount(email, options.plan);

  const loggedIn = await anon.post("/v1/auth/email/login", {
    data: { email, password },
  });
  if (!loggedIn.ok()) {
    throw new Error(
      `Sign-in failed (HTTP ${loggedIn.status()}): ${await loggedIn.text()}`,
    );
  }
  const body = (await loggedIn.json()) as {
    token: string;
    user: { id: string };
  };
  await anon.dispose();

  const api = await makeApi(body.token);

  // Accept the current legal versions so subsequent calls aren't gated.
  // These versions match the API's currently-active legal acceptance
  // requirements (defined in services/api/src/services/legal-acceptance.service.ts).
  await api.post("/v1/users/legal-acceptance", {
    data: {
      source: "playwright-e2e",
      acceptances: [
        { policyKey: "terms", policyVersion: "2026-04-06" },
        { policyKey: "privacy", policyVersion: "2026-04-06" },
        { policyKey: "cookies", policyVersion: "2026-04-06" },
      ],
    },
  });

  return { token: body.token, userId: body.user.id, email, api };
}

export async function disposeSession(s: GuestSession) {
  await s.api.dispose();
}

/**
 * AN ENTERPRISE ORGANIZATION, PROVISIONED THE WAY THE PRODUCT PROVISIONS ONE.
 *
 * The org-surface specs used to reach this state with `POST /v1/orgs`. That
 * route is RETIRED (Phase 2, 2026-07-21) and answers
 *
 *   403 org_self_service_creation_retired
 *   "Organizations are provisioned with a PROOVRA Enterprise agreement.
 *    To work with a team, create a workspace instead."
 *
 * and the workspace door it points at is not self-service either — measured
 * against this stack, `POST /v1/teams` answers
 * `409 WORKSPACE_CREATION_NOT_SELF_SERVICE`. So no route reaches the state,
 * and every spec that assumed one cascaded: the org id came back undefined
 * and each following call hit `/v1/orgs/undefined/...`, which is why so many
 * of these failures read as an unexplained 400.
 *
 * The org-admin contracts those specs assert — invite lifecycle, role
 * precedence, last-owner protection, audit pagination — are all still live.
 * They belong to Enterprise organizations now, so the fixture provisions one
 * through `provisionEnterpriseCustomer`, the sales-led authority the
 * retirement note itself names. Nothing about the assertions changes.
 *
 * Spawned rather than imported for the same reason `prepareAccount` is: the
 * authority is TypeScript in `services/api`, and this file is transpiled to
 * CommonJS by Playwright's loader.
 */
export type ProvisionedOrg = {
  organizationId: string;
  workspaceId: string;
  ownerUserId: string;
};

export function provisionEnterpriseOrg(
  session: GuestSession,
  organizationName = "E2E Enterprise Org",
): ProvisionedOrg {
  const root = repoRoot();
  const api = join(root, "services", "api");
  // `node --import tsx`, not the `.bin` shim: a `.CMD` is not directly
  // executable through CreateProcess, so spawnSync returned `status: null`
  // with empty streams and the failure said nothing about itself. This form
  // is the same on every platform.
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(api, "scripts", "e2e-provision-org.ts"),
      `--owner-email=${session.email}`,
      `--name=${organizationName}`,
    ],
    { cwd: api, encoding: "utf8" },
  );
  if (run.error || run.status !== 0) {
    throw new Error(
      `Could not provision an Enterprise org for ${session.email} ` +
        `(exit ${run.status}${run.signal ? ", signal " + run.signal : ""}` +
        `${run.error ? ", spawn error " + run.error.message : ""}): ` +
        `${(run.stderr || run.stdout || "(no output)").trim()}`,
    );
  }
  const line = (run.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) {
    throw new Error(
      `Enterprise provisioning printed no result for ${session.email}: ` +
        `${(run.stdout || "").trim()}`,
    );
  }
  return JSON.parse(line) as ProvisionedOrg;
}
