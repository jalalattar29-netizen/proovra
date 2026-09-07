/**
 * Phase 2.7Z+ — the E2E auth rate-limit bypass, and the limiter it does NOT
 * disable.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED UNDER THIS SPEC
 * ---------------------------------------------------------------------------
 * Every case here used to drive `POST /v1/auth/guest` — a burst of twelve with
 * the bypass header to prove the 5/min/IP guest limit was lifted, and bursts
 * without it (or with a wrong or empty one) to prove the limiter was still
 * armed. Guest auth has been removed from the product, so all twelve calls
 * returned 404 and the spec was measuring an absent route.
 *
 * The bypass itself is NOT gone, and neither is the limiter. What changed is
 * which surfaces they touch:
 *
 *   * the bypass secret's remaining job is to authorise the test-only
 *     `POST /v1/_test/rate-limit/reset` endpoint — the one this suite's
 *     `clearTestRateLimits()` helper calls between tests. `auth.routes.ts`
 *     imports no bypass at all, so no live authentication route can be
 *     exempted by a header;
 *   * the production limiter now guards email login at 10/min/IP
 *     (`AUTH_LOGIN_RATE_LIMIT_PER_IP_PER_MIN`), with no bypass of any kind.
 *
 * So all four original subjects survive — the secret works, a wrong secret
 * does not, an empty header is treated as absent, and the real limiter still
 * fires — measured against the surfaces that exist. The three-layer defence
 * (NODE_ENV != production + a 32-char env secret + a header match) is
 * unchanged; it simply protects a smaller surface, which is the direction that
 * should be true.
 */
import { test, expect, request as pwRequest } from "@playwright/test";
import { API_BASE, clearTestRateLimits } from "./helpers/api-client";

const BYPASS_SECRET =
  (process.env.E2E_AUTH_BYPASS_SECRET ?? "").trim() ||
  "e2e-bypass-do-not-use-in-prod-7f2c3a91b4d9e8f10c2b3a4d5e6f70819";

const RESET_PATH = "/v1/_test/rate-limit/reset";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

test.describe("Phase 2.7Z+ — E2E auth rate-limit bypass @critical", () => {
  test("the bypass secret authorises the test-only reset endpoint", async () => {
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    try {
      const resp = await ctx.post(RESET_PATH, {
        headers: { "X-E2E-Auth-Bypass": BYPASS_SECRET },
      });
      expect(
        resp.status(),
        `the bypass secret must authorise ${RESET_PATH}; got ${resp.status()}: ${await resp.text()}`,
      ).toBe(200);
    } finally {
      await ctx.dispose();
    }
  });

  test("a wrong bypass secret is refused, and the surface stays undiscoverable", async () => {
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    try {
      // Same LENGTH as the real one, so a length check could not be what
      // rejects it — the compare is on content, in constant time.
      const wrong = "x".repeat(BYPASS_SECRET.length);
      expect(wrong).toHaveLength(BYPASS_SECRET.length);
      const resp = await ctx.post(RESET_PATH, {
        headers: { "X-E2E-Auth-Bypass": wrong },
      });
      // 404, not 403: a caller without the secret must not learn that the
      // endpoint exists at all.
      expect(
        resp.status(),
        "a wrong bypass secret MUST NOT authorise the reset endpoint",
      ).toBe(404);
    } finally {
      await ctx.dispose();
    }
  });

  test("an empty or absent bypass header is treated the same way", async () => {
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    try {
      for (const headers of [
        { "X-E2E-Auth-Bypass": "" },
        {} as Record<string, string>,
      ]) {
        const resp = await ctx.post(RESET_PATH, { headers });
        expect(
          resp.status(),
          "an empty bypass header MUST behave exactly like no header",
        ).toBe(404);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("the production rate limiter is still armed on email login", async () => {
    // NOTHING here carries the bypass header, and nothing can: no
    // authentication route reads it. The limiter is 10/min/IP, so a burst
    // past it must be refused — and refused with a Retry-After, so a caller
    // is told when to come back rather than left to guess.
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    try {
      const codes: number[] = [];
      let retryAfter: string | null = null;
      for (let i = 0; i < 14; i += 1) {
        const resp = await ctx.post("/v1/auth/email/login", {
          data: {
            email: "phase2-7z-limiter-probe@example.test",
            password: "not-the-password-x",
          },
        });
        codes.push(resp.status());
        if (resp.status() === 429) {
          retryAfter = resp.headers()["retry-after"] ?? null;
          break;
        }
      }
      expect(
        codes.includes(429),
        `the production limiter must remain active; codes=[${codes.join(",")}]`,
      ).toBe(true);
      // Credential failures come back as 401 until the limiter takes over, so
      // the burst is genuinely reaching the auth path and not short-circuiting
      // somewhere earlier.
      expect(codes.filter((c) => c === 401).length).toBeGreaterThan(0);
      expect(retryAfter).not.toBeNull();
    } finally {
      await ctx.dispose();
      // Hand the next spec a clean bucket: this test deliberately filled it.
      await clearTestRateLimits();
    }
  });
});
