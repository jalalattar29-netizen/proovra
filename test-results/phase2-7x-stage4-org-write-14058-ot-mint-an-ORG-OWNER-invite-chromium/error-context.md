# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase2-7x-stage4-org-write-surfaces.spec.ts >> Phase 2.7X Stage 4 — org write surfaces @critical >> ORG_ADMIN cannot mint an ORG_OWNER invite
- Location: e2e\phase2-7x-stage4-org-write-surfaces.spec.ts:281:7

# Error details

```
Error: Guest auth failed (HTTP 429): {"code":"RATE_LIMITED","message":"Rate limit exceeded"}
```

# Test source

```ts
  1  | /**
  2  |  * Tiny API client for Playwright E2E. Avoids importing the web's
  3  |  * `lib/api.ts` so the helpers can drive the stack from a Node process
  4  |  * before/without the browser surface.
  5  |  */
  6  | import { request as pwRequest, APIRequestContext } from "@playwright/test";
  7  | import { execSync } from "node:child_process";
  8  | 
  9  | export const API_BASE = process.env.API_BASE ?? "http://localhost:8081";
  10 | 
  11 | /**
  12 |  * Clear the rate-limit buckets that the test IP would have hit.
  13 |  *
  14 |  * The tests run as a single client IP against a single API process so
  15 |  * they all share the per-IP buckets (guest auth, verify-by-IP). Without
  16 |  * this reset, the "rate limit must trip" test consumes the quota for
  17 |  * subsequent tests that just want to create a guest session.
  18 |  *
  19 |  * Strategy: scrub any Redis key matching `ratelimit:*` or `auth:guest:*`.
  20 |  * In-memory fallback buckets are process-local; they reset on each API
  21 |  * restart. The CI workflow restarts the API per job, so this helper is
  22 |  * a no-op on CI when Redis isn't reachable.
  23 |  */
  24 | export function clearTestRateLimits(): void {
  25 |   try {
  26 |     execSync(
  27 |       `docker exec proovra_redis redis-cli --scan --pattern "ratelimit:*" | xargs -r docker exec -i proovra_redis redis-cli del`,
  28 |       { stdio: "ignore", timeout: 5000 },
  29 |     );
  30 |     execSync(
  31 |       `docker exec proovra_redis redis-cli --scan --pattern "auth:guest:*" | xargs -r docker exec -i proovra_redis redis-cli del`,
  32 |       { stdio: "ignore", timeout: 5000 },
  33 |     );
  34 |   } catch {
  35 |     // Ignore — Redis isn't reachable in the test process's exec env.
  36 |     // In-memory fallback buckets are short-lived enough not to break us.
  37 |   }
  38 | }
  39 | 
  40 | export type GuestSession = {
  41 |   token: string;
  42 |   userId: string;
  43 |   api: APIRequestContext;
  44 | };
  45 | 
  46 | export async function makeApi(token?: string): Promise<APIRequestContext> {
  47 |   return pwRequest.newContext({
  48 |     baseURL: API_BASE,
  49 |     extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  50 |   });
  51 | }
  52 | 
  53 | export async function createGuestSession(): Promise<GuestSession> {
  54 |   const anon = await makeApi();
  55 |   const resp = await anon.post("/v1/auth/guest", { data: {} });
  56 |   if (!resp.ok()) {
> 57 |     throw new Error(
     |           ^ Error: Guest auth failed (HTTP 429): {"code":"RATE_LIMITED","message":"Rate limit exceeded"}
  58 |       `Guest auth failed (HTTP ${resp.status()}): ${await resp.text()}`,
  59 |     );
  60 |   }
  61 |   const body = (await resp.json()) as { token: string; user: { id: string } };
  62 |   await anon.dispose();
  63 | 
  64 |   const api = await makeApi(body.token);
  65 | 
  66 |   // Accept the current legal versions so subsequent calls aren't gated.
  67 |   // These versions match the API's currently-active legal acceptance
  68 |   // requirements (defined in services/api/src/services/legal-acceptance.service.ts).
  69 |   await api.post("/v1/users/legal-acceptance", {
  70 |     data: {
  71 |       source: "playwright-e2e",
  72 |       acceptances: [
  73 |         { policyKey: "terms", policyVersion: "2026-04-06" },
  74 |         { policyKey: "privacy", policyVersion: "2026-04-06" },
  75 |         { policyKey: "cookies", policyVersion: "2026-04-06" },
  76 |       ],
  77 |     },
  78 |   });
  79 | 
  80 |   return { token: body.token, userId: body.user.id, api };
  81 | }
  82 | 
  83 | export async function disposeSession(s: GuestSession) {
  84 |   await s.api.dispose();
  85 | }
  86 | 
```