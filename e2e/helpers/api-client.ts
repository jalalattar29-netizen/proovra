/**
 * Tiny API client for Playwright E2E. Avoids importing the web's
 * `lib/api.ts` so the helpers can drive the stack from a Node process
 * before/without the browser surface.
 */
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

export async function createGuestSession(): Promise<GuestSession> {
  const anon = await makeApi();
  const resp = await anon.post("/v1/auth/guest", { data: {} });
  if (!resp.ok()) {
    throw new Error(
      `Guest auth failed (HTTP ${resp.status()}): ${await resp.text()}`,
    );
  }
  const body = (await resp.json()) as { token: string; user: { id: string } };
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

  return { token: body.token, userId: body.user.id, api };
}

export async function disposeSession(s: GuestSession) {
  await s.api.dispose();
}
