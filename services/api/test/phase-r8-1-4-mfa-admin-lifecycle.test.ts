/**
 * PHASE R8.1.4 — MFA admin lifecycle + scheduled GC + circuit breaker
 * source-contract tests.
 *
 * 17 numbered tests from the phase spec, plus a small sentinel
 * group at the tail. These are SOURCE-CONTRACT tests — they read
 * the canonical files and assert structural properties; they do
 * NOT touch a live database.
 *
 * The tests deliberately verify:
 *   - Worker scheduled GC exists, is bounded, idempotent, and only
 *     deletes stale rows.
 *   - Enforcement resolver classifies errors and emits the right
 *     circuit-breaker event (degraded vs failed-closed). Personal
 *     fail-OPEN and org fail-CLOSED both wired.
 *   - Admin lifecycle service enforces org-scoped admin
 *     authorization and emits audit + security events on every
 *     state transition.
 *   - Lost-factor recovery does NOT issue a session, and on
 *     approval atomically revokes the user's factors so the next
 *     login enters the enrollment-required state.
 *   - The in-memory JTI deny-list AND `verifyAndConsumeMfaPendingToken`
 *     are REMOVED from `jwt.ts`.
 *   - No raw secret / OTP / recovery code / token in any
 *     security-event payload.
 *   - No parallel auth surface (new routes live under
 *     `/v1/identity/mfa-admin/*`, NOT `/v1/auth-admin/*`).
 *   - No workflow/persona authorization introduced.
 *   - No tenant-isolation regression.
 *   - No capture/upload/custody/report/package modules touched.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel: string) => resolve(REPO, "services/api", rel);
const workerPath = (rel: string) => resolve(REPO, "services/worker", rel);
const webPath = (rel: string) => resolve(REPO, "apps/web", rel);
const sharedPath = (rel: string) => resolve(REPO, "packages/shared", rel);

const JWT_SRC = readFileSync(apiPath("src/services/jwt.ts"), "utf8");
const ENFORCEMENT_SVC = readFileSync(
  apiPath("src/services/security/login-mfa-enforcement.service.ts"),
  "utf8",
);
const MFA_SVC = readFileSync(
  apiPath("src/services/security/mfa.service.ts"),
  "utf8",
);
const ADMIN_SVC = readFileSync(
  apiPath("src/services/security/mfa-admin-lifecycle.service.ts"),
  "utf8",
);
const RECOVERY_SVC = readFileSync(
  apiPath("src/services/security/mfa-recovery-request.service.ts"),
  "utf8",
);
const ADMIN_ROUTES = readFileSync(
  apiPath("src/routes/mfa-admin.routes.ts"),
  "utf8",
);
const AUTH_SRC = readFileSync(
  apiPath("src/routes/auth.routes.ts"),
  "utf8",
);
const WORKER_GC = readFileSync(
  workerPath("src/mfa-challenge-gc.ts"),
  "utf8",
);
const WORKER_INDEX = readFileSync(
  workerPath("src/index.ts"),
  "utf8",
);
const SCHEMA = readFileSync(apiPath("prisma/schema.prisma"), "utf8");
const SHARED_SEC = readFileSync(sharedPath("src/security.ts"), "utf8");
const SECURITY_CENTER = readFileSync(
  webPath("app/(app)/security-center/page.tsx"),
  "utf8",
);
const MFA_PAGE = readFileSync(
  webPath("app/auth/mfa-challenge/page.tsx"),
  "utf8",
);

// =============================================================================
// PART 1 — Scheduled cleanup
// =============================================================================

describe("R8.1.4 — scheduled MFA challenge cleanup", () => {
  // ---------------------------------------------------------------------------
  // 1. scheduled cleanup preserves active challenges.
  // ---------------------------------------------------------------------------
  it("test 1: GC only deletes rows past the retention window (active challenges preserved)", () => {
    // The cutoff is computed as `now - RETENTION_SECONDS`; rows
    // with `expiresAt` AFTER the cutoff are NEVER deleted.
    expect(WORKER_GC).toMatch(/RETENTION_SECONDS\s*=\s*60\s*\*\s*60/);
    expect(WORKER_GC).toMatch(/lt:\s*retentionCutoff/);
    // The findMany scopes by the OR — consumed-and-old or expired-
    // and-old. Live challenges in their 5-min window match neither.
    expect(WORKER_GC).toMatch(/consumedAt:\s*\{\s*not:\s*null,\s*lt:\s*retentionCutoff/);
    expect(WORKER_GC).toMatch(/expiresAt:\s*\{\s*lt:\s*retentionCutoff/);
  });

  // ---------------------------------------------------------------------------
  // 2. scheduled cleanup removes expired/consumed challenges after retention.
  // ---------------------------------------------------------------------------
  it("test 2: GC deletes via deleteMany keyed by the selected stale ids", () => {
    expect(WORKER_GC).toMatch(
      /prisma\.mfaPendingChallenge\.deleteMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*stale\.map/,
    );
  });

  // ---------------------------------------------------------------------------
  // 3. cleanup is bounded and idempotent.
  // ---------------------------------------------------------------------------
  it("test 3: GC batch is bounded (<= 200 per call) AND idempotent under concurrency", () => {
    expect(WORKER_GC).toMatch(/PENDING_CHALLENGE_BATCH\s*=\s*200/);
    expect(WORKER_GC).toMatch(/take:\s*PENDING_CHALLENGE_BATCH/);
    // Idempotent: the recovery-request expire step re-checks one
    // of the in-flight preflight states in the UPDATE so a parallel
    // approval / cancel that raced us cannot be silently overwritten.
    // R8.1.5 widened this set from the legacy `PENDING` value to
    // `EMAIL_VERIFICATION_PENDING` and `PENDING_ADMIN_REVIEW`.
    expect(WORKER_GC).toMatch(
      /updateMany\(\{\s*where:\s*\{[\s\S]{0,300}status:\s*\{\s*in:\s*\[\s*["']EMAIL_VERIFICATION_PENDING["'],\s*["']PENDING_ADMIN_REVIEW["']\s*\]/,
    );
    // The worker index registers the start + stop hooks.
    expect(WORKER_INDEX).toMatch(/startMfaChallengeGcScheduler\(\);/);
    expect(WORKER_INDEX).toMatch(/stopMfaChallengeGcScheduler\(\);/);
  });
});

// =============================================================================
// PART 2 — Circuit breaker
// =============================================================================

describe("R8.1.4 — enforcement circuit breaker", () => {
  // ---------------------------------------------------------------------------
  // 4. circuit breaker does not silently bypass org-required MFA.
  // ---------------------------------------------------------------------------
  it("test 4: smart-mode org-scoped fail-CLOSED path returns MFA_REQUIRED or ENROLLMENT_REQUIRED (NEVER NOT_REQUIRED)", () => {
    // The circuitBreakerOutcome helper has THREE branches and the
    // org-scoped branch (`looksOrgScoped`) MUST end in either
    // MFA_REQUIRED (if factor known) or ENROLLMENT_REQUIRED (if
    // not). NEVER NOT_REQUIRED.
    expect(ENFORCEMENT_SVC).toMatch(/looksOrgScoped/);
    // Within the org-scoped branch we expect both MFA_REQUIRED and
    // ENROLLMENT_REQUIRED outcomes but NEVER a NOT_REQUIRED return
    // (that would be the silent bypass the spec forbids). Use the
    // function-body slice between `looksOrgScoped` and the close
    // of the smart-mode block (the `// Personal user, factor lookup`
    // comment marks the next branch).
    const orgClosedStart = ENFORCEMENT_SVC.indexOf("if (looksOrgScoped)");
    const orgClosedEndMarker = ENFORCEMENT_SVC.indexOf(
      "// Personal user, factor lookup",
      orgClosedStart,
    );
    expect(orgClosedStart).toBeGreaterThan(0);
    expect(orgClosedEndMarker).toBeGreaterThan(orgClosedStart);
    const orgClosedBlock = ENFORCEMENT_SVC.slice(
      orgClosedStart,
      orgClosedEndMarker,
    );
    expect(orgClosedBlock).toMatch(/MFA_REQUIRED/);
    expect(orgClosedBlock).toMatch(/ENROLLMENT_REQUIRED/);
    expect(orgClosedBlock).not.toMatch(/outcome:\s*["']NOT_REQUIRED["']/);
  });

  // ---------------------------------------------------------------------------
  // 5. degraded enforcement emits security event.
  // ---------------------------------------------------------------------------
  it("test 5: circuit breaker emits mfa_enforcement_degraded OR mfa_enforcement_failed_closed", () => {
    expect(ENFORCEMENT_SVC).toMatch(/eventType:\s*["']mfa_enforcement_degraded["']/);
    expect(ENFORCEMENT_SVC).toMatch(/eventType:\s*["']mfa_enforcement_failed_closed["']/);
    // The fail-mode env override is honoured.
    expect(ENFORCEMENT_SVC).toMatch(/MFA_ENFORCEMENT_FAIL_MODE/);
    expect(ENFORCEMENT_SVC).toMatch(/failMode === "open"/);
    expect(ENFORCEMENT_SVC).toMatch(/failMode === "closed"/);
  });
});

// =============================================================================
// PART 3 — Admin MFA lifecycle controls
// =============================================================================

describe("R8.1.4 — admin MFA lifecycle controls", () => {
  // ---------------------------------------------------------------------------
  // 6. admin MFA action is org-scoped.
  // ---------------------------------------------------------------------------
  it("test 6: every admin lifecycle function calls the shared `assertAdminCanAct` scope guard", () => {
    // The guard returns a bounded failure code on mismatch; every
    // public function MUST call it before mutating state.
    expect(ADMIN_SVC).toMatch(/async function assertAdminCanAct/);
    // Each public function invokes it exactly once at the top.
    const publicFns = [
      "readUserMfaPosture",
      "revokeUserFactor",
      "requireUserReenrollment",
      "resetTrustedDevicesForUser",
    ];
    for (const fn of publicFns) {
      const start = ADMIN_SVC.indexOf(`export async function ${fn}`);
      expect(start, `${fn} export must exist`).toBeGreaterThan(0);
      const body = ADMIN_SVC.slice(start, start + 1200);
      expect(body, `${fn} must call assertAdminCanAct`).toMatch(
        /assertAdminCanAct/,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 7. admin cannot manage outside-org user.
  // ---------------------------------------------------------------------------
  it("test 7: scope guard refuses cross-team — checks both admin and target team membership", () => {
    // Guard returns "admin_not_in_team" / "admin_not_admin" /
    // "target_not_in_team" — all three classes covered.
    expect(ADMIN_SVC).toMatch(/admin_not_in_team/);
    expect(ADMIN_SVC).toMatch(/admin_not_admin/);
    expect(ADMIN_SVC).toMatch(/target_not_in_team/);
    // Both lookups are keyed by the EXPLICIT teamId — a cross-team
    // hop would have to forge the param. The route maps that to
    // 403/404.
    expect(ADMIN_SVC).toMatch(
      /teamMember\.findFirst\(\{\s*where:\s*\{\s*userId:\s*input\.actorUserId,\s*teamId:\s*input\.teamId/,
    );
    expect(ADMIN_SVC).toMatch(
      /teamMember\.findFirst\(\{\s*where:\s*\{\s*userId:\s*input\.targetUserId,\s*teamId:\s*input\.teamId/,
    );
  });

  // ---------------------------------------------------------------------------
  // 8. factor revoke invalidates verification.
  // ---------------------------------------------------------------------------
  it("test 8: revokeUserFactor flips status to REVOKED (NEVER deletes) and emits mfa_admin_factor_revoked", () => {
    expect(ADMIN_SVC).toMatch(/status:\s*["']REVOKED["']/);
    expect(ADMIN_SVC).toMatch(/eventType:\s*["']mfa_admin_factor_revoked["']/);
    // The orchestrator's verifyActiveTotp scopes on status: "ACTIVE",
    // so a REVOKED factor cannot satisfy a verification.
    expect(MFA_SVC).toMatch(/status:\s*["']ACTIVE["'],\s*kind:\s*["']TOTP["']/);
  });

  // ---------------------------------------------------------------------------
  // 9. trusted-device reset is audited.
  // ---------------------------------------------------------------------------
  it("test 9: resetTrustedDevicesForUser emits mfa_trusted_devices_reset + audit log", () => {
    expect(ADMIN_SVC).toMatch(/eventType:\s*["']mfa_trusted_devices_reset["']/);
    expect(ADMIN_SVC).toMatch(/action:\s*["']mfa\.admin\.trusted_devices_reset["']/);
  });
});

// =============================================================================
// PART 4 — Lost-factor recovery workflow
// =============================================================================

describe("R8.1.4 — lost-factor recovery workflow", () => {
  // ---------------------------------------------------------------------------
  // 10. lost-factor recovery does not grant full session.
  // ---------------------------------------------------------------------------
  it("test 10: recovery service NEVER calls signJwt / maybeSetWebCookie / issues a session", () => {
    // The service only mutates DB state (request status + factor
    // revocation + recovery code invalidation). It MUST NOT mint
    // any auth artifact.
    expect(RECOVERY_SVC).not.toMatch(/signJwt\(/);
    expect(RECOVERY_SVC).not.toMatch(/setCookie\(/);
    expect(RECOVERY_SVC).not.toMatch(/proovra_session/);
    // Admin route surface also never MINTS a session.
    expect(ADMIN_ROUTES).not.toMatch(/signJwt\(/);
    // R8.1.7 — the routes file now READS the proovra_session cookie
    // in the optional session-detection helper (so the verify
    // endpoint can decide whether to show a "Continue to home"
    // CTA). It still does NOT WRITE that cookie. Assert the
    // strict no-write predicate.
    expect(ADMIN_ROUTES).not.toMatch(/setCookie\(\s*["']proovra_session["']/);
    expect(ADMIN_ROUTES).not.toMatch(/reply\.setCookie\(\s*["']proovra_session/);
  });

  // ---------------------------------------------------------------------------
  // 11. recovery forces re-enrollment.
  // ---------------------------------------------------------------------------
  it("test 11: approveRecoveryRequest atomically revokes ALL ACTIVE factors + invalidates recovery codes", () => {
    // The APPROVED transition runs inside a `$transaction` with
    // THREE writes: status update, mfaFactor.updateMany REVOKED,
    // mfaRecoveryCode.updateMany batchInvalidatedAt. Atomic so we
    // never have an "APPROVED but old factors still ACTIVE" window.
    const tx = RECOVERY_SVC.match(/prisma\.\$transaction\(\[[\s\S]*?\]\)/);
    expect(tx).toBeTruthy();
    expect(tx![0]).toMatch(/mfaRecoveryRequest\.update/);
    expect(tx![0]).toMatch(/mfaFactor\.updateMany/);
    expect(tx![0]).toMatch(/mfaRecoveryCode\.updateMany/);
    expect(tx![0]).toMatch(/status:\s*["']REVOKED["']/);
    expect(tx![0]).toMatch(/batchInvalidatedAt:/);
  });
});

// =============================================================================
// PART 5 — In-memory JTI deny-list removed
// =============================================================================

describe("R8.1.4 — in-memory JTI deny-list removed", () => {
  // ---------------------------------------------------------------------------
  // 12. in-memory JTI deny-list is removed.
  // ---------------------------------------------------------------------------
  it("test 12: jwt.ts no longer defines mfaPendingDenyList / gcMfaPendingDenyList / verifyAndConsumeMfaPendingToken", () => {
    expect(JWT_SRC).not.toMatch(/\bmfaPendingDenyList\b/);
    expect(JWT_SRC).not.toMatch(/\bgcMfaPendingDenyList\b/);
    expect(JWT_SRC).not.toMatch(/\bverifyAndConsumeMfaPendingToken\b/);
    expect(JWT_SRC).not.toMatch(/__resetMfaPendingDenyListForTests/);
    // The signature primitive remains.
    expect(JWT_SRC).toMatch(/verifyMfaPendingTokenSignature/);
  });
});

// =============================================================================
// PART 6 — Privacy contract
// =============================================================================

describe("R8.1.4 — privacy contract: no raw secrets/codes/tokens", () => {
  // ---------------------------------------------------------------------------
  // 13. no raw secrets/tokens/codes are logged.
  // ---------------------------------------------------------------------------
  it("test 13: no R8.1.4 surface includes a raw OTP/recovery code/secret/token in event payload", () => {
    const surfaces = [
      ADMIN_SVC,
      RECOVERY_SVC,
      ADMIN_ROUTES,
      WORKER_GC,
      ENFORCEMENT_SVC,
    ];
    for (const src of surfaces) {
      // The details: { ... } block of a safeEmitSecurityEvent OR a
      // securityEvent.create call MUST NOT carry these field names.
      expect(src).not.toMatch(/details:\s*\{[^}]*\bcode:\s*[^}]*\}/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\brecoveryCode:/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\botpauth/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bsecret(Ciphertext|Iv|AuthTag)/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bmfaPendingToken/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\btoken:/);
    }
  });
});

// =============================================================================
// PART 7 — Scope: no parallel auth, no workflow/persona, no tenant leak
// =============================================================================

describe("R8.1.4 — no parallel auth / workflow / tenant regression", () => {
  // ---------------------------------------------------------------------------
  // 14. no duplicate auth system introduced.
  // ---------------------------------------------------------------------------
  it("test 14: admin routes live under /v1/identity/mfa-admin/* — NOT a parallel /v1/auth-admin/*", () => {
    expect(ADMIN_ROUTES).toMatch(/\/v1\/identity\/mfa-admin\/posture/);
    expect(ADMIN_ROUTES).not.toMatch(/\/v1\/auth-admin\b/);
    expect(ADMIN_ROUTES).not.toMatch(/\/v1\/admin-auth\b/);
    expect(ADMIN_ROUTES).not.toMatch(/\/v1\/admin\/login/);
    // Admin routes do NOT mint a session.
    expect(ADMIN_ROUTES).not.toMatch(/signJwt\(/);
    // The two existing auth route files are still the ONLY ones
    // under `routes/` that match `*auth*`.
    const routesDir = readdirSync(apiPath("src/routes"));
    const authFiles = routesDir.filter((f) => /auth/i.test(f));
    // R8.2 additive: saml-auth.routes.ts alongside the OIDC route.
    expect(authFiles.sort()).toEqual([
      "auth.routes.ts",
      "saml-auth.routes.ts",
      "sso-auth.routes.ts",
    ]);
  });

  // ---------------------------------------------------------------------------
  // 15. no workflow/persona auth logic introduced.
  // ---------------------------------------------------------------------------
  it("test 15: R8.1.4 services do NOT import workflow or persona modules", () => {
    const surfaces = [ADMIN_SVC, RECOVERY_SVC, ENFORCEMENT_SVC];
    for (const src of surfaces) {
      expect(src).not.toMatch(/from\s+["'][^"']*workflow/);
      expect(src).not.toMatch(/from\s+["'][^"']*persona/);
    }
  });

  // ---------------------------------------------------------------------------
  // 16. no tenant isolation regression.
  // ---------------------------------------------------------------------------
  it("test 16: every admin lookup scopes by the explicit teamId; recovery requests bind to a single teamId", () => {
    // Admin guard: both queries are keyed by `teamId: input.teamId`.
    expect(ADMIN_SVC.match(/teamId:\s*input\.teamId/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Recovery service requires teamId on every public mutation.
    expect(RECOVERY_SVC).toMatch(/teamId:\s*input\.teamId/);
    // Schema row has teamId NOT NULL.
    expect(SCHEMA).toMatch(/model MfaRecoveryRequest \{[\s\S]*?teamId\s+String/);
  });

  // ---------------------------------------------------------------------------
  // 17. no capture/upload/custody/report/package regression.
  // ---------------------------------------------------------------------------
  it("test 17: R8.1.4 does not import capture / upload / custody / report-package / TSA / OTS modules anywhere", () => {
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
      ADMIN_SVC,
      RECOVERY_SVC,
      ENFORCEMENT_SVC,
      ADMIN_ROUTES,
      WORKER_GC,
      SECURITY_CENTER,
      MFA_PAGE,
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
// Bonus — bounded vocabulary additions
// =============================================================================

describe("R8.1.4 bonus — bounded SECURITY_EVENT_TYPES vocabulary", () => {
  const R8_1_4_EVENTS = [
    "mfa_challenge_gc_completed",
    "mfa_enforcement_degraded",
    "mfa_enforcement_failed_closed",
    "mfa_admin_factor_revoked",
    "mfa_admin_reenrollment_required",
    "mfa_trusted_devices_reset",
    "mfa_recovery_requested",
    "mfa_recovery_approved",
    "mfa_recovery_completed",
  ];

  it("every R8.1.4 event type appears EXACTLY once in SECURITY_EVENT_TYPES", () => {
    for (const evt of R8_1_4_EVENTS) {
      const matches = SHARED_SEC.match(new RegExp(`"${evt}"`, "g"));
      expect(
        matches?.length ?? 0,
        `${evt} must appear exactly once`,
      ).toBe(1);
    }
  });

  it("R8.1.4 additions are commented with the R8.1.4 phase marker", () => {
    expect(SHARED_SEC).toMatch(/Phase R8\.1\.4/);
  });
});

// =============================================================================
// Bonus — admin surface wiring
// =============================================================================

describe("R8.1.4 bonus — admin surface wiring (server + UI)", () => {
  it("the admin routes file is registered in server.ts", () => {
    const SERVER = readFileSync(apiPath("src/server.ts"), "utf8");
    expect(SERVER).toMatch(/mfaAdminRoutes/);
    expect(SERVER).toMatch(/app\.register\(mfaAdminRoutes\)/);
  });

  it("security-center surfaces the pending recovery requests via data-cc-mfa-recovery-admin-card", () => {
    expect(SECURITY_CENTER).toMatch(/data-cc-mfa-recovery-admin-card/);
    expect(SECURITY_CENTER).toMatch(/\/v1\/identity\/mfa-admin\/recovery-requests/);
  });

  it("auth.routes.ts no longer imports the removed legacy helper", () => {
    expect(AUTH_SRC).not.toMatch(/\bverifyAndConsumeMfaPendingToken\b/);
    expect(AUTH_SRC).toMatch(/\bverifyMfaPendingTokenSignature\b/);
  });
});

// =============================================================================
// File size sentinel
// =============================================================================

describe("R8.1.4 test file size sentinel", () => {
  it("this test file is non-trivial (>=14 KB) — protects against accidental truncation", () => {
    const st = statSync(__filename);
    expect(st.size).toBeGreaterThan(14_000);
  });
});
