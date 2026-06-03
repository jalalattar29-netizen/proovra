/**
 * PHASE R8.1.5 — Verified-email recovery preflight, admin SPA,
 * per-org fail-mode & self-cancel source-contract tests.
 *
 * 19 numbered tests from the phase spec, plus a small sentinel
 * group at the tail. These read the canonical files and assert
 * structural properties; they do NOT touch a live database.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel: string) => resolve(REPO, "services/api", rel);
const webPath = (rel: string) => resolve(REPO, "apps/web", rel);
const sharedPath = (rel: string) => resolve(REPO, "packages/shared", rel);

const RECOVERY_SVC = readFileSync(
  apiPath("src/services/security/mfa-recovery-request.service.ts"),
  "utf8",
);
const ENFORCEMENT_SVC = readFileSync(
  apiPath("src/services/security/login-mfa-enforcement.service.ts"),
  "utf8",
);
const POLICY_SVC = readFileSync(
  apiPath("src/services/identity-security/mfa-policy.service.ts"),
  "utf8",
);
const ADMIN_ROUTES = readFileSync(
  apiPath("src/routes/mfa-admin.routes.ts"),
  "utf8",
);
const SCHEMA = readFileSync(apiPath("prisma/schema.prisma"), "utf8");
const SHARED_SEC = readFileSync(sharedPath("src/security.ts"), "utf8");
const EMAIL_SVC = readFileSync(
  apiPath("src/services/email.service.ts"),
  "utf8",
);
const ADMIN_SPA = readFileSync(
  webPath("app/(app)/security-center/mfa-recovery/page.tsx"),
  "utf8",
);

// =============================================================================
// PART 1 — Recovery starts in EMAIL_VERIFICATION_PENDING
// =============================================================================

describe("R8.1.5 — verified-email recovery preflight", () => {
  // ---------------------------------------------------------------------------
  // 1. Recovery request starts as EMAIL_VERIFICATION_PENDING.
  // ---------------------------------------------------------------------------
  it("test 1: createRecoveryRequest writes status EMAIL_VERIFICATION_PENDING", () => {
    expect(RECOVERY_SVC).toMatch(
      /status:\s*["']EMAIL_VERIFICATION_PENDING["']/,
    );
    // The Prisma model's default also matches so a row inserted
    // without an explicit status lands in the email-pending state.
    expect(SCHEMA).toMatch(
      /status\s+MfaRecoveryRequestStatus\s+@default\(EMAIL_VERIFICATION_PENDING\)/,
    );
    // The status enum lists EMAIL_VERIFICATION_PENDING.
    expect(SCHEMA).toMatch(
      /enum MfaRecoveryRequestStatus\s*\{[\s\S]*?EMAIL_VERIFICATION_PENDING/,
    );
  });

  // ---------------------------------------------------------------------------
  // 2. Email token/code stored hashed.
  // ---------------------------------------------------------------------------
  it("test 2: email verification token is SHA-256 hashed before persistence (raw never stored)", () => {
    // Service computes the hash via createHash("sha256")
    // and stores `emailVerificationTokenHash` (the hash column).
    expect(RECOVERY_SVC).toMatch(/createHash\(\s*["']sha256["']\s*\)/);
    expect(RECOVERY_SVC).toMatch(/emailVerificationTokenHash:\s*hashEmailToken/);
    // The Prisma model exposes the HASH column; no raw token column.
    expect(SCHEMA).toMatch(/email_verification_token_hash.*VarChar\(64\)/);
    expect(SCHEMA).not.toMatch(
      /^\s*emailVerificationToken\s+String[^?]/m,
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Email token/code is one-time use.
  // ---------------------------------------------------------------------------
  it("test 3: successful verify clears the hash + expiry so the same token cannot be re-used", () => {
    // The atomic UPDATE on verify sets BOTH fields to null in the
    // same statement that flips status.
    const verifyBlock = RECOVERY_SVC.match(
      /export async function verifyRecoveryRequestEmail[\s\S]*?\n\}/,
    );
    expect(verifyBlock).toBeTruthy();
    expect(verifyBlock![0]).toMatch(/emailVerificationTokenHash:\s*null/);
    expect(verifyBlock![0]).toMatch(/emailVerificationExpiresAt:\s*null/);
    expect(verifyBlock![0]).toMatch(/status:\s*["']PENDING_ADMIN_REVIEW["']/);
    // The WHERE clause includes the source status — defends against
    // two concurrent verifies racing each other.
    expect(verifyBlock![0]).toMatch(
      /where:\s*\{[\s\S]*?status:\s*["']EMAIL_VERIFICATION_PENDING["']/,
    );
  });

  // ---------------------------------------------------------------------------
  // 4. Admin cannot approve before email verification.
  // ---------------------------------------------------------------------------
  it("test 4: approveRecoveryRequest refuses with `request_not_email_verified` when status is EMAIL_VERIFICATION_PENDING", () => {
    expect(RECOVERY_SVC).toMatch(
      /request_not_email_verified/,
    );
    // Branch order matters: the email-pending check happens BEFORE
    // the PENDING_ADMIN_REVIEW assertion.
    const approveBlock = RECOVERY_SVC.match(
      /export async function approveRecoveryRequest[\s\S]*?\n\}/,
    );
    expect(approveBlock).toBeTruthy();
    const emailIdx = approveBlock![0].indexOf("EMAIL_VERIFICATION_PENDING");
    const adminIdx = approveBlock![0].indexOf("PENDING_ADMIN_REVIEW");
    expect(emailIdx).toBeGreaterThan(0);
    expect(adminIdx).toBeGreaterThan(emailIdx);
  });

  // ---------------------------------------------------------------------------
  // 5. Email verification moves request to PENDING_ADMIN_REVIEW.
  // ---------------------------------------------------------------------------
  it("test 5: verify emits `mfa_recovery_email_verified` + flips status to PENDING_ADMIN_REVIEW", () => {
    expect(RECOVERY_SVC).toMatch(/eventType:\s*["']mfa_recovery_email_verified["']/);
    expect(RECOVERY_SVC).toMatch(/status:\s*["']PENDING_ADMIN_REVIEW["']/);
  });
});

// =============================================================================
// PART 2 — Self-cancel
// =============================================================================

describe("R8.1.5 — user self-cancel recovery", () => {
  // ---------------------------------------------------------------------------
  // 6. User can cancel own pending request.
  // ---------------------------------------------------------------------------
  it("test 6: cancelRecoveryRequest flips status to CANCELLED for owner from either preflight state", () => {
    const block = RECOVERY_SVC.match(
      /export async function cancelRecoveryRequest[\s\S]*?\n\}/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/status:\s*["']CANCELLED["']/);
    expect(block![0]).toMatch(/EMAIL_VERIFICATION_PENDING/);
    expect(block![0]).toMatch(/PENDING_ADMIN_REVIEW/);
    // Emits the bounded event.
    expect(RECOVERY_SVC).toMatch(/eventType:\s*["']mfa_recovery_cancelled["']/);
  });

  // ---------------------------------------------------------------------------
  // 7. User cannot cancel another user's request.
  // ---------------------------------------------------------------------------
  it("test 7: cancel refuses non-owner with `wrong_user`", () => {
    const block = RECOVERY_SVC.match(
      /export async function cancelRecoveryRequest[\s\S]*?\n\}/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/row\.userId\s*!==\s*input\.actorUserId/);
    expect(block![0]).toMatch(/reason:\s*["']wrong_user["']/);
  });

  // ---------------------------------------------------------------------------
  // 8. Cancel after approval is rejected.
  // ---------------------------------------------------------------------------
  it("test 8: cancel returns `already_approved` for APPROVED or COMPLETED rows", () => {
    const block = RECOVERY_SVC.match(
      /export async function cancelRecoveryRequest[\s\S]*?\n\}/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/status\s*===\s*["']APPROVED["']/);
    expect(block![0]).toMatch(/status\s*===\s*["']COMPLETED["']/);
    expect(block![0]).toMatch(/reason:\s*["']already_approved["']/);
  });
});

// =============================================================================
// PART 3 — Admin approval still does NOT grant a session
// =============================================================================

describe("R8.1.5 — admin approval is not a session bypass", () => {
  // ---------------------------------------------------------------------------
  // 9. Admin approve still does not grant session.
  // ---------------------------------------------------------------------------
  it("test 9: recovery service never calls signJwt / setCookie / proovra_session", () => {
    expect(RECOVERY_SVC).not.toMatch(/signJwt\(/);
    expect(RECOVERY_SVC).not.toMatch(/setCookie\(/);
    expect(RECOVERY_SVC).not.toMatch(/proovra_session/);
    // Admin SPA likewise.
    expect(ADMIN_SPA).not.toMatch(/signJwt\(/);
    expect(ADMIN_SPA).not.toMatch(/proovra_session/);
    // Approve confirmation modal explains that approval does NOT
    // grant a session.
    expect(ADMIN_SPA).toMatch(/does\s+\<strong\>NOT\<\/strong\>\s+grant/);
  });

  // ---------------------------------------------------------------------------
  // 10. Admin reject is audited.
  // ---------------------------------------------------------------------------
  it("test 10: rejectRecoveryRequest appends a platform audit log row", () => {
    const block = RECOVERY_SVC.match(
      /export async function rejectRecoveryRequest[\s\S]*?\n\}/,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(
      /appendPlatformAuditLog\(\{[\s\S]*?action:\s*["']mfa\.recovery\.rejected["']/,
    );
  });
});

// =============================================================================
// PART 4 — Per-org fail mode
// =============================================================================

describe("R8.1.5 — per-org MFA enforcement fail-mode", () => {
  // ---------------------------------------------------------------------------
  // 11. Per-org fail mode overrides global env.
  // ---------------------------------------------------------------------------
  it("test 11: resolver picks per-org fail-mode first; env is fallback", () => {
    // Helper picks the strictest per-org override across the user's
    // teams BEFORE the circuit-breaker outcome is selected.
    expect(ENFORCEMENT_SVC).toMatch(/pickStrictestPerOrgFailMode/);
    expect(ENFORCEMENT_SVC).toMatch(/perOrgFailMode/);
    expect(ENFORCEMENT_SVC).toMatch(/if\s*\(perOrgFailMode\)\s*failMode\s*=\s*perOrgFailMode/);
    // Policy lookup selects mfaEnforcementFailMode.
    expect(ENFORCEMENT_SVC).toMatch(/mfaEnforcementFailMode:\s*true/);
  });

  // ---------------------------------------------------------------------------
  // 12. SMART / FAIL_CLOSED / FAIL_OPEN are bounded values.
  // ---------------------------------------------------------------------------
  it("test 12: PATCH policy enforces the three bounded values via zod enum", () => {
    expect(ADMIN_ROUTES).toMatch(
      /mfaEnforcementFailMode:\s*z\s*\.\s*enum\(\s*\[\s*["']SMART["'],\s*["']FAIL_OPEN["'],\s*["']FAIL_CLOSED["']\s*\]/,
    );
    // The policy service rejects unknown values.
    expect(POLICY_SVC).toMatch(/invalid_fail_mode/);
  });

  // ---------------------------------------------------------------------------
  // 13. Fail-mode update emits event.
  // ---------------------------------------------------------------------------
  it("test 13: updateMfaPolicy emits org_mfa_fail_mode_updated when value changed", () => {
    expect(POLICY_SVC).toMatch(/eventType:\s*["']org_mfa_fail_mode_updated["']/);
    // Only emitted when changed (avoids noisy SIEM rows).
    expect(POLICY_SVC).toMatch(/!==\s*priorFailMode/);
  });
});

// =============================================================================
// PART 5 — Admin SPA exists + uses approved endpoints
// =============================================================================

describe("R8.1.5 — MFA recovery admin SPA", () => {
  // ---------------------------------------------------------------------------
  // 14. Admin SPA route exists and uses approved endpoints.
  // ---------------------------------------------------------------------------
  it("test 14: SPA file at apps/web/app/(app)/security-center/mfa-recovery/page.tsx", () => {
    // Verifying read above already proves existence; assert it
    // calls the canonical admin endpoints.
    expect(ADMIN_SPA).toMatch(/\/v1\/identity\/mfa-admin\/recovery-requests/);
    expect(ADMIN_SPA).toMatch(/\/approve/);
    expect(ADMIN_SPA).toMatch(/\/reject/);
    expect(ADMIN_SPA).toMatch(/detail\//);
    // No bespoke auth surface.
    expect(ADMIN_SPA).not.toMatch(/\/v1\/auth-admin/);
    expect(ADMIN_SPA).not.toMatch(/signJwt/);
  });
});

// =============================================================================
// PART 6 — Privacy contract
// =============================================================================

describe("R8.1.5 — privacy contract: no raw secrets/tokens/codes", () => {
  // ---------------------------------------------------------------------------
  // 15. No raw token/code/secret logging.
  // ---------------------------------------------------------------------------
  it("test 15: no R8.1.5 surface includes raw email token / OTP / secret / signed token in event payload", () => {
    const surfaces = [
      RECOVERY_SVC,
      ENFORCEMENT_SVC,
      POLICY_SVC,
      ADMIN_ROUTES,
      ADMIN_SPA,
      EMAIL_SVC,
    ];
    for (const src of surfaces) {
      expect(src).not.toMatch(/details:\s*\{[^}]*\brawToken/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bemailToken/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\botpauth/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bsecret(Ciphertext|Iv|AuthTag)/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bmfaPendingToken/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bcode:\s*body\.code/);
    }
    // The schema persists ONLY the hash, never the raw token.
    expect(SCHEMA).not.toMatch(/^\s*emailVerificationToken\s+String[^?]/m);
    // The email body contains the verification URL (not the raw
    // token as a separate emit). The URL is constructed by
    // buildVerificationUrl which encodes the token into a search
    // param — that's the only place the raw token reaches the
    // wire, and only as part of the user-facing verification flow.
    expect(EMAIL_SVC).toMatch(/sendMfaRecoveryVerificationEmail/);
  });
});

// =============================================================================
// PART 7 — No regressions
// =============================================================================

describe("R8.1.5 — scope guards: no parallel auth / workflow / tenant leak", () => {
  // ---------------------------------------------------------------------------
  // 16. No duplicate auth system introduced.
  // ---------------------------------------------------------------------------
  it("test 16: no new top-level auth route file; admin endpoints live under /v1/identity/mfa-admin/*", () => {
    const routesDir = readdirSync(apiPath("src/routes"));
    // Filter to .ts sources only — compiled .js artifacts in src/ would
    // otherwise duplicate every match. The pin is on source files.
    const authFiles = routesDir.filter((f) => /auth/i.test(f) && f.endsWith(".ts"));
    // auth.routes.ts, sso-auth.routes.ts, saml-auth.routes.ts (R8.2 additive).
    // mfa-admin.routes.ts is the identity-security admin sub-domain, NOT an auth route.
    expect(authFiles.sort()).toEqual([
      "auth.routes.ts",
      "saml-auth.routes.ts",
      "sso-auth.routes.ts",
    ]);
    // The recovery + admin endpoints both live under /v1/identity/*.
    expect(ADMIN_ROUTES).toMatch(/\/v1\/identity\/mfa-admin\//);
    expect(ADMIN_ROUTES).toMatch(/\/v1\/identity\/mfa\/recovery-requests/);
    expect(ADMIN_ROUTES).not.toMatch(/\/v1\/auth-admin\b/);
    expect(ADMIN_ROUTES).not.toMatch(/\/v1\/admin\/login\b/);
  });

  // ---------------------------------------------------------------------------
  // 17. No workflow/persona auth logic introduced.
  // ---------------------------------------------------------------------------
  it("test 17: recovery + policy + enforcement services do not import workflow or persona modules", () => {
    for (const src of [RECOVERY_SVC, ENFORCEMENT_SVC, POLICY_SVC]) {
      expect(src).not.toMatch(/from\s+["'][^"']*workflow/);
      expect(src).not.toMatch(/from\s+["'][^"']*persona/);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. No tenant isolation regression.
  // ---------------------------------------------------------------------------
  it("test 18: every state-mutating recovery operation scopes by teamId or owner", () => {
    // The membership check on create binds teamId.
    expect(RECOVERY_SVC).toMatch(
      /teamMember\.findFirst\(\{\s*where:\s*\{[\s\S]{0,200}teamId:\s*input\.teamId/,
    );
    // The approve admin check requires ACTIVE OWNER/ADMIN on the
    // request's team — never a different team.
    expect(RECOVERY_SVC).toMatch(
      /teamMember\.findFirst\(\{\s*where:\s*\{[\s\S]{0,200}teamId:\s*row\.teamId/,
    );
    // The recovery_requests row carries teamId NOT NULL.
    expect(SCHEMA).toMatch(
      /model MfaRecoveryRequest \{[\s\S]*?teamId\s+String/,
    );
  });

  // ---------------------------------------------------------------------------
  // 19. No capture/upload/custody/report/package regression.
  // ---------------------------------------------------------------------------
  it("test 19: R8.1.5 surfaces do not import capture / upload / custody / report-package / TSA / OTS modules", () => {
    const forbidden = [
      "/capture",
      "/upload",
      "/custody",
      "/report-package",
      "/finalization",
      "/ots-",
      "/tsa-",
    ];
    const surfaces = [
      RECOVERY_SVC,
      ENFORCEMENT_SVC,
      POLICY_SVC,
      ADMIN_ROUTES,
      ADMIN_SPA,
      EMAIL_SVC,
    ];
    for (const src of surfaces) {
      for (const needle of forbidden) {
        expect(
          src.includes(`from "${needle}`) || src.includes(`from '${needle}`),
          `must not import ${needle}`,
        ).toBe(false);
      }
    }
  });
});

// =============================================================================
// Bonus — bounded vocabulary
// =============================================================================

describe("R8.1.5 bonus — bounded SECURITY_EVENT_TYPES vocabulary", () => {
  const R8_1_5_EVENTS = [
    "mfa_recovery_email_verification_sent",
    "mfa_recovery_email_verified",
    "mfa_recovery_email_expired",
    "mfa_recovery_cancelled",
    "org_mfa_fail_mode_updated",
  ];

  it("every R8.1.5 event type appears EXACTLY once in SECURITY_EVENT_TYPES", () => {
    for (const evt of R8_1_5_EVENTS) {
      const matches = SHARED_SEC.match(new RegExp(`"${evt}"`, "g"));
      expect(
        matches?.length ?? 0,
        `${evt} must appear exactly once`,
      ).toBe(1);
    }
  });

  it("R8.1.5 additions are commented with the R8.1.5 phase marker", () => {
    expect(SHARED_SEC).toMatch(/Phase R8\.1\.5/);
  });
});

// =============================================================================
// File-size sentinel
// =============================================================================

describe("R8.1.5 test file size sentinel", () => {
  it("this test file is non-trivial (>=14 KB) — protects against accidental truncation", () => {
    const st = statSync(__filename);
    expect(st.size).toBeGreaterThan(14_000);
  });
});
