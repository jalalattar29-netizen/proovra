import test from "node:test";
import assert from "node:assert/strict";

// Phase 10 — Integration platform shared-types contract tests.
//
// Verifies the wire-shape pieces that live in @proovra/shared/integrations:
//   * API key format (parse / format / display prefix)
//   * webhook signature base
//   * retry classification + delay ladder
//   * URL safety (HTTPS-only, no private networks, no credentials)
//   * permission catalog contains the new integration scopes

import {
  API_KEY_PREFIX,
  API_KEY_RANDOM_BYTES,
  API_KEY_VERSION,
  PERMISSIONS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HEADER_EVENT,
  WEBHOOK_HEADER_EVENT_ID,
  WEBHOOK_HEADER_SIGNATURE,
  WEBHOOK_HEADER_TIMESTAMP,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
  buildWebhookSignatureBase,
  classifyWebhookHttpError,
  deriveApiKeyDisplayPrefix,
  formatApiKeyValue,
  parseApiKeyShape,
  validateWebhookUrl,
  webhookRetryDelaySeconds,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// API key format
// -----------------------------------------------------------------------------

test("API key format — round-trip parse / format", () => {
  const body = "abcdefghijklmnopqrstuvwxyz012345";
  const formatted = formatApiKeyValue(body);
  assert.equal(formatted, `${API_KEY_PREFIX}_v${API_KEY_VERSION}_${body}`);
  const parsed = parseApiKeyShape(formatted);
  assert.ok(parsed, "must parse");
  assert.equal(parsed.version, API_KEY_VERSION);
  assert.equal(parsed.body, body);
});

test("API key format — rejects wrong prefix", () => {
  assert.equal(parseApiKeyShape("xyz_v1_aaaaaaaaaaaaaaaa"), null);
});

test("API key format — rejects body shorter than 16 chars", () => {
  assert.equal(parseApiKeyShape("pwk_v1_short"), null);
});

test("API key format — rejects empty / non-string", () => {
  assert.equal(parseApiKeyShape(""), null);
  assert.equal(parseApiKeyShape(123), null);
});

test("API key display prefix — exposes the first 8 body chars", () => {
  const raw = formatApiKeyValue("abcdefghijklmnopqrstuvwxyz012345");
  const prefix = deriveApiKeyDisplayPrefix(raw);
  assert.equal(prefix, "pwk_v1_abcdefgh");
});

test("API key display prefix — falls back gracefully on bad input", () => {
  const out = deriveApiKeyDisplayPrefix("not-a-real-key");
  assert.equal(typeof out, "string");
  assert.equal(out.length <= 12, true);
});

test("API key random bytes constant is 32 (256 bits)", () => {
  assert.equal(API_KEY_RANDOM_BYTES, 32);
});

// -----------------------------------------------------------------------------
// Webhook signature scheme
// -----------------------------------------------------------------------------

test("webhook signature base — `{timestamp}.{body}`", () => {
  const base = buildWebhookSignatureBase(1700000000000, '{"hello":"world"}');
  assert.equal(base, '1700000000000.{"hello":"world"}');
});

test("webhook header names are canonical", () => {
  assert.equal(WEBHOOK_HEADER_EVENT, "x-proovra-event");
  assert.equal(WEBHOOK_HEADER_EVENT_ID, "x-proovra-event-id");
  assert.equal(WEBHOOK_HEADER_TIMESTAMP, "x-proovra-timestamp");
  assert.equal(WEBHOOK_HEADER_SIGNATURE, "x-proovra-signature");
});

// -----------------------------------------------------------------------------
// Retry ladder
// -----------------------------------------------------------------------------

test("retry ladder — first attempt has no delay", () => {
  assert.equal(webhookRetryDelaySeconds(1), 0);
});

test("retry ladder — increases monotonically across the documented steps", () => {
  const a = webhookRetryDelaySeconds(2);
  const b = webhookRetryDelaySeconds(3);
  const c = webhookRetryDelaySeconds(4);
  const d = webhookRetryDelaySeconds(5);
  const e = webhookRetryDelaySeconds(6);
  assert.equal(a, 30);
  assert.equal(b, 120);
  assert.equal(c, 600);
  assert.equal(d, 3600);
  assert.equal(e, 6 * 3600);
});

test("retry ladder — caps at 24h after max attempts", () => {
  const past = webhookRetryDelaySeconds(WEBHOOK_RETRY_MAX_ATTEMPTS + 5);
  assert.equal(past, 24 * 3600);
});

// -----------------------------------------------------------------------------
// HTTP error classification
// -----------------------------------------------------------------------------

test("classifyWebhookHttpError — 5xx is transient", () => {
  assert.equal(classifyWebhookHttpError(500, null), "transient");
  assert.equal(classifyWebhookHttpError(503, null), "transient");
});

test("classifyWebhookHttpError — 408/429 is transient", () => {
  assert.equal(classifyWebhookHttpError(408, null), "transient");
  assert.equal(classifyWebhookHttpError(429, null), "transient");
});

test("classifyWebhookHttpError — other 4xx is permanent", () => {
  assert.equal(classifyWebhookHttpError(400, null), "permanent");
  assert.equal(classifyWebhookHttpError(401, null), "permanent");
  assert.equal(classifyWebhookHttpError(403, null), "permanent");
  assert.equal(classifyWebhookHttpError(404, null), "permanent");
});

test("classifyWebhookHttpError — connection markers in error message → transient", () => {
  assert.equal(
    classifyWebhookHttpError(null, "ETIMEDOUT after 10000ms"),
    "transient",
  );
  assert.equal(
    classifyWebhookHttpError(null, "Connection reset by peer"),
    "transient",
  );
});

test("classifyWebhookHttpError — unknown error → permanent", () => {
  assert.equal(classifyWebhookHttpError(null, "SyntaxError"), "permanent");
});

// -----------------------------------------------------------------------------
// URL safety
// -----------------------------------------------------------------------------

test("validateWebhookUrl — accepts public HTTPS", () => {
  const r = validateWebhookUrl("https://example.com/hooks/proovra");
  assert.equal(r.ok, true);
  assert.equal(r.normalized.startsWith("https://example.com/"), true);
});

test("validateWebhookUrl — rejects http://", () => {
  const r = validateWebhookUrl("http://example.com/hooks");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "https_required");
});

test("validateWebhookUrl — rejects localhost", () => {
  for (const h of [
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
  ]) {
    const r = validateWebhookUrl(h);
    assert.equal(r.ok, false, `${h} must be blocked`);
    assert.equal(r.reason, "private_network_blocked");
  }
});

test("validateWebhookUrl — rejects RFC1918 ranges", () => {
  for (const h of [
    "https://10.0.0.1/hook",
    "https://192.168.1.1/hook",
    "https://172.16.0.5/hook",
    "https://172.31.0.5/hook",
    "https://169.254.169.254/hook", // AWS metadata
  ]) {
    const r = validateWebhookUrl(h);
    assert.equal(r.ok, false, `${h} must be blocked`);
    assert.equal(r.reason, "private_network_blocked");
  }
});

test("validateWebhookUrl — rejects credentials embedded in URL", () => {
  const r = validateWebhookUrl("https://user:pw@example.com/hook");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "credentials_in_url_not_allowed");
});

test("validateWebhookUrl — allows private networks when explicitly opted in", () => {
  const r = validateWebhookUrl("https://127.0.0.1/hook", {
    allowPrivateNetworks: true,
  });
  assert.equal(r.ok, true);
});

test("validateWebhookUrl — rejects unparseable input", () => {
  const r = validateWebhookUrl("not even a url");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_url");
});

// -----------------------------------------------------------------------------
// Event-type / status / scope catalogs
// -----------------------------------------------------------------------------

test("event catalog — contains all documented event types", () => {
  for (const name of [
    "evidence.created",
    "evidence.completed",
    "evidence.report_generated",
    "evidence.package_generated",
    "evidence_request.created",
    "evidence_request.sent",
    "evidence_request.response_received",
    "external_intake.submitted",
    "notification.failed",
    "governance.legal_hold_placed",
    "governance.export_blocked",
  ]) {
    assert.ok(
      WEBHOOK_EVENT_TYPES.includes(name),
      `expected ${name} in WEBHOOK_EVENT_TYPES`,
    );
  }
});

test("delivery-status enum contains required terminal/non-terminal states", () => {
  for (const s of [
    "PENDING",
    "SENT",
    "FAILED",
    "RETRY_SCHEDULED",
    "CANCELLED",
  ]) {
    assert.ok(WEBHOOK_DELIVERY_STATUSES.includes(s));
  }
});

test("endpoint status enum is ACTIVE/DISABLED", () => {
  assert.deepEqual([...WEBHOOK_ENDPOINT_STATUSES].sort(), [
    "ACTIVE",
    "DISABLED",
  ]);
});

test("PERMISSIONS catalog contains the new integration scopes", () => {
  for (const s of [
    "integration.api_key.manage",
    "integration.webhook.manage",
    "integration.evidence.read",
    "integration.evidence.create",
    "integration.intake_link.create",
    "integration.evidence_request.create",
    "integration.evidence_request.read",
  ]) {
    assert.ok(
      PERMISSIONS.includes(s),
      `expected ${s} in PERMISSIONS`,
    );
  }
});
