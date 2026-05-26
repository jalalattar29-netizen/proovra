/**
 * Tiny API client for Playwright E2E. Avoids importing the web's
 * `lib/api.ts` so the helpers can drive the stack from a Node process
 * before/without the browser surface.
 */
import { request as pwRequest, APIRequestContext } from "@playwright/test";
import { execSync } from "node:child_process";

export const API_BASE = process.env.API_BASE ?? "http://localhost:8081";

/**
 * Clear the rate-limit buckets that the test IP would have hit.
 *
 * The tests run as a single client IP against a single API process so
 * they all share the per-IP buckets (guest auth, verify-by-IP). Without
 * this reset, the "rate limit must trip" test consumes the quota for
 * subsequent tests that just want to create a guest session.
 *
 * Strategy: scrub any Redis key matching `ratelimit:*` or `auth:guest:*`.
 * In-memory fallback buckets are process-local; they reset on each API
 * restart. The CI workflow restarts the API per job, so this helper is
 * a no-op on CI when Redis isn't reachable.
 */
export function clearTestRateLimits(): void {
  try {
    execSync(
      `docker exec proovra_redis redis-cli --scan --pattern "ratelimit:*" | xargs -r docker exec -i proovra_redis redis-cli del`,
      { stdio: "ignore", timeout: 5000 },
    );
    execSync(
      `docker exec proovra_redis redis-cli --scan --pattern "auth:guest:*" | xargs -r docker exec -i proovra_redis redis-cli del`,
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {
    // Ignore — Redis isn't reachable in the test process's exec env.
    // In-memory fallback buckets are short-lived enough not to break us.
  }
}

export type GuestSession = {
  token: string;
  userId: string;
  api: APIRequestContext;
};

export async function makeApi(token?: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
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
