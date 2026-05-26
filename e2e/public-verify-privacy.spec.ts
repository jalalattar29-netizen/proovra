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
} from "./helpers/api-client";

// Phase 1 — clear shared rate-limit buckets between tests so the
// "must trip 429" specs don't starve their successors.
test.beforeEach(() => {
  clearTestRateLimits();
});

async function signedEvidence(session: Awaited<ReturnType<typeof createGuestSession>>) {
  const create = await session.api.post("/v1/evidence", {
    data: { type: "PHOTO", mimeType: "text/plain" },
  });
  const c = (await create.json()) as {
    id: string;
    upload: { putUrl: string };
  };
  await fetch(c.upload.putUrl, {
    method: "PUT",
    body: `verify-privacy ${Date.now()}\n`,
    headers: { "Content-Type": "text/plain" },
  });
  await session.api.post(`/v1/evidence/${c.id}/complete`, { data: {} });
  return c.id;
}

test.describe("public verify privacy @critical", () => {
  test("response must not contain PII", async ({ request }) => {
    const session = await createGuestSession();
    try {
      const id = await signedEvidence(session);

      const res = await request.get(`${API_BASE}/public/verify/${id}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as Record<string, unknown> & {
        overview?: Record<string, unknown>;
      };

      // Hardened: no PII or org-identity leakage by default.
      const overview = body.overview ?? {};
      expect(overview.submittedByEmail).toBeNull();
      expect(overview.workspaceName).toBeNull();
      expect(overview.organizationName).toBeNull();
      // submittedByAuthProviderCode (raw enum) must not appear.
      expect("submittedByAuthProviderCode" in overview).toBe(false);

      // Submitter category label (e.g. "Guest session") is allowed —
      // it tells viewers how trust was established without leaking
      // identity. Validate it stays a label-only string.
      expect(typeof overview.submittedByAuthProvider).toBe("string");
    } finally {
      await disposeSession(session);
    }
  });

  test("trust-state fields are present and honest", async ({ request }) => {
    const session = await createGuestSession();
    try {
      const id = await signedEvidence(session);
      const res = await request.get(`${API_BASE}/public/verify/${id}`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as {
        integrityProof?: { signatureValid?: boolean; canonicalHashMatches?: boolean };
        trustDecision?: { verdict?: string; score?: number };
      };

      // signatureValid is the cryptographic answer — it must exist
      // and must be a boolean. Phase 0 + the seed step guarantee a
      // signing-key row is present; a missing key would now return
      // 503, not 200, so reaching this assertion implies a real
      // verification ran.
      expect(typeof body.integrityProof?.signatureValid).toBe("boolean");
      expect(typeof body.integrityProof?.canonicalHashMatches).toBe("boolean");
      expect(body.trustDecision?.verdict).toBeTruthy();
      expect(typeof body.trustDecision?.score).toBe("number");
    } finally {
      await disposeSession(session);
    }
  });

  test("per-IP rate limit returns 429 + Retry-After", async ({ request }) => {
    const session = await createGuestSession();
    try {
      const id = await signedEvidence(session);

      // The Phase 1 default is 30/min/IP. Fire 40 times rapidly; at
      // least one must come back 429.
      let saw429 = false;
      let retryAfter: string | null = null;
      for (let i = 0; i < 40; i++) {
        const res = await request.get(`${API_BASE}/public/verify/${id}`);
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

  test("guest auth has its own rate limit", async ({ request }) => {
    // 5/min/IP by default. Drive 10 calls back-to-back, at least one
    // must be 429 with Retry-After.
    let saw429 = false;
    let retryAfter: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await request.post(`${API_BASE}/v1/auth/guest`, { data: {} });
      if (res.status() === 429) {
        saw429 = true;
        retryAfter = res.headers()["retry-after"] ?? null;
        break;
      }
    }
    expect(saw429, "guest auth should rate-limit after 5/min").toBe(true);
    expect(retryAfter).not.toBeNull();
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

  test("invalid token / non-uuid path returns 400 — no info leak", async ({
    request,
  }) => {
    const res = await request.get(`${API_BASE}/public/verify/not-a-uuid`);
    expect(res.status()).toBe(400);
  });
});
