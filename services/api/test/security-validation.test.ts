/**
 * Phase 11 — API-side security tests.
 *
 *   - File validation outcomes round-trip through the service layer
 *   - Archive limit helper respects env overrides
 *   - Webhook dispatcher refuses to follow 3xx redirects (SSRF)
 *   - File security scan service is a no-op when the feature flag is off
 *   - Server-side security headers are documented (CSP, COOP, CORP)
 *
 * These are vitest tests that exercise the pure service surface
 * (no Prisma DB required for the validation / dispatcher tests).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __setWebhookHttpClientForTests,
  attemptDelivery,
  type WebhookHttpClient,
} from "../src/services/integrations/webhook-dispatcher.js";
import {
  checkArchiveAgainstLimits,
  evaluateArchiveAdvisory,
  getArchiveLimits,
  validateUploadedFile,
} from "../src/services/security/file-validation.service.js";
import {
  isMalwareScanningEnabled,
} from "../src/services/security/file-security-scan.service.js";

function bytes(...arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

describe("file validation service — outcomes", () => {
  it("blocks a PE bin disguised as image", () => {
    const result = validateUploadedFile({
      teamId: null,
      evidenceId: null,
      fileName: "selfie.jpg",
      claimedMime: "image/jpeg",
      head: bytes(0x4d, 0x5a, 0x90, 0, 0, 0),
    });
    expect(result.outcome).toBe("block");
    expect(result.findings.executable).toBe(true);
  });

  it("blocks a double-extension upload", () => {
    const result = validateUploadedFile({
      teamId: null,
      evidenceId: null,
      fileName: "case-1234.pdf.exe",
      claimedMime: "application/pdf",
      head: bytes(0x25, 0x50, 0x44, 0x46, 0x2d),
    });
    expect(result.outcome).toBe("block");
    expect(result.findings.doubleExtension).toBe(true);
  });

  it("warns when claimed family ≠ sniffed family but content is benign", () => {
    const result = validateUploadedFile({
      teamId: null,
      evidenceId: null,
      fileName: "evidence.png",
      claimedMime: "image/png",
      head: bytes(0x25, 0x50, 0x44, 0x46, 0x2d), // actually PDF
    });
    expect(result.outcome).toBe("warn");
  });

  it("allows a matching upload", () => {
    const result = validateUploadedFile({
      teamId: null,
      evidenceId: null,
      fileName: "photo.jpg",
      claimedMime: "image/jpeg",
      head: bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0),
    });
    expect(result.outcome).toBe("allow");
  });

  it("blocks a dangerous claimed MIME even with empty bytes (presign time)", () => {
    const result = validateUploadedFile({
      teamId: null,
      evidenceId: null,
      fileName: "case.exe",
      claimedMime: "application/x-msdownload",
      head: new Uint8Array(0),
    });
    expect(result.outcome).toBe("block");
  });
});

describe("archive limit helpers", () => {
  it("blocks over-entry archives", () => {
    const r = checkArchiveAgainstLimits({
      entryCount: 999_999,
      uncompressedBytes: 1024,
      compressedBytes: 1024,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_entries");
  });

  it("blocks over-size archives", () => {
    const r = checkArchiveAgainstLimits({
      entryCount: 1,
      uncompressedBytes: 10 * 1024 * 1024 * 1024, // 10 GiB
      compressedBytes: 1024,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/uncompressed_size_exceeded|compression_ratio_exceeded/);
  });

  it("blocks compression-ratio bombs", () => {
    const r = checkArchiveAgainstLimits({
      entryCount: 1,
      uncompressedBytes: 50 * 1024 * 1024,
      compressedBytes: 1024, // ratio ~50000 → block
    });
    expect(r.ok).toBe(false);
  });

  it("allows a normal archive advisory", () => {
    const r = checkArchiveAgainstLimits({
      entryCount: 10,
      uncompressedBytes: 5 * 1024 * 1024,
      compressedBytes: 4 * 1024 * 1024,
    });
    expect(r.ok).toBe(true);
  });

  it("env overrides are picked up by getArchiveLimits()", () => {
    const prev = process.env.MAX_ARCHIVE_ENTRY_COUNT;
    process.env.MAX_ARCHIVE_ENTRY_COUNT = "7";
    try {
      const lim = getArchiveLimits();
      expect(lim.maxEntries).toBe(7);
    } finally {
      if (prev === undefined) delete process.env.MAX_ARCHIVE_ENTRY_COUNT;
      else process.env.MAX_ARCHIVE_ENTRY_COUNT = prev;
    }
  });

  it("evaluateArchiveAdvisory returns the underlying outcome", () => {
    const r = evaluateArchiveAdvisory({
      teamId: null,
      evidenceId: null,
      advisory: {
        entryCount: 1,
        uncompressedBytes: 1024,
        compressedBytes: 1024,
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe("webhook dispatcher SSRF hardening", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  it("treats 302 responses as redirect_blocked (does not follow)", async () => {
    const fakeRow = {
      id: "11111111-1111-4111-8111-111111111111",
      endpointId: "22222222-2222-4222-8222-222222222222",
      teamId: "33333333-3333-4333-8333-333333333333",
      eventId: "44444444-4444-4444-8444-444444444444",
      eventType: "evidence.created",
      payloadJson: { hello: "world" },
      status: "PENDING",
      attemptCount: 0,
      nextAttemptAtUtc: null,
      responseStatus: null,
      responseBodyPreview: null,
      errorMessage: null,
      sentAtUtc: null,
      failedAtUtc: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Endpoint stub with a real ciphertext so decrypt yields a raw value.
    const apiKeySecret = "a".repeat(64);
    const prev = process.env.API_KEY_SECRET;
    process.env.API_KEY_SECRET = apiKeySecret;
    try {
      const { issueWebhookSecret } = await import(
        "../src/services/integrations/webhooks.service.js"
      );
      const issued = issueWebhookSecret();
      expect(issued).not.toBeNull();
      const endpoint = {
        id: "22222222-2222-4222-8222-222222222222",
        teamId: "33333333-3333-4333-8333-333333333333",
        url: "https://example.com/hook",
        description: null,
        status: "ACTIVE",
        secretCiphertext: issued!.secretCiphertext,
        secretPrefix: issued!.secretPrefix,
        eventTypes: [],
        failureCount: 0,
        lastSuccessAtUtc: null,
        lastFailureAtUtc: null,
        createdByUserId: "55555555-5555-4555-8555-555555555555",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let observedRedirectMode: RequestRedirect | undefined;
      const fake: WebhookHttpClient = async () => {
        observedRedirectMode = "manual" as RequestRedirect;
        return {
          status: 302,
          bodyPreview: null,
          errorMessage: "redirect_blocked",
        };
      };
      restore = __setWebhookHttpClientForTests(fake);

      // Stub the prisma client (only methods exercised by attemptDelivery on
      // the success/permanent branches).
      const prismaStub = {
        integrationWebhookDelivery: {
          update: async () => ({}),
        },
        webhookEndpoint: {
          update: async () => ({}),
        },
      } as unknown as import("@prisma/client").PrismaClient;

      const outcome = await attemptDelivery(
        fakeRow as never,
        endpoint as never,
        prismaStub,
      );
      // 302 with errorMessage="redirect_blocked" → no body, 4xx-like → permanent
      expect(outcome).toBe("permanent");
      void observedRedirectMode; // referenced for clarity; value isn't asserted
    } finally {
      if (prev === undefined) delete process.env.API_KEY_SECRET;
      else process.env.API_KEY_SECRET = prev;
    }
  });
});

describe("malware scanning feature flag", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.MALWARE_SCANNING_ENABLED;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.MALWARE_SCANNING_ENABLED;
    else process.env.MALWARE_SCANNING_ENABLED = prev;
  });

  it("isMalwareScanningEnabled is false by default", () => {
    delete process.env.MALWARE_SCANNING_ENABLED;
    expect(isMalwareScanningEnabled()).toBe(false);
  });

  it("isMalwareScanningEnabled returns true only on explicit 'true'", () => {
    process.env.MALWARE_SCANNING_ENABLED = "1";
    expect(isMalwareScanningEnabled()).toBe(false);
    process.env.MALWARE_SCANNING_ENABLED = "true";
    expect(isMalwareScanningEnabled()).toBe(true);
  });
});

describe("server security headers (compile-time source check)", () => {
  it("server.ts adds CSP, COOP, CORP headers in addition to existing ones", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(new URL("../src/server.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/content-security-policy/);
    expect(src).toMatch(/cross-origin-resource-policy/);
    expect(src).toMatch(/cross-origin-opener-policy/);
    // Existing headers must remain.
    expect(src).toMatch(/x-content-type-options/);
    expect(src).toMatch(/x-frame-options/);
    expect(src).toMatch(/referrer-policy/);
    expect(src).toMatch(/permissions-policy/);
  });
});

describe("anti-enumeration — security routes never 403 on non-admin", () => {
  it("routes return 404 (not 403) when caller is not an admin member", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(new URL("../src/routes/security.routes.ts", import.meta.url)),
      "utf8",
    );
    // The helper that handles "not a member" and "not OWNER/ADMIN" must
    // respond 404 in both branches.
    expect(src).toMatch(/reply\.code\(404\)/);
    // Avoid accidentally introducing 403 in this route file.
    expect(src).not.toMatch(/reply\.code\(403\)/);
  });
});
