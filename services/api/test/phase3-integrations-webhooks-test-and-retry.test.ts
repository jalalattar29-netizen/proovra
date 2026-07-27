/**
 * PHASE 3 — Integrations webhooks: test-event + deliveries + retry contract.
 *
 * Pins the wire shape, security posture, and UI surface for:
 *
 *   POST   /v1/integrations/webhooks/:id/test          (NEW — Phase 3)
 *   POST   /v1/integrations/webhook-deliveries/:id/retry
 *   GET    /v1/integrations/webhooks/:id/deliveries
 *
 * Source-level invariants — avoids a Fastify spin-up so the test stays
 * fast and deterministic while still catching the regressions that
 * matter: removing the audit emission, dropping the step-up gate,
 * leaking the test payload into the audit metadata, or accidentally
 * adding "webhook.test" to the public WEBHOOK_EVENT_TYPES enum (which
 * would broadcast the test marker to all subscribers).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TEST_EVENT_TYPE,
  TEST_EVENT_MAX_PAYLOAD_BYTES,
  dispatchTestEventToEndpoint,
} from "../src/services/integrations/webhook-dispatcher.js";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readShared(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../packages/shared/${rel}`, import.meta.url),
    ),
    "utf8",
  );
}

const ROUTES = readApi("src/routes/integrations.routes.ts");
const DISPATCHER = readApi("src/services/integrations/webhook-dispatcher.ts");
const PAGE = readWeb("app/(app)/integrations/page.tsx");
const SHARED_INTEGRATIONS = readShared("src/integrations.ts");

// ===========================================================================
// PART 1 — Dispatcher: test-event helper
// ===========================================================================

describe("PHASE 3 — dispatcher exports test-event helper", () => {
  it("exports TEST_EVENT_TYPE as the canonical 'webhook.test' literal", () => {
    expect(TEST_EVENT_TYPE).toBe("webhook.test");
  });

  it("bounds the operator payload at 4 KiB", () => {
    expect(TEST_EVENT_MAX_PAYLOAD_BYTES).toBe(4 * 1024);
  });

  it("declares dispatchTestEventToEndpoint with the expected signature", () => {
    expect(typeof dispatchTestEventToEndpoint).toBe("function");
    // Two formal params: input + optional client.
    expect(dispatchTestEventToEndpoint.length).toBeGreaterThanOrEqual(1);
  });

  it("the test event literal is NOT added to the public WEBHOOK_EVENT_TYPES enum", () => {
    // CRITICAL: if "webhook.test" were added to the canonical list,
    // every endpoint subscribing to "all events" would receive every
    // test, polluting production subscribers' inboxes. The whole
    // point of the dedicated dispatch path is single-endpoint
    // targeting.
    expect(SHARED_INTEGRATIONS).not.toMatch(/"webhook\.test"/);
  });

  it("dispatchTestEventToEndpoint goes through the same attemptDelivery path as emitWebhookEvent", () => {
    // Pin the implementation invariant: the helper MUST reuse the
    // canonical attemptDelivery call so signing, retry classification,
    // and operational counters are identical between real and test
    // events.
    const helperMatch = DISPATCHER.match(
      /export async function dispatchTestEventToEndpoint\([\s\S]+?\n\}\n/,
    );
    expect(helperMatch).not.toBeNull();
    const body = helperMatch![0];
    // Reuses attemptDelivery (not a parallel inline implementation).
    expect(body).toMatch(/attemptDelivery\(\s*row,\s*endpoint,\s*client\s*\)/);
    // Writes a delivery row with the canonical test event type.
    expect(body).toMatch(/eventType:\s*TEST_EVENT_TYPE/);
    // Marks the payload with the operator-recognisable kind="test".
    expect(body).toMatch(/kind:\s*"test"/);
  });

  it("dispatchTestEventToEndpoint refuses non-ACTIVE endpoints", () => {
    const helperMatch = DISPATCHER.match(
      /export async function dispatchTestEventToEndpoint\([\s\S]+?\n\}\n/,
    );
    expect(helperMatch![0]).toMatch(/endpoint\.status\s*!==\s*"ACTIVE"/);
  });

  it("dispatchTestEventToEndpoint scopes the lookup by teamId", () => {
    // SSRF / authorization guard: the helper MUST NOT look up an
    // endpoint by id alone — it MUST also constrain by teamId so a
    // member of workspace A cannot test an endpoint from workspace B.
    const helperMatch = DISPATCHER.match(
      /export async function dispatchTestEventToEndpoint\([\s\S]+?\n\}\n/,
    );
    expect(helperMatch![0]).toMatch(
      /findFirst\(\{[\s\S]+?id:\s*input\.endpointId[\s\S]+?teamId:\s*input\.teamId/,
    );
  });
});

// ===========================================================================
// PART 2 — Route contract: POST /v1/integrations/webhooks/:id/test
// ===========================================================================

describe("PHASE 3 — test-event route contract", () => {
  it("declares POST /v1/integrations/webhooks/:id/test", () => {
    expect(ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/integrations\/webhooks\/:id\/test"/,
    );
  });

  it("requires the full auth chain (auth + member + manage + step-up)", () => {
    const routeMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|void TEST_EVENT_MAX_PAYLOAD_BYTES)/,
    );
    expect(routeMatch).not.toBeNull();
    const body = routeMatch![0];
    expect(body).toMatch(/preHandler:\s*requireAuth/);
    // PHASE 1 (2026-07-21): capability is the 4th arg to requireMember (→ authorizeOrFail).
    expect(body).toMatch(/requireMember\([^)]*"integration\.webhook\.manage"\)/);
    expect(body).toMatch(/requireStepUpForSensitiveAction\(/);
  });

  it("locks the eventType body field to the canonical test literal", () => {
    const routeMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|void TEST_EVENT_MAX_PAYLOAD_BYTES)/,
    );
    // Operators must NOT be able to spoof a real event type through
    // this route — the zod schema pins the value to TEST_EVENT_TYPE.
    expect(routeMatch![0]).toMatch(
      /eventType:\s*z\.literal\(TEST_EVENT_TYPE\)\.optional\(\)/,
    );
  });

  it("returns 202 with { deliveryId, eventId }", () => {
    const routeMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|void TEST_EVENT_MAX_PAYLOAD_BYTES)/,
    );
    const body = routeMatch![0];
    expect(body).toMatch(/reply\.code\(202\)\.send\(/);
    expect(body).toMatch(/deliveryId:\s*result\.deliveryId/);
    expect(body).toMatch(/eventId:\s*result\.eventId/);
  });

  it("returns 404 with stable code when endpoint missing or inactive", () => {
    const routeMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|void TEST_EVENT_MAX_PAYLOAD_BYTES)/,
    );
    expect(routeMatch![0]).toMatch(
      /reply\s*\.code\(404\)[\s\S]{0,200}endpoint_not_found_or_inactive/,
    );
  });

  it("emits integration.webhook.test_sent audit event", () => {
    const routeMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|void TEST_EVENT_MAX_PAYLOAD_BYTES)/,
    );
    expect(routeMatch![0]).toMatch(
      /emitWebhookAudit\(\{[\s\S]+?eventType:\s*"integration\.webhook\.test_sent"/,
    );
  });

  it("audit metadata for test_sent does NOT include the operator payload", () => {
    const routeMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\(|void TEST_EVENT_MAX_PAYLOAD_BYTES)/,
    );
    const body = routeMatch![0];
    const emitMatch = body.match(
      /emitWebhookAudit\(\{[\s\S]+?eventType:\s*"integration\.webhook\.test_sent"[\s\S]+?\}\)/,
    );
    expect(emitMatch).not.toBeNull();
    const emit = emitMatch![0];
    // Allow operator-visible identifiers only; reject the bounded
    // request body and the resulting payload blob.
    expect(emit).not.toMatch(/payload:/);
    expect(emit).not.toMatch(/rawSecret/);
    expect(emit).not.toMatch(/secretCiphertext/);
  });
});

// ===========================================================================
// PART 3 — Retry route now emits audit
// ===========================================================================

describe("PHASE 3 — retry route emits audit event", () => {
  it("emits integration.webhook.delivery_retried after a successful retry", () => {
    const retryMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/webhook-deliveries\/:id\/retry"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\()/,
    );
    expect(retryMatch).not.toBeNull();
    expect(retryMatch![0]).toMatch(
      /emitWebhookAudit\(\{[\s\S]+?eventType:\s*"integration\.webhook\.delivery_retried"/,
    );
  });

  it("retry audit metadata never includes responseBodyPreview or signing secret", () => {
    const retryMatch = ROUTES.match(
      /app\.post\(\s*"\/v1\/integrations\/webhook-deliveries\/:id\/retry"[\s\S]+?(?=app\.(?:post|patch|get|put|delete)\()/,
    );
    const emit = retryMatch![0].match(
      /emitWebhookAudit\(\{[\s\S]+?\}\)/,
    );
    expect(emit).not.toBeNull();
    expect(emit![0]).not.toMatch(/responseBodyPreview/);
    expect(emit![0]).not.toMatch(/rawSecret|secretCiphertext/);
  });
});

// ===========================================================================
// PART 4 — Webhook audit metadata invariants
// ===========================================================================

describe("PHASE 3 — emitWebhookAudit never carries the signing secret or payload", () => {
  it("every emitWebhookAudit call site is bounded to operator-visible identifiers", () => {
    const callSites = [...ROUTES.matchAll(/emitWebhookAudit\(\{[\s\S]+?\}\)/g)];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
    for (const m of callSites) {
      const body = m[0];
      expect(body).not.toMatch(/rawSecret/);
      expect(body).not.toMatch(/secretCiphertext/);
      expect(body).not.toMatch(/payloadJson/);
    }
  });
});

// ===========================================================================
// PART 5 — Page: deliveries panel + retry + send test
// ===========================================================================

describe("PHASE 3 — page surfaces deliveries panel + retry + send-test buttons", () => {
  it("declares the WebhookDeliveriesPanel component", () => {
    expect(PAGE).toMatch(/function WebhookDeliveriesPanel\(/);
  });

  it("renders a 'Deliveries' toggle button per endpoint", () => {
    expect(PAGE).toMatch(/integrations-webhook-deliveries-toggle-/);
  });

  it("renders a 'Send test' button per ACTIVE endpoint", () => {
    expect(PAGE).toMatch(/integrations-webhook-test-/);
    expect(PAGE).toMatch(/Send test/);
  });

  it("calls POST /v1/integrations/webhooks/:id/test from sendWebhookTestEvent", () => {
    expect(PAGE).toMatch(
      /\/v1\/integrations\/webhooks\/\$\{encodeURIComponent\(id\)\}\/test/,
    );
  });

  it("calls POST /v1/integrations/webhook-deliveries/:id/retry from retryWebhookDelivery", () => {
    expect(PAGE).toMatch(
      /\/v1\/integrations\/webhook-deliveries\/\$\{encodeURIComponent\(deliveryId\)\}\/retry/,
    );
  });

  it("loads the last 25 deliveries from GET /v1/integrations/webhooks/:id/deliveries", () => {
    expect(PAGE).toMatch(
      /\/v1\/integrations\/webhooks\/\$\{encodeURIComponent\(id\)\}\/deliveries[\s\S]{0,80}limit=25/,
    );
  });

  it("shows the canonical empty state copy when no deliveries are present", () => {
    expect(PAGE).toMatch(
      /No deliveries yet\. Send a test event to validate this endpoint\./,
    );
  });

  it("the deliveries panel never serialises raw JSON with JSON.stringify or <pre>", () => {
    const startIdx = PAGE.indexOf("function WebhookDeliveriesPanel(");
    expect(startIdx).toBeGreaterThan(-1);
    const slice = PAGE.slice(startIdx, startIdx + 12000);
    expect(slice).not.toMatch(/JSON\.stringify/);
    expect(slice).not.toMatch(/<pre>/);
  });

  it("the deliveries panel renders the test chip for webhook.test rows", () => {
    const startIdx = PAGE.indexOf("function WebhookDeliveriesPanel(");
    const slice = PAGE.slice(startIdx, startIdx + 12000);
    expect(slice).toMatch(/WEBHOOK_TEST_EVENT_TYPE/);
    expect(slice).toMatch(/integrations-webhook-delivery-test-chip-/);
  });

  it("the retry button is disabled while a retry is in flight", () => {
    expect(PAGE).toMatch(/integrations-webhook-delivery-retry-/);
    // The Retry button reads `retryingDeliveryId` via the
    // panel's `isInflight` boolean. Scan the entire
    // WebhookDeliveriesPanel block — the source file is wide enough
    // that the JSX exceeds the previously-narrow window.
    const startIdx = PAGE.indexOf("function WebhookDeliveriesPanel(");
    expect(startIdx).toBeGreaterThan(-1);
    // Take enough to cover the whole component definition.
    const slice = PAGE.slice(startIdx, startIdx + 12000);
    expect(slice).toMatch(/isInflight/);
    expect(slice).toMatch(/disabled=\{isInflight\}/);
  });

  it("renders an Enable button for DISABLED endpoints (canonical via PUT status)", () => {
    expect(PAGE).toMatch(/integrations-webhook-enable-/);
    expect(PAGE).toMatch(/"PUT"[\s\S]{0,200}status:\s*"ACTIVE"/);
  });

  it("renders an error chip styled distinctly when deliveries load fails", () => {
    expect(PAGE).toMatch(/integrations-webhook-deliveries-error-/);
  });
});

// ===========================================================================
// PART 6 — Honest scope: features documented in the route header
// ===========================================================================

describe("PHASE 3 — route header documents the new test endpoint", () => {
  it("docstring includes the test route line", () => {
    expect(ROUTES).toMatch(
      /POST\s+\/v1\/integrations\/webhooks\/:id\/test\s+\(Phase 3\)/,
    );
  });
});
