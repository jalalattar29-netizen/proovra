/**
 * PROOVRA Platform Admin — Platform Health & Service Status contract suite.
 *
 * Style: source-contract (matches phase-admin-security + phase-admin-billing
 * + the admin-route convention). Pins the guarantees the platform-health
 * aggregate + route MUST hold:
 *   1. requirePlatformAdmin gates the endpoint (non-platform-admin denied).
 *   2. It is READ-ONLY — no writes.
 *   3. It CONNECTS existing health services (does not re-implement them).
 *   4. Providers with NO live probe (OpenAI, Twilio, Resend, live Stripe /
 *      PayPal, live TSA / OTS) render `unknown` / `not_connected` — NEVER
 *      a fabricated `healthy`.
 *   5. NO secret-looking fields are selected or returned; uptime is never
 *      fabricated.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTE = readSource("../src/routes/admin-platform-health.routes.ts");
const SERVICE = readSource("../src/services/admin/platform-health.service.ts");

describe("platform-health route — requirePlatformAdmin gate + read-only", () => {
  it("imports and applies requirePlatformAdmin", () => {
    expect(ROUTE).toContain(
      'import { requirePlatformAdmin } from "../middleware/require-platform-admin.js"',
    );
    expect(ROUTE).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });

  it("exposes the platform-health endpoint", () => {
    expect(ROUTE).toContain('"/v1/admin/platform-health"');
  });

  it("carries the platform-admin-global tenant-scope exception comment", () => {
    expect(ROUTE).toContain(
      "// TENANT_SCOPE_EXCEPTION: platform_admin_global",
    );
  });

  it("exports adminPlatformHealthRoutes as an async function", () => {
    expect(ROUTE).toMatch(
      /export async function adminPlatformHealthRoutes\(\s*app:\s*FastifyInstance\s*\)/,
    );
  });

  it("is READ-ONLY — the route + service declare no writes", () => {
    for (const src of [ROUTE, SERVICE]) {
      expect(src).not.toMatch(
        /prisma\.\w+\.(create|update|delete|upsert|updateMany|deleteMany|createMany)\b/,
      );
    }
  });
});

describe("platform-health service — CONNECTS existing health services", () => {
  it("reuses runtime-readiness, signer, queue-inventory, observability, posture", () => {
    expect(SERVICE).toContain("runReadinessCheck");
    expect(SERVICE).toContain("probeSignerHealth");
    expect(SERVICE).toContain("getQueueInventory");
    expect(SERVICE).toContain("buildObservabilityHealth");
    expect(SERVICE).toContain("computeReadinessPosture");
  });

  it("connects the live redaction provider probes (Azure / Deepgram / Rekognition)", () => {
    expect(SERVICE).toContain("probeAzureDocumentIntelligence");
    expect(SERVICE).toContain("probeDeepgram");
    expect(SERVICE).toContain("probeRekognition");
  });

  it("derives webhook health from real processingStatus rows", () => {
    expect(SERVICE).toContain("stripeWebhookEvent.groupBy");
    expect(SERVICE).toContain("paypalWebhookEvent.groupBy");
    expect(SERVICE).toMatch(/by:\s*\[\s*"processingStatus"\s*\]/);
  });

  it("builds the live Now panel from real operational tables", () => {
    expect(SERVICE).toContain("authenticatedSession.count");
    expect(SERVICE).toContain("uploadSession.count");
    expect(SERVICE).toContain("operationalIncident.count");
    expect(SERVICE).toContain("analyticsEvent.count");
    expect(SERVICE).toContain("adminAuditLog.count");
    expect(SERVICE).toContain('eventType: "login_completed"');
  });
});

describe("platform-health service — HONEST provider statuses", () => {
  it("declares the not_connected / unknown honest statuses in the vocabulary", () => {
    expect(SERVICE).toContain('"not_connected"');
    expect(SERVICE).toContain('"unknown"');
  });

  it("providers WITHOUT a live probe are unknown — never fabricated healthy", () => {
    // The NOT_PROBED_PROVIDERS block enumerates the un-probeable providers and
    // pushes them with status "unknown". None of them may be pushed healthy.
    expect(SERVICE).toContain("NOT_PROBED_PROVIDERS");
    for (const key of [
      '"openai"',
      '"twilio"',
      '"resend"',
      '"stripe_api"',
      '"paypal_api"',
    ]) {
      expect(SERVICE).toContain(key);
    }
    // The un-probed block force-sets status: "unknown".
    expect(SERVICE).toMatch(
      /for \(const p of NOT_PROBED_PROVIDERS\)[\s\S]*?status:\s*"unknown"/,
    );
  });

  it("live TSA and OTS have no live probe → unknown (not healthy)", () => {
    expect(SERVICE).toMatch(/key:\s*"tsa"[\s\S]*?status:\s*"unknown"/);
    expect(SERVICE).toMatch(/key:\s*"ots"[\s\S]*?status:\s*"unknown"/);
  });

  it("zero webhook rows map to not_connected, never a fabricated healthy", () => {
    expect(SERVICE).toMatch(/total\s*===\s*0\s*\?\s*"not_connected"/);
  });
});

describe("platform-health service — NO secrets + no fabricated uptime", () => {
  it("never selects or returns secret-looking fields", () => {
    for (const forbidden of [
      /secretCiphertext/,
      /connectionString/i,
      /DATABASE_URL/,
      /apiKey\s*:/i,
      /accessKey/i,
      /\btoken\s*:/i,
      /privateKey/i,
    ]) {
      expect(SERVICE).not.toMatch(forbidden);
    }
  });

  it("never fabricates an uptime field / percentage", () => {
    expect(SERVICE).not.toMatch(/uptime/i);
    expect(SERVICE).not.toMatch(/99\.9/);
  });
});
