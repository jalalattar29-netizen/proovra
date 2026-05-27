/**
 * Phase 2.7Z+ — E2E auth rate-limit bypass behavior tests.
 *
 * Locks in:
 *
 *   1. With the correct `X-E2E-Auth-Bypass` header (matches the API
 *      env's `E2E_AUTH_BYPASS_SECRET`), the guest-auth endpoint
 *      survives a rapid burst far above the 5/min/IP production
 *      limit. This is the regression-prevention contract that
 *      eliminates the cascading 429s the Stage 4-6 e2e growth
 *      introduced.
 *
 *   2. Without the bypass header, the production rate limit is
 *      still active and triggers 429 RATE_LIMITED after the
 *      configured threshold. This proves the limiter wasn't
 *      globally weakened.
 *
 *   3. With a WRONG secret in the header, the bypass is refused
 *      and 429 fires normally. This proves the constant-time
 *      comparison rejects mismatched secrets — defense against
 *      header-spam attacks.
 *
 * Production safety NOT tested in this e2e suite (would require
 * setting NODE_ENV=production in a separate process, which is out
 * of scope for the Playwright runner). That safety property is
 * verified by reading the helper source: line `if (process.env.NODE_ENV
 * === "production") return false;` is the first check in
 * `shouldBypassAuthRateLimit` — production cannot bypass regardless
 * of env or header.
 */
import { test, expect, request as pwRequest } from "@playwright/test";
import { API_BASE, clearTestRateLimits } from "./helpers/api-client";

const BYPASS_SECRET =
  (process.env.E2E_AUTH_BYPASS_SECRET ?? "").trim() ||
  "e2e-bypass-do-not-use-in-prod-7f2c3a91b4d9e8f10c2b3a4d5e6f70819";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test.describe("Phase 2.7Z+ — E2E auth rate-limit bypass @critical", () => {
  test("bypass header lets a burst exceed the 5/min production limit", async () => {
    // Without the bypass, request #6 within 60 sec would 429.
    // With the bypass, all 12 must succeed.
    const ctx = await pwRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { "X-E2E-Auth-Bypass": BYPASS_SECRET },
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        const resp = await ctx.post("/v1/auth/guest", { data: {} });
        codes.push(resp.status());
      }
      const succeeded = codes.filter((c) => c === 200 || c === 201).length;
      expect(
        succeeded,
        `expected all 12 guest sessions to succeed with the bypass header; codes=${JSON.stringify(codes)}`,
      ).toBe(12);
      expect(codes.includes(429)).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });

  test("without bypass header, the rate limit still triggers 429", async () => {
    // Fresh context with NO bypass header. After the 5 allowed in the
    // window, subsequent guest-auth requests MUST 429.
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    try {
      let saw429 = false;
      let saw200 = false;
      let retryAfter: string | null = null;
      for (let i = 0; i < 20; i++) {
        const resp = await ctx.post("/v1/auth/guest", { data: {} });
        if (resp.status() === 429) {
          saw429 = true;
          retryAfter = resp.headers()["retry-after"] ?? null;
          break;
        }
        if (resp.status() === 200 || resp.status() === 201) saw200 = true;
      }
      expect(
        saw429,
        "expected to see a 429 within 20 unprotected guest-auth requests; the production rate limiter must remain active",
      ).toBe(true);
      expect(saw200).toBe(true);
      expect(retryAfter).not.toBeNull();
      expect(Number(retryAfter)).toBeGreaterThan(0);
    } finally {
      await ctx.dispose();
    }
  });

  test("wrong bypass secret is refused (constant-time compare)", async () => {
    const ctx = await pwRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { "X-E2E-Auth-Bypass": "wrong-secret-of-the-same-length-3a91b4d9e8f10c2b3a4d5e6f70819999" },
    });
    try {
      let saw429 = false;
      for (let i = 0; i < 20; i++) {
        const resp = await ctx.post("/v1/auth/guest", { data: {} });
        if (resp.status() === 429) {
          saw429 = true;
          break;
        }
      }
      expect(
        saw429,
        "wrong bypass secret MUST NOT enable the bypass; the production rate limiter must still trigger 429",
      ).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("bypass header has NO effect on the public verify rate limit (scope guard)", async () => {
    // Critical scope-isolation guard: the bypass mechanism is wired
    // ONLY into the guest-auth route's rate-limit check. The public
    // verify route still calls enforceRateLimit() with no bypass
    // consideration; the header is silently ignored there.
    //
    // We send the VALID bypass header on every request and still
    // expect a 429 once the per-IP verify limit fires. If this test
    // ever stops triggering 429 with the bypass header set, the
    // bypass has leaked into a non-guest-auth code path and must be
    // re-scoped immediately.
    const ctx = await pwRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { "X-E2E-Auth-Bypass": BYPASS_SECRET },
    });
    try {
      let saw429 = false;
      // VERIFY_RATE_LIMIT_MAX=30 in the test env; fire 50 to be safe.
      for (let i = 0; i < 50; i++) {
        // 404 path is fine for the rate-limit bucket — the limiter
        // runs BEFORE the route handler looks up the evidence id.
        const res = await ctx.get(
          `/public/verify/00000000-0000-4000-8000-000000000123`,
        );
        if (res.status() === 429) {
          saw429 = true;
          break;
        }
      }
      expect(
        saw429,
        "bypass header MUST be scoped to guest-auth only; public-verify rate limit must still fire",
      ).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("empty bypass header is treated as absent", async () => {
    const ctx = await pwRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { "X-E2E-Auth-Bypass": "" },
    });
    try {
      let saw429 = false;
      for (let i = 0; i < 20; i++) {
        const resp = await ctx.post("/v1/auth/guest", { data: {} });
        if (resp.status() === 429) {
          saw429 = true;
          break;
        }
      }
      expect(
        saw429,
        "empty bypass header MUST NOT enable the bypass",
      ).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });
});
