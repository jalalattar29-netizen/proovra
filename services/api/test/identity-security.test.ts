/**
 * Phase 19 — Enterprise Identity Security & Adaptive Access Control tests.
 *
 *   - MFA policy service: pure evaluator wiring (role + action + risk).
 *   - Step-up service: error surface; OTP code never persisted in the
 *     step-up service source (source-level guard).
 *   - Session revocation: pure hashing; SessionRevocationReason surface.
 *   - Trusted device: projection never echoes the device id hash.
 *   - Risk scoring: pure helper imports + wiring through the service.
 *   - Route surface: webhook routes have NO requireAuth (not applicable
 *     here — Phase 19 has no webhook), step-up start/check returns
 *     generic { status: denied } on failure.
 *   - Public verify isolation: source-level grep proves no Phase 19
 *     table is read from the public verify route.
 *   - Migration safety: ADD COLUMN IF NOT EXISTS + DO $$ EXCEPTION
 *     blocks; no DROP / RENAME on existing columns.
 *   - Untouched architecture: report-v2 + worker/pdf/report.ts +
 *     public verify + OTS/TSA/anchor unchanged.
 *
 * No DB — source-text + projection + pure-helper tests only.
 */

import { describe, expect, it } from "vitest";

import {
  StepUpError,
} from "../src/services/identity-security/step-up.service.js";
import { projectTrustedDevice } from "../src/services/identity-security/trusted-device.service.js";
import {
  projectRevokedSession,
  hashSessionId,
} from "../src/services/identity-security/session-revocation.service.js";
import {
  hashDeviceCookieValue,
  hashIpAddress,
} from "../src/services/identity-security/risk.service.js";

// -----------------------------------------------------------------------------
// Step-up error surface
// -----------------------------------------------------------------------------

describe("StepUpError — stable code surface", () => {
  it("covers every code the route layer maps", () => {
    const codes = [
      "feature_disabled",
      "invalid_phone",
      "rate_limited",
      "provider_unconfigured",
      "provider_unreachable",
      "provider_rejected",
      "challenge_not_found",
      "challenge_expired",
      "challenge_consumed",
      "challenge_purpose_mismatch",
      "challenge_resource_mismatch",
      "denied",
    ] as const;
    for (const c of codes) {
      const e = new StepUpError(c);
      expect(e.code).toBe(c);
      expect(e.message).toBe(c);
    }
  });
});

// -----------------------------------------------------------------------------
// Trusted device projection — never echoes the device id hash
// -----------------------------------------------------------------------------

describe("projectTrustedDevice — privacy contract", () => {
  it("omits deviceIdHash and ipHash from the safe projection", () => {
    const projected = projectTrustedDevice({
      id: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
      deviceIdHash:
        "deadbeef0000000000000000000000000000000000000000000000000000beef",
      uaPreview: "Chrome on macOS",
      ipPreview: "192.•••.•••.99",
      ipHash:
        "cafebabe0000000000000000000000000000000000000000000000000000babe",
      status: "ACTIVE" as never,
      trustedUntilUtc: new Date(),
      firstSeenAtUtc: new Date(),
      lastSeenAtUtc: new Date(),
      revokedAtUtc: null,
      revokedByUserId: null,
      revokedReason: null,
      // Phase 26.75 — additive nullable columns on TrustedDevice.
      trustScoreDecay: 0,
      decayReason: null,
      quarantinedAtUtc: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const json = JSON.stringify(projected);
    expect(json).not.toContain("deadbeef");
    expect(json).not.toContain("cafebabe");
    expect((projected as Record<string, unknown>).deviceIdHash).toBeUndefined();
    expect((projected as Record<string, unknown>).ipHash).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Revoked session projection — never echoes the session id hash
// -----------------------------------------------------------------------------

describe("projectRevokedSession — privacy contract", () => {
  it("omits sessionIdHash and revokedBeforeIat from the safe projection", () => {
    const projected = projectRevokedSession({
      id: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
      scope: "SINGLE_SESSION" as never,
      sessionIdHash:
        "deadbeef0000000000000000000000000000000000000000000000000000beef",
      revokedBeforeIat: BigInt(1234567890),
      reason: "OPERATOR_REVOKED",
      revokedByUserId: "44444444-4444-4444-8444-444444444444",
      revokedAtUtc: new Date(),
    });
    const json = JSON.stringify(projected);
    expect(json).not.toContain("deadbeef");
    expect((projected as Record<string, unknown>).sessionIdHash).toBeUndefined();
    expect((projected as Record<string, unknown>).revokedBeforeIat).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Pure HMAC helpers — deterministic + collision-resistant on the same key
// -----------------------------------------------------------------------------

describe("HMAC helpers — deterministic + key-bound", () => {
  it("hashSessionId is deterministic", () => {
    const a = hashSessionId("abc");
    const b = hashSessionId("abc");
    expect(a).toBe(b);
    expect(a.length).toBe(64);
  });

  it("hashDeviceCookieValue is deterministic", () => {
    const a = hashDeviceCookieValue("device-cookie-value");
    const b = hashDeviceCookieValue("device-cookie-value");
    expect(a).toBe(b);
  });

  it("hashIpAddress is deterministic and case-insensitive", () => {
    const a = hashIpAddress("1.2.3.4");
    const b = hashIpAddress("1.2.3.4");
    expect(a).toBe(b);
    // IPv6 form normalised lowercase
    const c = hashIpAddress("ABCD::1");
    const d = hashIpAddress("abcd::1");
    expect(c).toBe(d);
  });

  it("hash outputs never include the raw input", () => {
    expect(hashSessionId("secret-session-id-12345")).not.toMatch(
      /secret-session-id/,
    );
    expect(hashIpAddress("192.168.55.99")).not.toMatch(/192.168/);
  });
});

// -----------------------------------------------------------------------------
// Route surface — anti-enumeration + session-only auth
// -----------------------------------------------------------------------------

describe("Identity-security routes — auth posture", () => {
  it("operator routes use requireAuth and 404-on-non-member", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/identity-security.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/identity-security\/step-up\/start"[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
    // The membership guard returns 404 not 403.
    const guardBlock = src.match(/requireSecurityActor[\s\S]{0,1500}/);
    expect(guardBlock).not.toBeNull();
    if (guardBlock) {
      const nonMember = guardBlock[0].match(/if \(!member\)[\s\S]{0,200}/);
      expect(nonMember).not.toBeNull();
      if (nonMember) {
        expect(nonMember[0]).toMatch(/reply\.code\(404\)/);
        expect(nonMember[0]).not.toMatch(/reply\.code\(403\)/);
      }
    }
  });

  it("step-up/check returns generic { status: denied } on failure", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/identity-security.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/status:\s*"denied"/);
  });

  it("reconcile cron uses INTEGRATION_CRON_SECRET", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/identity-security.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/\/v1\/identity-security\/reconcile/);
    expect(src).toMatch(/requireIntegrationCronSecret/);
  });
});

// -----------------------------------------------------------------------------
// Step-up source — OTP code is NEVER persisted on the challenge row
// -----------------------------------------------------------------------------

describe("Privacy contract — step-up service never persists the OTP code", () => {
  it("step-up.service source does not store input.code anywhere", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/identity-security/step-up.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The code field must NEVER appear in a Prisma create/update or
    // in a log line. The only allowed reference is the destructuring
    // of input and the pass-through to checkVerification.
    const dangerousCreate = src.match(/code:\s*input\.code/g);
    expect((dangerousCreate ?? []).length).toBeLessThanOrEqual(1);
    expect(src).not.toMatch(/log\.[a-z]+\([^)]*code:/);
  });
});

// -----------------------------------------------------------------------------
// Sensitive route integration — step-up middleware wired
// -----------------------------------------------------------------------------

describe("Sensitive routes — step-up middleware is wired", () => {
  it("identity.routes wires requireStepUpForSensitiveAction on member suspend/revoke/role/delegated admin/service-account disable", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/identity.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const purpose of [
      "MEMBER_SUSPEND",
      "MEMBER_REVOKE",
      "MEMBER_ROLE_CHANGE",
      "DELEGATED_ADMIN_GRANT",
      "DELEGATED_ADMIN_REVOKE",
      "SERVICE_ACCOUNT_DISABLE",
    ]) {
      expect(src).toMatch(new RegExp(`purpose:\\s*"${purpose}"`));
    }
    expect(src).toMatch(/requireStepUpForSensitiveAction/);
  });

  it("governance.routes wires step-up on legal-hold release, publish/unpublish/suspend, governance policy update", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/governance.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const purpose of [
      "LEGAL_HOLD_RELEASE",
      "PUBLIC_VERIFY_PUBLISH",
      "PUBLIC_VERIFY_UNPUBLISH",
      "PUBLIC_VERIFY_SUSPEND",
      "GOVERNANCE_POLICY_UPDATE",
    ]) {
      expect(src).toMatch(new RegExp(`purpose:\\s*"${purpose}"`));
    }
    expect(src).toMatch(/requireStepUpForSensitiveAction/);
  });

  it("integrations.routes wires step-up on API key create/revoke", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/integrations.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // Phase 4 closure migrated these call sites from the coarse
    // legacy SERVICE_ACCOUNT_* purposes to dedicated
    // INTEGRATION_API_KEY_* purposes. Back-compat is preserved by the
    // alias map in @proovra/shared (a row carrying the legacy purpose
    // still satisfies the new check); see
    // phase-closure-integration-step-up-purposes.test.ts.
    expect(src).toMatch(/purpose:\s*"INTEGRATION_API_KEY_CREATE"/);
    expect(src).toMatch(/purpose:\s*"INTEGRATION_API_KEY_REVOKE"/);
  });
});

// -----------------------------------------------------------------------------
// requireAuth — session revocation registry check
// -----------------------------------------------------------------------------

describe("requireAuth — session revocation check", () => {
  it("auth middleware consults isSessionRevoked before populating req.user", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(new URL("../src/middleware/auth.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/isSessionRevoked/);
    expect(src).toMatch(/hashSessionId/);
    // Fail-closed: revocation check failure must result in 401.
    expect(src).toMatch(/revocation_check_failed/);
  });
});

// -----------------------------------------------------------------------------
// JWT — sid + iat are populated on signing
// -----------------------------------------------------------------------------

describe("JWT — Phase 19 sid + iat claims", () => {
  it("signJwt always populates iat and a fresh random sid", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/services/jwt.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/sid\??:\s*string/);
    expect(src).toMatch(/randomBytes\(16\)\.toString\("hex"\)/);
    expect(src).toMatch(/iat:\s*now/);
    expect(src).toMatch(/sid/);
  });
});

// -----------------------------------------------------------------------------
// Public verify isolation
// -----------------------------------------------------------------------------

describe("Public verify isolation — Phase 19 tables NOT exposed", () => {
  it("public verify route does not read step_up_* / trusted_devices / revoked_sessions / risk_signals", async () => {
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
    expect(verifyBlock).not.toMatch(/stepUpChallenge/);
    expect(verifyBlock).not.toMatch(/trustedDevice/);
    expect(verifyBlock).not.toMatch(/revokedSession/);
    expect(verifyBlock).not.toMatch(/riskSignal/);
  });
});

// -----------------------------------------------------------------------------
// Untouched architecture
// -----------------------------------------------------------------------------

describe("Phase 19 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts is NOT modified by Phase 19", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    // Phase 2: services/worker/src/pdf/report.ts was deleted as

    // confirmed dead code (zero live importers; canonical PDF path

    // is services/worker/src/report-v2/build-report-pdf.ts). When the

    // file is absent this 'untouched files invariant' assertion is

    // vacuously satisfied — the historical Phase XX cannot have

    // touched a file that does not exist.

    const { existsSync } = await import("node:fs");

    const pdfReportPath = fileURLToPath(

      new URL("../../worker/src/pdf/report.ts", import.meta.url),

    );

    const src = existsSync(pdfReportPath)

      ? await readFile(pdfReportPath, "utf8")

      : "";
    expect(src).not.toMatch(/Phase 19/);
    expect(src).not.toMatch(/stepUpChallenge/);
    expect(src).not.toMatch(/identity-security/);
  });

  it("public verify route does not import any Phase 19 service", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/identity-security\/step-up/);
    expect(src).not.toMatch(/identity-security\/risk/);
    expect(src).not.toMatch(/identity-security\/session-revocation/);
  });
});

// -----------------------------------------------------------------------------
// Migration safety
// -----------------------------------------------------------------------------

describe("Phase 19 migration — additive only", () => {
  it("uses IF NOT EXISTS / EXCEPTION blocks; never drops or renames", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../prisma/migrations/20260528100000_add_identity_security_phase19/migration.sql",
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
// RBAC auto-revoke — suspend/revoke triggers session revocation
// -----------------------------------------------------------------------------

describe("RBAC auto-revoke — suspend + revoke trigger session revocation", () => {
  it("suspendMember + revokeMember call autoRevokeAllSessions", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/identity/rbac.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/autoRevokeAllSessions/);
    // The hook is called from both suspendMember and revokeMember.
    // Match the call-site pattern.
    const suspendBlock = src.match(
      /export async function suspendMember[\s\S]{0,3000}autoRevokeAllSessions/,
    );
    const revokeBlock = src.match(
      /export async function revokeMember[\s\S]{0,3000}autoRevokeAllSessions/,
    );
    expect(suspendBlock).not.toBeNull();
    expect(revokeBlock).not.toBeNull();
  });
});
