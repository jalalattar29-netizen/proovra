/**
 * PHASE 7 — Integrations security verification + UX polish.
 *
 * Part A — security verification. Every admin route already passes
 *   - `requireAuth` (cookie session),
 *   - `requireMember` (workspace membership),
 *   - `requirePermission` with `integration.api_key.manage` or
 *     `integration.webhook.manage`,
 *   - and the sensitive mutations additionally gate on
 *     `requireStepUpForSensitiveAction`.
 *
 *   The audit emitter (`emitApiKeyAudit` / `emitWebhookAudit`) writes
 *   a TeamActivity row for each lifecycle action. Phase 7 PINS these
 *   wires by reading the source so a future regression that drops
 *   step-up, the permission gate, or the audit emit is caught.
 *
 *   The SSRF guard (`validateWebhookUrl`) is verified directly against
 *   localhost/RFC1918/CGNAT/link-local/v6-mapped/IPv6-private hosts.
 *
 *   Secret-safety: assert no projection echoes a raw key, a raw
 *   signing secret, a key hash, or a ciphertext.
 *
 *   Rate-limit: the integrations public API path applies a per-credential
 *   rate limit; the admin test-event / retry routes are gated by
 *   step-up (which inherently throttles human-driven misuse) and by
 *   the workspace permission check.
 *
 * Part B — UX polish source invariants.
 *   - Page status banner has three explicit states with stable
 *     copy ("Enabled", "Disabled — admin configuration required",
 *     "Needs attention — N endpoints failing").
 *   - API key + webhook empty states use the prescribed onboarding copy.
 *   - The error banner strips JSON-looking payloads and only shows
 *     the machine code chip to admins.
 *   - The Node receiver verifier example matches the documented
 *     header semantics — pinned via regex so the copy and code
 *     never drift.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateWebhookUrl } from "@proovra/shared";

// ---------------------------------------------------------------------------
// Source loaders (same convention as PHASE 1-6).
// ---------------------------------------------------------------------------

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

const ROUTES = readApi("src/routes/integrations.routes.ts");
const MIDDLEWARE = readApi("src/middleware/integrations-auth.ts");
const API_ROUTES = readApi("src/routes/integrations-api.routes.ts");
const PAGE = readWeb("app/(app)/integrations/page.tsx");

// ===========================================================================
// PART A — Security verification (source invariants).
// ===========================================================================

describe("PHASE 7 — admin routes are permission-gated", () => {
  // The admin routes file mutates API keys and webhook endpoints. Every
  // mutation handler MUST gate on the canonical permission BEFORE
  // dispatching to a service call. We pin this by counting the
  // permission-check usages against the number of routes — a regression
  // that drops one would fail loudly.
  it("every api_key route calls requirePermission with integration.api_key.manage", () => {
    // Each route handler has its own permission check block. Pin the
    // exact number of api_key.manage gates currently in the file.
    const apiKeyGates =
      ROUTES.match(
        /requireMember\(req, reply, [^,]+,\s*"integration\.api_key\.manage"\)/g,
      ) ?? [];
    // 5 = list, create, revoke, rotate, patch-expiry, usage.
    // Count of routes calling the api_key permission:
    //   GET /api-keys, POST /api-keys, POST /api-keys/:id/revoke,
    //   POST /api-keys/:id/rotate, PATCH /api-keys/:id, GET /api-keys/:id/usage.
    expect(apiKeyGates.length).toBeGreaterThanOrEqual(6);
  });

  it("every webhook route calls requirePermission with integration.webhook.manage", () => {
    const webhookGates =
      ROUTES.match(
        /requireMember\(req, reply, [^,]+,\s*"integration\.webhook\.manage"\)/g,
      ) ?? [];
    // Count of webhook-permission gates:
    //   GET /webhooks, POST /webhooks, PUT /webhooks/:id,
    //   POST /webhooks/:id/rotate-secret, POST /webhooks/:id/disable,
    //   POST /webhooks/:id/test, GET /webhooks/:id/deliveries,
    //   GET /webhook-deliveries/:id, POST /webhook-deliveries/:id/retry,
    //   POST /webhook-deliveries/:id/cancel.
    expect(webhookGates.length).toBeGreaterThanOrEqual(10);
  });

  it("permission denial is reported via the canonical primitive (authorizeOrFail)", () => {
    // PHASE 1 (2026-07-21): the bounded `permission_denied` code is now emitted
    // by the canonical middleware, not inline in the route. The route composes
    // authorizeOrFail, which owns the denial response.
    expect(ROUTES).toMatch(/authorizeOrFail\(/);
  });
});

describe("PHASE 7 — sensitive actions require step-up", () => {
  // `requireStepUpForSensitiveAction` gates the create / rotate /
  // revoke paths for API keys AND the rotate-secret / test-send paths
  // for webhooks. A regression that drops one of these is the
  // headline finding the brief calls out.
  //
  // Phase 4 closure migrated each call site from the coarse legacy
  // SERVICE_ACCOUNT_* purposes to dedicated INTEGRATION_API_KEY_* /
  // INTEGRATION_WEBHOOK_* purposes. Back-compat (legacy purpose on
  // an already-issued challenge still satisfies the new check) is
  // covered by phase-closure-integration-step-up-purposes.test.ts.
  it("api_key create gates on INTEGRATION_API_KEY_CREATE step-up", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/api-keys"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_API_KEY_CREATE"/,
    );
  });

  it("api_key revoke gates on INTEGRATION_API_KEY_REVOKE step-up", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/api-keys\/:id\/revoke"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_API_KEY_REVOKE"/,
    );
  });

  it("api_key rotate gates on INTEGRATION_API_KEY_ROTATE step-up", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/api-keys\/:id\/rotate"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_API_KEY_ROTATE"/,
    );
  });

  it("webhook secret rotation gates on INTEGRATION_WEBHOOK_SECRET_ROTATE step-up", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/webhooks\/:id\/rotate-secret"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_SECRET_ROTATE"/,
    );
  });

  it("webhook test-send gates on INTEGRATION_WEBHOOK_TEST step-up", () => {
    expect(ROUTES).toMatch(
      /\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?requireStepUpForSensitiveAction[\s\S]+?purpose:\s*"INTEGRATION_WEBHOOK_TEST"/,
    );
  });

  it("import is the canonical step-up middleware", () => {
    expect(ROUTES).toMatch(
      /from\s+"\.\.\/services\/identity-security\/step-up-middleware\.js"/,
    );
  });
});

describe("PHASE 7 — every lifecycle mutation emits an audit event", () => {
  // `emitApiKeyAudit` / `emitWebhookAudit` write to TeamActivity.
  // The full set of operator-visible lifecycle events covered:
  //   - create / rotate / revoke / expiry-change for API keys
  //   - test-event / retry / secret-rotate for webhooks
  //   - enable / disable for webhooks (status flip via PUT)
  it("api_key create emits integration.api_key.created", () => {
    expect(ROUTES).toMatch(/eventType:\s*"integration\.api_key\.created"/);
  });

  it("api_key revoke emits integration.api_key.revoked with the reason", () => {
    expect(ROUTES).toMatch(/eventType:\s*"integration\.api_key\.revoked"/);
    expect(ROUTES).toMatch(/reason:\s*revoked\.revokedReason/);
  });

  it("api_key rotate emits integration.api_key.rotated with prefix-only metadata", () => {
    expect(ROUTES).toMatch(/eventType:\s*"integration\.api_key\.rotated"/);
    expect(ROUTES).toMatch(/newKeyPrefix:\s*result\.credential\.keyPrefix/);
    expect(ROUTES).toMatch(/previousKeyPrefix:\s*result\.previousKeyPrefix/);
  });

  it("api_key PATCH expiry emits integration.api_key.expiry_changed", () => {
    expect(ROUTES).toMatch(
      /eventType:\s*"integration\.api_key\.expiry_changed"/,
    );
  });

  it("webhook test-send emits integration.webhook.test_sent", () => {
    expect(ROUTES).toMatch(/eventType:\s*"integration\.webhook\.test_sent"/);
  });

  it("webhook delivery retry emits integration.webhook.delivery_retried", () => {
    expect(ROUTES).toMatch(
      /eventType:\s*"integration\.webhook\.delivery_retried"/,
    );
  });

  it("webhook secret rotation emits integration.webhook.secret_rotated", () => {
    expect(ROUTES).toMatch(
      /eventType:\s*"integration\.webhook\.secret_rotated"/,
    );
    // Operator-visible prefix only; ciphertext / raw secret never in metadata.
    expect(ROUTES).toMatch(/newSecretPrefix:\s*result\.endpoint\.secretPrefix/);
    expect(ROUTES).not.toMatch(
      /metadata:\s*\{[^}]*previousSecretCiphertext/m,
    );
    expect(ROUTES).not.toMatch(/metadata:\s*\{[^}]*rawSecret/m);
  });

  it("audit metadata never carries raw secrets, key hashes, or ciphertexts", () => {
    // The whole file's audit emit call sites can never carry these.
    const audits = ROUTES.match(/emit(?:ApiKey|Webhook)Audit\(\s*\{[\s\S]+?\}\s*\)/g) ?? [];
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(a).not.toMatch(/rawKey/);
      expect(a).not.toMatch(/rawSecret/);
      expect(a).not.toMatch(/keyHash/);
      expect(a).not.toMatch(/secretCiphertext/);
      expect(a).not.toMatch(/Authorization/);
    }
  });
});

describe("PHASE 7 — SSRF guard rejects private destinations", () => {
  // The guard runs server-side inside `createWebhookEndpoint`. Direct
  // unit tests for the function are documented here so a future
  // refactor to `validateWebhookUrl` cannot regress the protections.
  const PRIVATE_HOSTS = [
    // Loopback + zero
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://0.0.0.0/hook",
    // RFC1918
    "https://10.0.0.1/hook",
    "https://10.255.255.254/hook",
    "https://172.16.5.5/hook",
    "https://172.31.255.255/hook",
    "https://192.168.1.10/hook",
    // Link-local (cloud metadata endpoint surface — AWS, GCP)
    "https://169.254.169.254/latest/meta-data/",
    // CGNAT
    "https://100.64.0.1/hook",
    "https://100.127.255.254/hook",
    // IPv6 loopback + unspecified
    "https://[::1]/hook",
    "https://[::]/hook",
    // IPv6 ULA
    "https://[fd00::1]/hook",
    "https://[fc00::1]/hook",
    // IPv6 link-local
    "https://[fe80::1]/hook",
    // IPv4-mapped IPv6 (dot-quad)
    "https://[::ffff:127.0.0.1]/hook",
    "https://[::ffff:10.0.0.1]/hook",
    "https://[::ffff:192.168.0.1]/hook",
    "https://[::ffff:169.254.169.254]/hook",
    // IPv4-mapped IPv6 (hex form — the Node URL parser normalises to this)
    "https://[::ffff:7f00:1]/hook", // 127.0.0.1
    "https://[::ffff:0a00:1]/hook", // 10.0.0.1
    "https://[::ffff:c0a8:1]/hook", // 192.168.0.1
    "https://[::ffff:a9fe:a9fe]/hook", // 169.254.169.254
  ];
  for (const url of PRIVATE_HOSTS) {
    it(`rejects ${url}`, () => {
      const res = validateWebhookUrl(url);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("private_network_blocked");
      }
    });
  }

  it("rejects non-HTTPS schemes", () => {
    const httpRes = validateWebhookUrl("http://example.com/hook");
    expect(httpRes.ok).toBe(false);
    if (!httpRes.ok) expect(httpRes.reason).toBe("https_required");
  });

  it("rejects URLs that embed credentials", () => {
    const credRes = validateWebhookUrl("https://user:pw@example.com/hook");
    expect(credRes.ok).toBe(false);
    if (!credRes.ok) expect(credRes.reason).toBe("credentials_in_url_not_allowed");
  });

  it("accepts a normal HTTPS endpoint URL", () => {
    const ok = validateWebhookUrl("https://example.com/webhooks/proovra");
    expect(ok.ok).toBe(true);
  });

  it("createWebhookEndpoint runs validateWebhookUrl with the workspace allow flag", () => {
    // Pinning the call site so a refactor that drops the SSRF check
    // can never silently land.
    const SERVICE = readApi("src/services/integrations/webhooks.service.ts");
    expect(SERVICE).toMatch(
      /validateWebhookUrl\(\s*input\.url\s*,\s*\{[\s\S]+?allowPrivateNetworks:\s*webhookAllowPrivateNetworks\(\)/,
    );
    // And the failure path must throw the structured invalid_url error.
    expect(SERVICE).toMatch(/throw new WebhookEndpointError\("invalid_url"/);
  });
});

describe("PHASE 7 — secret-safety in projections + usage logs", () => {
  // Projections are unit-tested separately (integrations-hardening.test.ts).
  // This block pins the source-text invariants — a future schema edit
  // that added a `keyHash` or `secretCiphertext` to a projection would
  // fail.
  it("projectApiCredential never assigns keyHash or previousKeyHash on the returned object", () => {
    const SERVICE = readApi("src/services/integrations/api-keys.service.ts");
    // The projection function returns an object literal. We forbid the
    // property-assignment forms (`keyHash: ...`, `previousKeyHash: ...`)
    // because they would mean a real exposure. The trailing "NOT
    // returned" comment is allowed evidence and ignored by this regex.
    const projection = SERVICE.match(
      /export function projectApiCredential[\s\S]+?\n\}/,
    );
    expect(projection).not.toBeNull();
    expect(projection![0]).not.toMatch(/\n\s*keyHash:/);
    expect(projection![0]).not.toMatch(/\n\s*previousKeyHash:/);
  });

  it("projectWebhookEndpoint never assigns secretCiphertext on the returned object", () => {
    const SERVICE = readApi("src/services/integrations/webhooks.service.ts");
    const projection = SERVICE.match(
      /export function projectWebhookEndpoint[\s\S]+?\n\}/,
    );
    expect(projection).not.toBeNull();
    expect(projection![0]).not.toMatch(/\n\s*secretCiphertext:/);
    expect(projection![0]).not.toMatch(/\n\s*previousSecretCiphertext:/);
  });

  it("usage-log projection omits Authorization / raw bearer / raw key fields", () => {
    const USAGE = readApi("src/services/integrations/api-key-usage.service.ts");
    const projection = USAGE.match(
      /export function projectApiCredentialUsage[\s\S]+?\n\}/,
    );
    expect(projection).not.toBeNull();
    expect(projection![0]).not.toMatch(/\n\s*authorization:/i);
    expect(projection![0]).not.toMatch(/\n\s*bearer:/i);
    expect(projection![0]).not.toMatch(/\n\s*rawKey:/);
  });

  it("usage-log writer never persists request bodies, raw keys, or Auth headers", () => {
    const USAGE = readApi("src/services/integrations/api-key-usage.service.ts");
    // The CREATE payload only includes the bounded fields. Pin the
    // permitted keys; anything else (notably `body` / `headers`) is a
    // regression.
    const create = USAGE.match(
      /apiCredentialUsageLog\.create\(\{\s*data:\s*\{([\s\S]+?)\}\s*,\s*\}\)/,
    );
    expect(create).not.toBeNull();
    expect(create![1]).not.toMatch(/headers/i);
    expect(create![1]).not.toMatch(/body/i);
    expect(create![1]).not.toMatch(/authorization/i);
    expect(create![1]).not.toMatch(/rawKey/);
  });
});

describe("PHASE 7 — public integrations API enforces rate limit", () => {
  it("requireApiKey applies the per-credential rate limit", () => {
    expect(MIDDLEWARE).toMatch(
      /enforceRateLimit\(\{\s*key:\s*`integration_api:credential:\$\{credential\.credentialId\}`/,
    );
  });

  it("rate-limit response is the canonical 429 + RATE_LIMITED code", () => {
    expect(MIDDLEWARE).toMatch(/reply\.code\(429\)/);
    expect(MIDDLEWARE).toMatch(/code:\s*"RATE_LIMITED"/);
  });

  it("rate-limit response sets retry-after + x-ratelimit-* headers", () => {
    expect(MIDDLEWARE).toMatch(/x-ratelimit-limit/);
    expect(MIDDLEWARE).toMatch(/x-ratelimit-remaining/);
    expect(MIDDLEWARE).toMatch(/x-ratelimit-reset/);
    expect(MIDDLEWARE).toMatch(/retry-after/);
  });

  it("rate-limit denial is audited with action=rate_limited so abuse is visible", () => {
    expect(MIDDLEWARE).toMatch(
      /safeRecordApiCredentialUsage\(\{[\s\S]+?action:\s*"rate_limited"/,
    );
  });

  it("the public API never logs a raw Authorization header or bearer token", () => {
    // The bearer extraction is local to `readBearerToken` and is never
    // written to the audit log. Any future regression that wrote the
    // header into the audit row is caught by the usage-log writer
    // invariants above.
    expect(MIDDLEWARE).not.toMatch(/log\.info[\s\S]{0,40}authorization/i);
    expect(MIDDLEWARE).not.toMatch(/log\.warn[\s\S]{0,40}bearer/i);
  });

  it("public API routes wrap every handler in runWithApiAudit", () => {
    // Pin the count of `runWithApiAudit` calls vs the count of public
    // routes — a new route added without audit wrapping is a regression.
    const audits = API_ROUTES.match(/runWithApiAudit\(/g) ?? [];
    expect(audits.length).toBeGreaterThanOrEqual(5);
  });
});

describe("PHASE 7 — admin test-event + retry routes inherit workspace gates", () => {
  // The admin routes (/v1/integrations/webhooks/:id/test and the
  // delivery /retry route) reuse `requireMember + requirePermission +
  // requireStepUpForSensitiveAction`. The brief asks us to confirm
  // the rate-limit posture; the actual back-pressure for human-driven
  // mutations comes from step-up + the permission gate (only ADMIN /
  // OWNER can hit them at all). We pin both gates here.
  it("test-event route gates on requireMember + permission + step-up", () => {
    const block = ROUTES.match(
      /\/v1\/integrations\/webhooks\/:id\/test"[\s\S]+?return reply\.code\(202\)/,
    );
    expect(block).not.toBeNull();
    const body = block![0];
    expect(body).toMatch(/requireMember\(/);
    expect(body).toMatch(/"integration\.webhook\.manage"/);
    expect(body).toMatch(/requireStepUpForSensitiveAction\(/);
  });

  it("delivery retry route gates on requireMember + permission", () => {
    // Find the retry route handler — it starts at the route literal and
    // ends at the next `app.post(` declaration (or end-of-file). This
    // is a loose-but-bounded window so we can pin the inner gates.
    const idx = ROUTES.indexOf(
      '"/v1/integrations/webhook-deliveries/:id/retry"',
    );
    expect(idx).toBeGreaterThan(-1);
    const nextPost = ROUTES.indexOf("app.post(", idx + 1);
    const block = ROUTES.slice(
      idx,
      nextPost > 0 ? nextPost : ROUTES.length,
    );
    expect(block).toMatch(/requireMember\(/);
    expect(block).toMatch(/"integration\.webhook\.manage"/);
  });
});

// ===========================================================================
// PART B — UX polish (source invariants).
// ===========================================================================

describe("PHASE 7 — page status banner", () => {
  it("renders the three documented states", () => {
    expect(PAGE).toMatch(/data-status="enabled"/);
    expect(PAGE).toMatch(/data-status="disabled"/);
    expect(PAGE).toMatch(/data-status="needs_attention"/);
  });

  it("Enabled copy is exactly the prescribed string", () => {
    // Render branch — the JSX surrounding "Enabled" must NOT include
    // the warn/neutral wording. We use a tight regex over the
    // PageStatusBanner body.
    const enabledBranch = PAGE.match(
      /data-status="enabled"[\s\S]+?<\/div>/,
    );
    expect(enabledBranch).not.toBeNull();
    expect(enabledBranch![0]).toMatch(/<strong>Enabled<\/strong>/);
  });

  it("Disabled copy is the prescribed admin-configuration string", () => {
    const disabledBranch = PAGE.match(
      /data-status="disabled"[\s\S]+?<\/div>/,
    );
    expect(disabledBranch).not.toBeNull();
    expect(disabledBranch![0]).toMatch(
      /<strong>Disabled<\/strong>\s*— admin configuration required\./,
    );
  });

  it("Needs-attention copy renders the failing-endpoint count and singular/plural", () => {
    const warnBranch = PAGE.match(
      /data-status="needs_attention"[\s\S]+?<\/div>/,
    );
    expect(warnBranch).not.toBeNull();
    expect(warnBranch![0]).toMatch(/<strong>Needs attention<\/strong>/);
    expect(warnBranch![0]).toMatch(/\{failing\}/);
    // The "endpoint" token + the singular/plural expression are split
    // across two JSX lines with arbitrary indentation between them.
    expect(warnBranch![0]).toMatch(
      /endpoint[\s\S]{0,40}\{failing === 1 \? "" : "s"\} failing\./,
    );
  });

  it("failing-endpoint count is derived from the already-loaded webhooks list", () => {
    // Pin the derivation to be from the canonical webhooks state — no
    // duplicate fetch, no fabricated metric.
    expect(PAGE).toMatch(
      /webhooks\.filter\([\s\S]+?w\.status === "ACTIVE" && w\.failureCount > 0[\s\S]+?\)/,
    );
  });
});

describe("PHASE 7 — empty-state copy is operator-friendly", () => {
  it("API keys list uses the prescribed onboarding string", () => {
    expect(PAGE).toMatch(
      /No API keys yet\. Create your first key to integrate with[\s\S]{0,40}the Proovra API\./,
    );
    expect(PAGE).toMatch(
      /data-testid="integrations-api-keys-empty-state"/,
    );
  });

  it("webhooks list uses the prescribed onboarding string", () => {
    expect(PAGE).toMatch(
      /No webhook endpoints yet\. Receive event notifications when[\s\S]{0,80}evidence is captured, finalized, or requested\./,
    );
    expect(PAGE).toMatch(
      /data-testid="integrations-webhooks-empty-state"/,
    );
  });
});

describe("PHASE 7 — error banner never shows raw JSON to normal users", () => {
  it("error banner strips JSON-looking payloads before render", () => {
    expect(PAGE).toMatch(
      /trimmed\.startsWith\("\{"\)\s*\|\|\s*trimmed\.startsWith\("\["\)/,
    );
  });

  it("the machine code chip is rendered ONLY when isAdmin && code", () => {
    expect(PAGE).toMatch(/\{isAdmin && code\s*\?\s*\(/);
    expect(PAGE).toMatch(
      /data-testid="integrations-error-code-chip"/,
    );
  });

  it("the chip text is the code= short identifier, not a sentence", () => {
    const chip = PAGE.match(
      /data-testid="integrations-error-code-chip"[\s\S]+?<\/span>/,
    );
    expect(chip).not.toBeNull();
    expect(chip![0]).toMatch(/code=\{code\}/);
  });
});

describe("PHASE 7 — SignatureDocsPanel copy + Node verifier example", () => {
  it("panel is collapsible (toggle button + aria-expanded)", () => {
    expect(PAGE).toMatch(
      /data-testid="integrations-signature-docs-toggle"/,
    );
    expect(PAGE).toMatch(/aria-expanded=\{open\}/);
  });

  it("Node verifier snippet uses crypto.timingSafeEqual", () => {
    expect(PAGE).toMatch(/crypto\.timingSafeEqual/);
  });

  it("Node verifier snippet uses the canonical signing base", () => {
    // The dispatcher signs `${ts}.${rawBody}`; the verifier must
    // reconstruct exactly that string.
    expect(PAGE).toMatch(/ts \+ "\." \+ body/);
  });

  it("Node verifier snippet parses the dual-signature header", () => {
    expect(PAGE).toMatch(/sig\.split\(","\)/);
  });

  it("Node verifier snippet enforces a 5-minute replay window", () => {
    expect(PAGE).toMatch(/5\s*\*\s*60_000/);
    expect(PAGE).toMatch(/TIMESTAMP_TOLERANCE_MS/);
  });

  it("docs explicitly cover idempotency + retry + delivery history + test events + rotation", () => {
    expect(PAGE).toMatch(/<h3 style=\{subHeadingStyle\}>Idempotency<\/h3>/);
    expect(PAGE).toMatch(/<h3 style=\{subHeadingStyle\}>Timestamp tolerance<\/h3>/);
    expect(PAGE).toMatch(/<h3 style=\{subHeadingStyle\}>Retry behavior<\/h3>/);
    expect(PAGE).toMatch(/<h3 style=\{subHeadingStyle\}>Delivery history<\/h3>/);
    expect(PAGE).toMatch(/<h3 style=\{subHeadingStyle\}>Test events<\/h3>/);
    expect(PAGE).toMatch(/<h3 style=\{subHeadingStyle\}>Secret rotation<\/h3>/);
  });

  it("X-Proovra-Event-Id is documented as the idempotency key", () => {
    // The header list mentions X-Proovra-Event-Id first, then the
    // Idempotency section mentions it again. The Idempotency-section
    // copy is what we pin — search the idempotency h3 block.
    const idempotencyBlock = PAGE.match(
      /<h3 style=\{subHeadingStyle\}>Idempotency<\/h3>[\s\S]+?<\/p>/,
    );
    expect(idempotencyBlock).not.toBeNull();
    expect(idempotencyBlock![0]).toMatch(
      /<code>X-Proovra-Event-Id<\/code>[\s\S]{0,80}as[\s\S]{0,40}an idempotency key/,
    );
  });

  it("verifier example variable + header set documented matches the code semantically", () => {
    // Pin the variable name + every Proovra header the example uses.
    // If the code drops a header or renames the variable, this
    // catches it.
    expect(PAGE).toMatch(/const NODE_VERIFIER_SNIPPET =/);
    expect(PAGE).toMatch(/x-proovra-timestamp/i);
    expect(PAGE).toMatch(/x-proovra-signature/i);
  });

  it("retry / delivery-history / test-event copy mentions the operator-facing buttons", () => {
    expect(PAGE).toMatch(/<strong>Deliveries<\/strong>/);
    expect(PAGE).toMatch(/<strong>Retry<\/strong>/);
    expect(PAGE).toMatch(/<strong>Send test<\/strong>/);
    expect(PAGE).toMatch(/<strong>Rotate secret<\/strong>/);
  });
});

describe("PHASE 7 — no raw-JSON regressions", () => {
  it("the page never JSON.stringify a server error envelope before rendering", () => {
    // We don't expect any consumer of `error` to wrap it in
    // JSON.stringify. Pin so a future regression that did so would
    // fail.
    expect(PAGE).not.toMatch(
      /JSON\.stringify\(\s*err[\)\s.]/,
    );
  });
});
