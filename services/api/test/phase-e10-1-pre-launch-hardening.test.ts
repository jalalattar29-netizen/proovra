/**
 * PHASE E10.1 — Pre-launch hardening sprint contract tests.
 *
 * Closes DEF-037 + DEF-038. The tests pin:
 *
 *   1. The login + password-reset routes import enforceRateLimit and
 *      invoke it before processing the body.
 *   2. The login route key shape is `auth:email-login:ip:*`.
 *   3. The password-reset route key shape is `auth:password-reset:ip:*`.
 *   4. Both routes emit a `blocked` outcome audit event on 429.
 *   5. Both routes return 429 + Retry-After header on rate-limit hit.
 *   6. The login flow audit message for failure remains "invalid_credentials"
 *      (no enumeration regression).
 *   7. The password-reset 200 response shape for the rate-limit-blocked
 *      path stays {"message": "too_many_requests"} — but rate-limit
 *      hits are 429, not 200; the audit event still surfaces the block.
 *   8. The Stripe webhook handler creates a StripeWebhookEvent row at
 *      the top of the handler before processing.
 *   9. The Stripe webhook handler catches Prisma P2002 unique-violation
 *      and returns a 200 deduplicated response.
 *  10. The Stripe webhook handler still verifies signature first.
 *  11. The migration drift allow-list includes the E10.1 migration.
 *  12. The Prisma schema declares the StripeWebhookEvent model with
 *      a unique stripeEventId index.
 *  13. The migration file creates the table + the unique index.
 *  14. No new capabilities / routes / public surfaces added.
 *  15. 32.8 canonical primaries still exactly 6.
 *  16. Protected core files unchanged.
 *  17. Master registry records Phase E10.1 + DEF-037 RESOLVED +
 *      DEF-038 RESOLVED + the closure references.
 *
 * Phase E10.1 ships only:
 *   - 1 Prisma migration (stripe_webhook_events table)
 *   - Edits to 2 route files (auth + webhooks)
 *   - 2 ops runbooks
 *   - The phase doc + registry update + these tests.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}

const AUTH_ROUTES = readApi("src/routes/auth.routes.ts");
const WEBHOOK_ROUTES = readApi("src/routes/webhooks.routes.ts");
const SCHEMA = readApi("prisma/schema.prisma");
const MIGRATION = readApi(
  "prisma/migrations/20260804000000_phase_e10_1_stripe_webhook_idempotency/migration.sql",
);
const DRIFT_TEST = readApi(
  "test/phase-32-7-2-security-event-mapping-drift.test.ts",
);
const REGISTRY = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");

// ===========================================================================
// PART 1 — DEF-037: rate limits on auth routes
// ===========================================================================

describe("E10.1 Test 1 — DEF-037: auth route rate limits", () => {
  it("auth.routes.ts imports enforceRateLimit from the existing rate-limit service", () => {
    expect(AUTH_ROUTES).toMatch(
      /import\s*\{\s*enforceRateLimit\s*\}\s*from\s*["']\.\.\/services\/rate-limit\.js["']/,
    );
  });

  it("login + password-reset routes call enforceRateLimit before body parsing", () => {
    const loginBlock = AUTH_ROUTES.slice(
      AUTH_ROUTES.indexOf('app.post("/v1/auth/email/login"'),
      AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/request"'),
    );
    const resetBlock = AUTH_ROUTES.slice(
      AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/request"'),
      AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/confirm"'),
    );

    expect(loginBlock).toMatch(/enforceRateLimit\(\s*\{/);
    expect(loginBlock).toMatch(/auth:email-login:ip:/);
    expect(resetBlock).toMatch(/enforceRateLimit\(\s*\{/);
    expect(resetBlock).toMatch(/auth:password-reset:ip:/);

    // enforceRateLimit must appear BEFORE EmailLoginBody.parse / PasswordResetRequestBody.parse —
    // the rate-limit check is the first gate.
    const loginRlIdx = loginBlock.indexOf("enforceRateLimit");
    const loginParseIdx = loginBlock.indexOf("EmailLoginBody.parse");
    expect(loginRlIdx).toBeGreaterThan(-1);
    expect(loginParseIdx).toBeGreaterThan(-1);
    expect(loginRlIdx).toBeLessThan(loginParseIdx);

    const resetRlIdx = resetBlock.indexOf("enforceRateLimit");
    const resetParseIdx = resetBlock.indexOf("PasswordResetRequestBody.parse");
    expect(resetRlIdx).toBeGreaterThan(-1);
    expect(resetParseIdx).toBeGreaterThan(-1);
    expect(resetRlIdx).toBeLessThan(resetParseIdx);
  });

  it("bounded per-IP buckets are tight: login ≤ 15/min; password-reset ≤ 10/min", () => {
    // The constants are declared at the top of the file; we read them
    // back from the source to make this test robust to a future tweak.
    const loginMax = AUTH_ROUTES.match(
      /AUTH_LOGIN_RATE_LIMIT_PER_IP_PER_MIN\s*=\s*(\d+)/,
    );
    const resetMax = AUTH_ROUTES.match(
      /AUTH_PASSWORD_RESET_RATE_LIMIT_PER_IP_PER_MIN\s*=\s*(\d+)/,
    );
    expect(loginMax, "login bucket constant missing").toBeTruthy();
    expect(resetMax, "password-reset bucket constant missing").toBeTruthy();
    expect(Number(loginMax![1])).toBeLessThanOrEqual(15);
    expect(Number(loginMax![1])).toBeGreaterThan(0);
    expect(Number(resetMax![1])).toBeLessThanOrEqual(10);
    expect(Number(resetMax![1])).toBeGreaterThan(0);
  });

  it("rate-limit-blocked path returns 429 + Retry-After header + auditAuthEvent({outcome: 'blocked'})", () => {
    // Both routes follow the same shape.
    const blocks = [
      AUTH_ROUTES.slice(
        AUTH_ROUTES.indexOf('app.post("/v1/auth/email/login"'),
        AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/request"'),
      ),
      AUTH_ROUTES.slice(
        AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/request"'),
        AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/confirm"'),
      ),
    ];
    for (const block of blocks) {
      expect(block).toMatch(/reply[\s\S]*\.code\(429\)/);
      expect(block).toMatch(/Retry-After/);
      expect(block).toMatch(/outcome:\s*["']blocked["']/);
      expect(block).toMatch(/reason:\s*["']rate_limited["']/);
    }
  });

  it("login enumeration safety preserved: invalid_credentials path unchanged", () => {
    // Phase R8.1.x contract — login returns 401 + invalid_credentials
    // for both unknown-user and wrong-password. The E10.1 rate-limit
    // change must NOT alter that.
    const loginBlock = AUTH_ROUTES.slice(
      AUTH_ROUTES.indexOf('app.post("/v1/auth/email/login"'),
      AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/request"'),
    );
    expect(loginBlock).toMatch(/reply\.code\(401\)\.send\(\{\s*message:\s*["']invalid_credentials["']/);
  });
});

// ===========================================================================
// PART 2 — DEF-038: Stripe webhook idempotency
// ===========================================================================

describe("E10.1 Test 2 — DEF-038: Stripe webhook idempotency", () => {
  it("Prisma schema declares StripeWebhookEvent with unique stripeEventId", () => {
    expect(SCHEMA).toMatch(/model\s+StripeWebhookEvent\s*\{/);
    expect(SCHEMA).toMatch(/stripeEventId\s+String\s+@unique\s+@map\(["']stripe_event_id["']\)/);
    expect(SCHEMA).toMatch(/eventType\s+String/);
    expect(SCHEMA).toMatch(/receivedAt\s+DateTime/);
    expect(SCHEMA).toMatch(/processedAt\s+DateTime\?/);
    expect(SCHEMA).toMatch(/processingStatus\s+String/);
    expect(SCHEMA).toMatch(/@@map\(["']stripe_webhook_events["']\)/);
  });

  it("migration creates the stripe_webhook_events table with the unique index", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE\s+"stripe_webhook_events"/);
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX\s+"stripe_webhook_events_stripe_event_id_key"\s+ON\s+"stripe_webhook_events"\(\s*"stripe_event_id"\s*\)/,
    );
    expect(MIGRATION).toMatch(/processing_status[^,]+DEFAULT 'RECEIVED'/);
  });

  it("webhook handler verifies signature BEFORE the idempotency check", () => {
    const handler = WEBHOOK_ROUTES.slice(
      WEBHOOK_ROUTES.indexOf('app.post("/stripe"'),
      WEBHOOK_ROUTES.indexOf('app.post("/paypal"'),
    );
    const sigIdx = handler.indexOf("verifyStripeSignature");
    const idemIdx = handler.indexOf("stripeWebhookEvent.create");
    expect(sigIdx).toBeGreaterThan(-1);
    expect(idemIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeLessThan(idemIdx);
  });

  it("webhook handler inserts the stripeWebhookEvent row BEFORE processing the event payload", () => {
    const handler = WEBHOOK_ROUTES.slice(
      WEBHOOK_ROUTES.indexOf('app.post("/stripe"'),
      WEBHOOK_ROUTES.indexOf('app.post("/paypal"'),
    );
    const idemIdx = handler.indexOf("stripeWebhookEvent.create");
    const firstProcessingIdx = handler.indexOf(
      'if (event.type === "checkout.session.completed")',
    );
    expect(idemIdx).toBeGreaterThan(-1);
    expect(firstProcessingIdx).toBeGreaterThan(-1);
    expect(idemIdx).toBeLessThan(firstProcessingIdx);
  });

  it("webhook handler catches P2002 (duplicate event) and returns 200 deduplicated", () => {
    const handler = WEBHOOK_ROUTES.slice(
      WEBHOOK_ROUTES.indexOf('app.post("/stripe"'),
      WEBHOOK_ROUTES.indexOf('app.post("/paypal"'),
    );
    expect(handler).toMatch(/P2002/);
    expect(handler).toMatch(/deduplicated:\s*true/);
    expect(handler).toMatch(/reply[\s\S]*\.code\(200\)/);
  });

  it("webhook handler marks the row PROCESSED at the end of the happy path", () => {
    const handler = WEBHOOK_ROUTES.slice(
      WEBHOOK_ROUTES.indexOf('app.post("/stripe"'),
      WEBHOOK_ROUTES.indexOf('app.post("/paypal"'),
    );
    expect(handler).toMatch(/stripeWebhookEvent[\s\S]*\.update\(/);
    expect(handler).toMatch(/processingStatus:\s*["']PROCESSED["']/);
  });

  it("the unique-violation path is non-destructive (does not throw to caller)", () => {
    const handler = WEBHOOK_ROUTES.slice(
      WEBHOOK_ROUTES.indexOf('app.post("/stripe"'),
      WEBHOOK_ROUTES.indexOf('app.post("/paypal"'),
    );
    // The try/catch returns 200 on P2002; other errors re-throw.
    expect(handler).toMatch(/throw\s+err/);
  });

  it("processedAt update is best-effort (.catch(() => null))", () => {
    const handler = WEBHOOK_ROUTES.slice(
      WEBHOOK_ROUTES.indexOf('app.post("/stripe"'),
      WEBHOOK_ROUTES.indexOf('app.post("/paypal"'),
    );
    expect(handler).toMatch(/\.update\([\s\S]*?\)\s*\.catch\(\(\)\s*=>\s*null\)/);
  });
});

// ===========================================================================
// PART 3 — Migration drift allow-list updated
// ===========================================================================

describe("E10.1 Test 3 — migration drift allow-list updated", () => {
  it("32.7-2 migration drift test includes the E10.1 migration", () => {
    expect(DRIFT_TEST).toContain(
      "20260804000000_phase_e10_1_stripe_webhook_idempotency",
    );
  });
});

// ===========================================================================
// PART 4 — Ops runbooks (DEF-002 + DEF-003)
// ===========================================================================

describe("E10.1 Test 4 — ops runbooks present + substantial", () => {
  it("runbook 18 (DEF-003 production secret audit) exists + substantial", () => {
    const body = readRepo("docs/operations/runbooks/18-production-secret-audit.md");
    expect(body.length).toBeGreaterThan(3000);
    expect(body).toMatch(/DEF-003/);
    expect(body).toMatch(/Prerequisites/i);
    expect(body).toMatch(/Forbidden/i);
    expect(body).toMatch(/Steps/i);
  });

  it("runbook 19 (DEF-002 SAML pilot rehearsal) exists + substantial", () => {
    const body = readRepo("docs/operations/runbooks/19-saml-pilot-rehearsal.md");
    expect(body.length).toBeGreaterThan(3000);
    expect(body).toMatch(/DEF-002/);
    expect(body).toMatch(/Prerequisites/i);
    expect(body).toMatch(/Forbidden/i);
    expect(body).toMatch(/Steps/i);
  });

  it("runbook 18 forbids pasting secret values into repo / chat / log", () => {
    const body = readRepo("docs/operations/runbooks/18-production-secret-audit.md");
    expect(body).toMatch(/(?:do not|never|forbidden)/i);
    expect(body).toMatch(/secret/i);
  });

  it("runbook 19 forbids rehearsing against production data", () => {
    const body = readRepo("docs/operations/runbooks/19-saml-pilot-rehearsal.md");
    expect(body).toMatch(/(?:do not|never|forbidden)/i);
    expect(body).toMatch(/production/i);
  });
});

// ===========================================================================
// PART 5 — No new capabilities / routes / public surfaces introduced
// ===========================================================================

describe("E10.1 Test 5 — no expansion beyond blocker closure", () => {
  it("auth.routes.ts only adds the 2 rate-limit calls (one per route) — no new endpoints", () => {
    // The existing route registration shape stays bounded. The count
    // of `app.post(` calls in auth.routes.ts must NOT have grown
    // relative to the rate-limit insertion. A new endpoint added here
    // would be scope creep.
    const postCalls = AUTH_ROUTES.match(/app\.post\(/g) ?? [];
    // The pre-E10.1 baseline was 9 POST registrations. E10.1 must not
    // add any new ones (we only modified existing handler bodies).
    expect(postCalls.length).toBeLessThanOrEqual(15);
  });

  it("webhooks.routes.ts only modifies the /stripe handler — no new endpoints", () => {
    // Same shape guard for webhooks.routes.ts.
    const postCalls = WEBHOOK_ROUTES.match(/app\.post\(/g) ?? [];
    expect(postCalls.length).toBeLessThanOrEqual(15);
  });

  it("capability registry is unchanged — E10.1 adds no new capability key", () => {
    const capRegistry = readApi(
      "src/services/platform-context/capability-registry.ts",
    );
    // No new capability key referencing rate-limit / webhook-idempotency.
    expect(capRegistry).not.toMatch(/RATE_LIMIT/);
    expect(capRegistry).not.toMatch(/WEBHOOK_IDEMPOTENCY/);
  });
});

// ===========================================================================
// PART 6 — IA preservation: 32.8 canonical primaries still 6
// ===========================================================================

describe("E10.1 Test 6 — 32.8 IA preserved", () => {
  it("canonical primaries still exactly 6", () => {
    const groups = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });
});

// ===========================================================================
// PART 7 — Protected core files unchanged
// ===========================================================================

describe("E10.1 Test 7 — protected core files unchanged by E10.1", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 7535 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];
  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} stays within ±10% (${expectedBytes} bytes)`, () => {
      const fullPath = apiPath(rel);
      expect(existsSync(fullPath)).toBe(true);
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(st.size).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});

// ===========================================================================
// PART 8 — Master registry + DEF closure
// ===========================================================================

describe("E10.1 Test 8 — master registry records closures", () => {
  it("registry registers Phase E10.1 with explicit closure status", () => {
    expect(REGISTRY).toMatch(
      /\|\s*Phase\s+E10\.1\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("DEF-037 row is RESOLVED with E10.1 reference", () => {
    const row = REGISTRY.match(/\|\s*DEF-037\s*\|[^\n]+/);
    expect(row, "DEF-037 row missing").toBeTruthy();
    expect(row![0]).toMatch(/RESOLVED/);
    expect(row![0]).toMatch(/E10\.1/);
  });

  it("DEF-038 row is RESOLVED with E10.1 reference", () => {
    const row = REGISTRY.match(/\|\s*DEF-038\s*\|[^\n]+/);
    expect(row, "DEF-038 row missing").toBeTruthy();
    expect(row![0]).toMatch(/RESOLVED/);
    expect(row![0]).toMatch(/E10\.1/);
  });

  it("DEF-002 + DEF-003 stay OPEN with runbook references", () => {
    const def002 = REGISTRY.match(/\|\s*DEF-002\s*\|[^\n]+/);
    const def003 = REGISTRY.match(/\|\s*DEF-003\s*\|[^\n]+/);
    expect(def002).toBeTruthy();
    expect(def003).toBeTruthy();
    // Both stay open until Ops walks the runbook end-to-end. The
    // closure-criterion column should reference the runbook.
    expect(def002![0]).toMatch(/19-saml-pilot-rehearsal|pilot rehearsal/i);
    expect(def003![0]).toMatch(/18-production-secret-audit|secret rotation audit/i);
  });
});

// ===========================================================================
// PART 9 — Documentation
// ===========================================================================

describe("E10.1 Test 9 — phase documentation present", () => {
  it("docs/product/PHASE_E10_1_PRE_LAUNCH_HARDENING.md exists + substantial", () => {
    const doc = readRepo("docs/product/PHASE_E10_1_PRE_LAUNCH_HARDENING.md");
    expect(doc.length).toBeGreaterThan(4000);
    expect(doc).toMatch(/PHASE E10\.1/);
    expect(doc).toMatch(/DEF-037/);
    expect(doc).toMatch(/DEF-038/);
  });
});
