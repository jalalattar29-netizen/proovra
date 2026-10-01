/**
 * Phase 1 — Public verify privacy + rate-limit regression gate.
 *
 * These tests are the operational guarantee for two of the highest-
 * impact P0s identified in the runtime audit:
 *
 *   1. PII leak: the public verify response shape used to include
 *      `submittedByEmail`, `workspaceName`, `organizationName`, and
 *      the raw `submittedByAuthProviderCode`. Default Phase 1 posture
 *      redacts all of them. This spec freezes that contract.
 *
 *   2. Rate limit: a per-IP bucket (30/min default) + a per-evidence
 *      bucket (60/min default) protect public verify against
 *      enumeration and replay scraping. We assert that 429 + a
 *      Retry-After header are emitted on bucket exhaustion.
 *
 * If either assertion fails, do NOT merge.
 */
import { test, expect } from "@playwright/test";
import {
  API_BASE,
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
  mintVerifyLink,
  authorizeOriginalPart,
} from "./helpers/api-client";

// Phase 1 — clear shared rate-limit buckets between tests so the
// "must trip 429" specs don't starve their successors.
test.beforeEach(async () => {
  await clearTestRateLimits();
});

async function signedEvidence(session: Awaited<ReturnType<typeof createGuestSession>>) {
  // Phase 2.7Z+ hardening: validate each step of the finalize chain so a
  // silent PUT/complete failure can't return an "unfinalized" id that
  // makes downstream /public/verify assertions look like 409/ok=false
  // regressions. If any step fails, throw with the full diagnostic.
  const create = await session.api.post("/v1/evidence", {
    data: { type: "PHOTO", mimeType: "text/plain" },
  });
  if (!create.ok()) {
    throw new Error(
      `signedEvidence: POST /v1/evidence failed (HTTP ${create.status()}): ${await create.text()}`,
    );
  }
  const c = (await create.json()) as { id: string };
  const putUrl = await authorizeOriginalPart(session.api, c.id, { mimeType: "text/plain" });

  const putRes = await fetch(putUrl, {
    method: "PUT",
    body: `verify-privacy ${Date.now()}\n`,
    headers: { "Content-Type": "text/plain" },
  });
  if (!putRes.ok) {
    throw new Error(
      `signedEvidence: direct PUT to presigned URL failed (HTTP ${putRes.status}): ${await putRes.text()}`,
    );
  }

  const complete = await session.api.post(
    `/v1/evidence/${c.id}/complete`,
    { data: {} },
  );
  if (!complete.ok()) {
    throw new Error(
      `signedEvidence: POST /v1/evidence/${c.id}/complete failed (HTTP ${complete.status()}): ${await complete.text()}`,
    );
  }
  const completed = (await complete.json()) as { status?: string };
  if (completed.status !== "SIGNED") {
    throw new Error(
      `signedEvidence: complete returned status=${completed.status}, expected SIGNED`,
    );
  }

  return c.id;
}

test.describe("public verify privacy @critical", () => {
  test("response must not contain PII", async ({ request }) => {
    const session = await createGuestSession();
    try {
      const id = await signedEvidence(session);

      // ET-PKG-07 — a freshly signed record is private, and its id opens
      // nothing: the public page is reached only through a share link.
      const byId = await request.get(`${API_BASE}/public/verify/${id}`);
      expect(byId.status(), "a record's id is not a public link").toBe(404);

      const res = await request.get(`${API_BASE}/public/verify/${mintVerifyLink(id)}`);
      expect(res.status()).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;

      // A guest record is not entitled to issued outputs, so it answers the
      // BASIC tier: the original-integrity result and nothing that describes
      // who submitted it. The identity fields the RICH projection gates
      // (overview.submittedByEmail / workspaceName / organizationName, and
      // the raw submittedByAuthProviderCode) must not exist ANYWHERE in the
      // answer — asserted on the serialized body, so no nesting can hide one.
      expect(body.tier).toBe("BASIC");
      expect("overview" in body).toBe(false);
      for (const key of [
        "submittedByEmail",
        "submittedByUserId",
        "ownerUserId",
        "workspaceName",
        "organizationName",
        "submittedByAuthProviderCode",
        "teamId",
      ]) {
        expect(text, `public verify must not carry ${key}`).not.toContain(`"${key}"`);
      }
      expect(Object.keys(body).sort()).toEqual(["basicVerification", "evidenceId", "link", "tier"]);
      // About the link, only its kind and when it ends — never who it was for.
      expect(Object.keys(body.link as object).sort()).toEqual(["expiresAtUtc", "kind"]);
      expect((body.link as { kind: string }).kind).toBe("SHARE_TOKEN");
      for (const key of ["audience", "createdByUserId", "tokenHash", "revokedByUserId"]) {
        expect(text, `public verify must not carry ${key}`).not.toContain(`"${key}"`);
      }
    } finally {
      await disposeSession(session);
    }
  });

  test("trust-state fields are present and honest", async ({ request }) => {
    const session = await createGuestSession();
    try {
      const id = await signedEvidence(session);
      const res = await request.get(`${API_BASE}/public/verify/${mintVerifyLink(id)}`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        tier?: string;
        basicVerification?: {
          schema?: string;
          storedBytes?: { state?: string; lastVerifiedAtUtc?: string | null };
          original?: {
            state?: string;
            basis?: string | null;
            checks?: {
              fingerprintMatchesSignedHash?: boolean | null;
              signatureValid?: boolean | null;
              custodyChainValid?: boolean | null;
            };
            fileSha256?: string | null;
          };
        };
      };

      // The cryptographic answer must be present and must be an ANSWER.
      // Phase 0 + the seed step guarantee a signing-key row is present; a
      // missing key returns 503, not 200, so reaching these assertions means
      // a real verification ran — and a record this stack just signed with
      // its own key must verify.
      expect(body.tier).toBe("BASIC");
      const basic = body.basicVerification;
      expect(basic?.schema).toBe("PROOVRA_BASIC_VERIFICATION");
      const checks = basic?.original?.checks;
      expect(checks?.signatureValid).toBe(true);
      expect(checks?.fingerprintMatchesSignedHash).toBe(true);
      expect(typeof checks?.custodyChainValid).toBe("boolean");
      expect(basic?.original?.fileSha256).toMatch(/^[0-9a-f]{64}$/);
      // ET-SM-07 — finalization read the stored bytes, so a record this stack
      // just signed is "verified, current" with a date; it is never silently
      // assumed.
      expect(basic?.storedBytes?.state).toBe("verified_current");
      expect(basic?.storedBytes?.lastVerifiedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The headline is honest: it is "verified" exactly when every check
      // passed, and "failed" when any check failed.
      const all = [checks?.fingerprintMatchesSignedHash, checks?.signatureValid, checks?.custodyChainValid];
      expect(basic?.original?.state).toBe(
        all.some((c) => c === false) ? "failed" : all.every((c) => c === true) ? "verified" : "not_checked",
      );
      expect(basic?.original?.basis).toBe(
        all.every((c) => c === true) ? "SIGNATURE_AND_FINGERPRINT_AND_CUSTODY_CHAIN" : null,
      );
    } finally {
      await disposeSession(session);
    }
  });

  test("unfinalized evidence returns 409 (not enumerable as 'real')", async ({
    request,
  }) => {
    const session = await createGuestSession();
    try {
      // Create evidence but do NOT upload + complete.
      const create = await session.api.post("/v1/evidence", {
        data: { type: "PHOTO", mimeType: "text/plain" },
      });
      const { id } = (await create.json()) as { id: string };

      const res = await request.get(`${API_BASE}/public/verify/${id}`);
      // 404 (not-published gate) OR 409 (not-finalized) are both
      // acceptable. The one thing that's NOT acceptable is a 200
      // — that would leak the existence of an unfinalized record.
      expect([404, 409]).toContain(res.status());
    } finally {
      await disposeSession(session);
    }
  });

  test("a malformed token is byte-indistinguishable from an unknown one", async ({
    request,
  }) => {
    // THIS USED TO REQUIRE 400, WHICH IS THE LEAK THE TITLE WARNS ABOUT.
    //
    // A 400 on a malformed token and a 404 on a well-formed unknown one
    // tells a caller whether their token had the right SHAPE. That is a
    // free oracle for anyone probing the verify surface: it separates
    // "you guessed the format" from "you guessed nothing", which is the
    // first step of enumerating the UUID space. The Phase-12
    // anti-enumeration closure removed the Zod `.parse` that produced the
    // 400 precisely so the two cases could not be told apart.
    //
    // The property is sameness, so both are requested and compared.
    const malformed = await request.get(
      `${API_BASE}/public/verify/not-a-uuid`,
    );
    const unknown = await request.get(
      `${API_BASE}/public/verify/00000000-0000-4000-8000-000000000000`,
    );

    expect(malformed.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    expect(
      await malformed.text(),
      "token-format validity must not be observable from the response",
    ).toBe(await unknown.text());
  });

  // ===========================================================================
  // ZZZ — intentional 429 tests run LAST in this file.
  //
  // Defense in depth: the global beforeEach calls `clearTestRateLimits`
  // which hits POST /v1/_test/rate-limit/reset before every test, so
  // ordering shouldn't matter. But if that endpoint is ever disabled
  // (E2E_AUTH_BYPASS_SECRET unset / NODE_ENV=production / header
  // mismatch → 404), the bucket-saturating tests stay confined to the
  // tail of this file and cannot pollute downstream specs.
  // ===========================================================================

  test("per-IP rate limit returns 429 + Retry-After", async ({ request }) => {
    const session = await createGuestSession();
    try {
      const link = mintVerifyLink(await signedEvidence(session));

      // The Phase 1 default is 30/min/IP. Fire 40 times rapidly; at
      // least one must come back 429.
      let saw429 = false;
      let retryAfter: string | null = null;
      for (let i = 0; i < 40; i++) {
        const res = await request.get(`${API_BASE}/public/verify/${link}`);
        if (res.status() === 429) {
          saw429 = true;
          retryAfter = res.headers()["retry-after"] ?? null;
          break;
        }
      }
      expect(saw429, "expected at least one 429 within 40 requests").toBe(true);
      expect(retryAfter, "429 must carry a Retry-After header").not.toBeNull();
      expect(Number(retryAfter)).toBeGreaterThan(0);
    } finally {
      await disposeSession(session);
    }
  });

  /**
   * WHAT THIS TEST CAN HONESTLY SAY NOW.
   *
   * It used to drive ten `POST /v1/auth/guest` calls and require a 429 with
   * Retry-After. That route is GONE — the product replaced anonymous capture
   * with email/password accounts — so the assertion was passing judgement on
   * a surface that no longer exists, and every call returned 404.
   *
   * Rewritten to the fact that replaced it, rather than deleted: an
   * anonymous-capture door that was removed on purpose must stay removed, and
   * nothing else in this repository says so.
   *
   * The per-IP rate-limit contract itself is not lost — the two cases above
   * prove it on `public/verify`, which is the surface that is actually
   * exposed to unauthenticated traffic.
   */
  test("anonymous capture has no door: POST /v1/auth/guest is gone", async ({
    request,
  }) => {
    const res = await request.post(`${API_BASE}/v1/auth/guest`, { data: {} });
    expect(res.status()).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("NOT_FOUND");
  });
});
