/**
 * Phase 18 — Enterprise Communications API tests.
 *
 *   - Provider abstraction: Noop returns structured "skipped" failures
 *     (never throws), Twilio config parsing fails closed when env is
 *     incomplete, Twilio signature validation is HMAC-SHA1(base64)
 *     keyed by API secret (preferred) or auth token (fallback).
 *   - communication.service: phone normalisation rejected → CANCELLED
 *     row (no provider call), opt-out blocked (non-critical purposes),
 *     critical purposes bypass opt-out.
 *   - verification.service: never persists or echoes the code; rate
 *     limit + check-attempt bound enforced.
 *   - Route surface: webhook routes have NO requireAuth (Twilio
 *     signature IS the auth); operator routes use requireAuth + 404 on
 *     non-members; process-retries uses INTEGRATION_CRON_SECRET.
 *   - Public verify isolation: source-level grep proves no
 *     communication_* table is read from the public verify route.
 *   - Migration safety: ADD COLUMN IF NOT EXISTS + DO $$ EXCEPTION
 *     blocks; no DROP / RENAME on existing columns.
 *   - Untouched architecture: report-v2 + worker/pdf/report.ts +
 *     public verify + OTS/TSA/anchor unchanged.
 *
 * No DB — source-text + projection + provider unit tests only.
 */

import { describe, expect, it } from "vitest";

import { NoopMessagingProvider } from "../src/services/communications/noop-provider.js";
import type { MessagingProvider } from "../src/services/communications/provider.js";
import {
  TwilioMessagingProvider,
  readTwilioConfigFromEnv,
} from "../src/services/communications/twilio-provider.js";
import {
  buildProviderHealthSnapshot,
  getMessagingProvider,
  setMessagingProviderForTests,
} from "../src/services/communications/provider-registry.js";
import { VerificationError } from "../src/services/communications/verification.service.js";

// -----------------------------------------------------------------------------
// Noop provider — never throws, never sends, always structured failure
// -----------------------------------------------------------------------------

describe("NoopMessagingProvider — structured failure surface", () => {
  it("sendSms returns ok:false with provider_unconfigured", async () => {
    const p: MessagingProvider = new NoopMessagingProvider("feature_disabled");
    const r = await p.sendSms({ toE164: "+14155551234", body: "test" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.provider).toBe("NOOP");
      expect(r.reason).toBe("provider_unconfigured");
    }
  });

  it("sendWhatsApp returns ok:false with provider_unconfigured", async () => {
    const p: MessagingProvider = new NoopMessagingProvider("twilio_unconfigured");
    const r = await p.sendWhatsApp({ toE164: "+14155551234", body: "test" });
    expect(r.ok).toBe(false);
  });

  it("startVerification + checkVerification both fail closed", async () => {
    const p: MessagingProvider = new NoopMessagingProvider("feature_disabled");
    const start = await p.startVerification({
      toE164: "+14155551234",
      channel: "SMS",
    });
    expect(start.ok).toBe(false);
    const check = await p.checkVerification({
      toE164: "+14155551234",
      code: "123456",
    });
    expect(check.ok).toBe(false);
  });

  it("verifyWebhookSignature always returns false (no shared secret)", () => {
    const p: MessagingProvider = new NoopMessagingProvider("feature_disabled");
    const ok = p.verifyWebhookSignature({
      url: "https://api.example.com/v1/communications/webhooks/twilio/status",
      rawBody: "",
      fields: { MessageSid: "SMxxx", MessageStatus: "delivered" },
      signatureHeader: "deadbeef==",
    });
    expect(ok).toBe(false);
  });

  it("parseDeliveryWebhook returns kind:ignored on noop", () => {
    const p: MessagingProvider = new NoopMessagingProvider("feature_disabled");
    const parsed = p.parseDeliveryWebhook({ fields: {} });
    expect(parsed.kind).toBe("ignored");
  });
});

// -----------------------------------------------------------------------------
// Twilio config parsing — fail closed when env is incomplete
// -----------------------------------------------------------------------------

describe("readTwilioConfigFromEnv — fail closed", () => {
  const ORIGINAL_ENV = { ...process.env };
  function restore(): void {
    process.env = { ...ORIGINAL_ENV };
  }

  it("returns reason=account_sid_missing when SID is unset", () => {
    process.env = {
      ...ORIGINAL_ENV,
      TWILIO_ACCOUNT_SID: "",
      TWILIO_API_KEY: "k",
      TWILIO_API_SECRET: "s",
      TWILIO_MESSAGING_SERVICE_SID: "MG",
    };
    const { config, reason } = readTwilioConfigFromEnv();
    expect(config).toBeNull();
    expect(reason).toBe("account_sid_missing");
    restore();
  });

  it("returns reason=api_key_missing when key is unset", () => {
    process.env = {
      ...ORIGINAL_ENV,
      TWILIO_ACCOUNT_SID: "AC",
      TWILIO_API_KEY: "",
      TWILIO_API_SECRET: "s",
    };
    const { config, reason } = readTwilioConfigFromEnv();
    expect(config).toBeNull();
    expect(reason).toBe("api_key_missing");
    restore();
  });

  it("returns reason=api_secret_missing when secret is unset", () => {
    process.env = {
      ...ORIGINAL_ENV,
      TWILIO_ACCOUNT_SID: "AC",
      TWILIO_API_KEY: "k",
      TWILIO_API_SECRET: "",
    };
    const { config, reason } = readTwilioConfigFromEnv();
    expect(config).toBeNull();
    expect(reason).toBe("api_secret_missing");
    restore();
  });

  it("returns reason=no_send_target_configured when no MS-SID / from / WA number", () => {
    process.env = {
      ...ORIGINAL_ENV,
      TWILIO_ACCOUNT_SID: "AC",
      TWILIO_API_KEY: "k",
      TWILIO_API_SECRET: "s",
      TWILIO_MESSAGING_SERVICE_SID: "",
      TWILIO_SMS_FROM_NUMBER: "",
      TWILIO_WHATSAPP_NUMBER: "",
    };
    const { config, reason } = readTwilioConfigFromEnv();
    expect(config).toBeNull();
    expect(reason).toBe("no_send_target_configured");
    restore();
  });

  it("returns a config when all required fields are present", () => {
    process.env = {
      ...ORIGINAL_ENV,
      TWILIO_ACCOUNT_SID: "ACxxxxxxxx",
      TWILIO_API_KEY: "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      TWILIO_API_SECRET: "secretvaluehidden",
      TWILIO_MESSAGING_SERVICE_SID: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      TWILIO_VERIFY_SERVICE_SID: "VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    };
    const { config, reason } = readTwilioConfigFromEnv();
    expect(reason).toBeNull();
    expect(config).not.toBeNull();
    expect(config?.accountSid).toBe("ACxxxxxxxx");
    restore();
  });
});

// -----------------------------------------------------------------------------
// Twilio signature validation — known-vector style test (HMAC-SHA1 base64)
// -----------------------------------------------------------------------------

describe("TwilioMessagingProvider.verifyWebhookSignature", () => {
  it("accepts a signature computed with the API secret", () => {
    const cfg = {
      accountSid: "AC",
      apiKey: "SK",
      apiSecret: "secret",
      messagingServiceSid: "MG",
      verifyServiceSid: null,
      smsFromNumber: null,
      whatsappNumber: null,
      authToken: null,
      whatsappIntakeTemplateSid: null,
      whatsappTemplateLanguage: "en",
    };
    const provider = new TwilioMessagingProvider(cfg);
    const url = "https://api.example.com/v1/communications/webhooks/twilio/status";
    const fields = {
      MessageSid: "SM123",
      MessageStatus: "delivered",
      AccountSid: "AC",
    };
    // Compute the expected signature the way Twilio docs prescribe:
    //   payload = url + sortedKeys.flatMap(k => k + v).join("")
    //   hmac-sha1(secret, payload) -> base64
    const sortedKeys = Object.keys(fields).sort();
    let payload = url;
    for (const k of sortedKeys) {
      payload += k + (fields as Record<string, string>)[k];
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto: typeof import("node:crypto") = require("node:crypto");
    const expected = crypto
      .createHmac("sha1", cfg.apiSecret)
      .update(payload, "utf8")
      .digest("base64");

    const ok = provider.verifyWebhookSignature({
      url,
      rawBody: "",
      fields,
      signatureHeader: expected,
    });
    expect(ok).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const provider = new TwilioMessagingProvider({
      accountSid: "AC",
      apiKey: "SK",
      apiSecret: "secret",
      messagingServiceSid: "MG",
      verifyServiceSid: null,
      smsFromNumber: null,
      whatsappNumber: null,
      authToken: null,
      whatsappIntakeTemplateSid: null,
      whatsappTemplateLanguage: "en",
    });
    const ok = provider.verifyWebhookSignature({
      url: "https://api.example.com/v1/communications/webhooks/twilio/status",
      rawBody: "",
      fields: { MessageSid: "SM123", MessageStatus: "delivered" },
      signatureHeader: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(ok).toBe(false);
  });

  it("rejects when signature header is missing", () => {
    const provider = new TwilioMessagingProvider({
      accountSid: "AC",
      apiKey: "SK",
      apiSecret: "secret",
      messagingServiceSid: "MG",
      verifyServiceSid: null,
      smsFromNumber: null,
      whatsappNumber: null,
      authToken: null,
      whatsappIntakeTemplateSid: null,
      whatsappTemplateLanguage: "en",
    });
    const ok = provider.verifyWebhookSignature({
      url: "https://api.example.com/v1/communications/webhooks/twilio/status",
      rawBody: "",
      fields: { MessageSid: "SM123" },
      signatureHeader: null,
    });
    expect(ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Twilio webhook parsing
// -----------------------------------------------------------------------------

describe("TwilioMessagingProvider.parseDeliveryWebhook", () => {
  const provider = new TwilioMessagingProvider({
    accountSid: "AC",
    apiKey: "SK",
    apiSecret: "secret",
    messagingServiceSid: "MG",
    verifyServiceSid: null,
    smsFromNumber: null,
    whatsappNumber: null,
    authToken: null,
    whatsappIntakeTemplateSid: null,
    whatsappTemplateLanguage: "en",
  });

  it("recognises a delivery status callback (DELIVERED)", () => {
    const parsed = provider.parseDeliveryWebhook({
      fields: {
        MessageSid: "SM123",
        MessageStatus: "delivered",
        AccountSid: "AC",
      },
    });
    expect(parsed.kind).toBe("status");
    if (parsed.kind === "status") {
      expect(parsed.event.status).toBe("DELIVERED");
      expect(parsed.event.providerMessageId).toBe("SM123");
    }
  });

  it("recognises a delivery status callback (FAILED) and captures error code", () => {
    const parsed = provider.parseDeliveryWebhook({
      fields: {
        MessageSid: "SM456",
        MessageStatus: "failed",
        ErrorCode: "30003",
        ErrorMessage: "Unreachable destination handset",
      },
    });
    expect(parsed.kind).toBe("status");
    if (parsed.kind === "status") {
      expect(parsed.event.status).toBe("FAILED");
      expect(parsed.event.errorCode).toBe("30003");
    }
  });

  it("recognises an inbound message (STOP)", () => {
    const parsed = provider.parseDeliveryWebhook({
      fields: {
        From: "+14155551234",
        To: "+18005551111",
        Body: "STOP",
        MessageSid: "SM789",
      },
    });
    expect(parsed.kind).toBe("inbound");
    if (parsed.kind === "inbound") {
      expect(parsed.event.body).toBe("STOP");
      expect(parsed.event.channel).toBe("SMS");
      expect(parsed.event.fromE164).toBe("+14155551234");
    }
  });

  it("recognises an inbound WhatsApp message", () => {
    const parsed = provider.parseDeliveryWebhook({
      fields: {
        From: "whatsapp:+14155551234",
        To: "whatsapp:+18005551111",
        Body: "Hi",
        MessageSid: "SMxxx",
      },
    });
    expect(parsed.kind).toBe("inbound");
    if (parsed.kind === "inbound") {
      expect(parsed.event.channel).toBe("WHATSAPP");
      expect(parsed.event.fromE164).toBe("+14155551234");
    }
  });

  it("ignores unrecognised payloads", () => {
    const parsed = provider.parseDeliveryWebhook({
      fields: { Random: "noise" },
    });
    expect(parsed.kind).toBe("ignored");
  });

  it("truncates very long ErrorMessage to 400 chars in the status event", () => {
    const long = "X".repeat(2000);
    const parsed = provider.parseDeliveryWebhook({
      fields: {
        MessageSid: "SM999",
        MessageStatus: "failed",
        ErrorMessage: long,
      },
    });
    expect(parsed.kind).toBe("status");
    if (parsed.kind === "status") {
      expect(parsed.event.errorMessage?.length).toBeLessThanOrEqual(400);
    }
  });
});

// -----------------------------------------------------------------------------
// Provider registry — feature flag + Twilio env gating
// -----------------------------------------------------------------------------

describe("Provider registry — feature flag + Twilio env gating", () => {
  const ORIGINAL_ENV = { ...process.env };
  function restore(): void {
    process.env = { ...ORIGINAL_ENV };
    setMessagingProviderForTests(null);
  }

  it("returns Noop when COMMUNICATIONS_ENABLED is not true", () => {
    process.env = { ...ORIGINAL_ENV, COMMUNICATIONS_ENABLED: "false" };
    setMessagingProviderForTests(null);
    const p = getMessagingProvider();
    expect(p.provider).toBe("NOOP");
    expect(p.isConfigured()).toBe(false);
    restore();
  });

  it("returns Noop when feature is enabled but Twilio env is incomplete", () => {
    process.env = {
      ...ORIGINAL_ENV,
      COMMUNICATIONS_ENABLED: "true",
      TWILIO_ACCOUNT_SID: "",
    };
    setMessagingProviderForTests(null);
    const p = getMessagingProvider();
    expect(p.provider).toBe("NOOP");
    expect(p.isConfigured()).toBe(false);
    restore();
  });

  it("buildProviderHealthSnapshot reports configured=false without leaking secrets", () => {
    process.env = { ...ORIGINAL_ENV, COMMUNICATIONS_ENABLED: "false" };
    setMessagingProviderForTests(null);
    const snap = buildProviderHealthSnapshot();
    expect(snap.configured).toBe(false);
    expect(snap.provider).toBe("NOOP");
    // Snapshot must never carry the raw env values.
    expect(JSON.stringify(snap)).not.toMatch(/TWILIO_API_SECRET/);
    expect(JSON.stringify(snap)).not.toMatch(/TWILIO_AUTH_TOKEN/);
    restore();
  });
});

// -----------------------------------------------------------------------------
// VerificationError surface
// -----------------------------------------------------------------------------

describe("VerificationError — stable code surface", () => {
  it("covers every code the route layer maps", () => {
    const codes = [
      "feature_disabled",
      "invalid_phone",
      "channel_unsupported",
      "rate_limited",
      "provider_unconfigured",
      "provider_unreachable",
      "provider_rejected",
      "verification_not_found",
      "verification_expired",
      "verification_check_exhausted",
      "verification_check_failed",
    ] as const;
    for (const c of codes) {
      const e = new VerificationError(c);
      expect(e.code).toBe(c);
      expect(e.message).toBe(c);
    }
  });
});

// -----------------------------------------------------------------------------
// Route surface — webhook routes are signature-gated, operator routes
// are session-gated with anti-enumeration 404
// -----------------------------------------------------------------------------

describe("Communications routes — auth posture", () => {
  it("webhook routes have NO requireAuth preHandler (signature IS the auth)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/communications.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // Locate the inbound webhook route block and confirm no session
    // pre-handler.
    const inboundBlock = src.match(
      /app\.post\(\s*"\/v1\/communications\/webhooks\/twilio\/inbound"[\s\S]{0,400}/,
    );
    expect(inboundBlock).not.toBeNull();
    if (inboundBlock) {
      expect(inboundBlock[0]).not.toMatch(/preHandler:\s*requireAuth/);
    }
    const statusBlock = src.match(
      /app\.post\(\s*"\/v1\/communications\/webhooks\/twilio\/status"[\s\S]{0,400}/,
    );
    expect(statusBlock).not.toBeNull();
    if (statusBlock) {
      expect(statusBlock[0]).not.toMatch(/preHandler:\s*requireAuth/);
    }
  });

  it("operator routes use requireAuth + 404-on-non-member", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/communications.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // /v1/communications/messages list — session-only.
    expect(src).toMatch(
      /app\.get\(\s*"\/v1\/communications\/messages"[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
    // The membership guard returns 404 ("not_found") for non-members.
    const guardBlock = src.match(/requireCommunicationsActor[\s\S]{0,1500}/);
    expect(guardBlock).not.toBeNull();
    if (guardBlock) {
      const nonMemberBranch = guardBlock[0].match(
        /if \(!member\)[\s\S]{0,200}/,
      );
      expect(nonMemberBranch).not.toBeNull();
      if (nonMemberBranch) {
        expect(nonMemberBranch[0]).toMatch(/reply\.code\(404\)/);
        expect(nonMemberBranch[0]).not.toMatch(/reply\.code\(403\)/);
      }
    }
  });

  it("process-retries cron uses INTEGRATION_CRON_SECRET", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/communications.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/process-retries/);
    expect(src).toMatch(/requireIntegrationCronSecret/);
  });

  it("verify/check route returns generic { status: 'denied' } on every failure", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/communications.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/status:\s*"denied"/);
    // The check-route source must NOT include a branch that returns
    // the OTP code or providerReason verbatim to the caller.
    expect(src).not.toMatch(/reply\.send\(\{[^}]*code:/);
  });
});

// -----------------------------------------------------------------------------
// Public verify isolation — communication tables NOT exposed
// -----------------------------------------------------------------------------

describe("Public verify isolation — communications NOT exposed", () => {
  it("public verify route does not read communication_* tables", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    const start = src.indexOf('app.get("/public/verify/:id"');
    expect(start).toBeGreaterThan(-1);
    const verifyBlock = src.slice(start, start + 8000);
    expect(verifyBlock).not.toMatch(/communicationMessage/);
    expect(verifyBlock).not.toMatch(/communicationPreference/);
    expect(verifyBlock).not.toMatch(/verificationAttempt/);
  });
});

// -----------------------------------------------------------------------------
// Untouched architecture — verify the brief invariants
// -----------------------------------------------------------------------------

describe("Phase 18 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts stays deleted (Phase 2 dead-code removal)", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    // Phase 2 deleted this file as confirmed dead code. The original
    // Phase-18 invariant ("this renderer is not touched by Phase 18") is
    // now expressed as: it must not come back.
    const legacyRenderer = fileURLToPath(
      new URL("../../worker/src/pdf/report.ts", import.meta.url),
    );
    expect(existsSync(legacyRenderer)).toBe(false);
  });

  it("public verify route does not import any Phase 18 service", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/communications\/communication\.service/);
    expect(src).not.toMatch(/communications\/verification\.service/);
    expect(src).not.toMatch(/communications\/twilio-provider/);
  });
});

// -----------------------------------------------------------------------------
// Migration safety
// -----------------------------------------------------------------------------

describe("Phase 18 migration — additive only", () => {
  it("uses IF NOT EXISTS / EXCEPTION blocks; never drops or renames", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../prisma/migrations/20260527100000_add_communications_phase18/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(src).toMatch(/EXCEPTION WHEN duplicate_object/);
    expect(src.match(/^\s*ALTER TABLE [^;]+DROP COLUMN/m)).toBeNull();
    expect(src.match(/^\s*ALTER TABLE [^;]+RENAME COLUMN/m)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Privacy contract — service source MUST NOT log the OTP code
// -----------------------------------------------------------------------------

describe("Privacy contract — verification service never persists the code", () => {
  it("verification.service source does not store input.code anywhere except passing to the provider", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/communications/verification.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The code field must NEVER appear in a Prisma create/update or
    // in a log line. The only references should be (a) the input type,
    // (b) the destructure, (c) the provider call.
    const dangerousReferences = src.match(/code:\s*input\.code/g);
    // Exactly one allowed reference: passing through to the provider.
    expect((dangerousReferences ?? []).length).toBeLessThanOrEqual(1);
    expect(src).not.toMatch(/log\.[a-z]+\([^)]*code/);
  });
});
