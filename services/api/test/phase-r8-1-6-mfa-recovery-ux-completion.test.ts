/**
 * PHASE R8.1.6 — User-facing verify page, per-account throttle,
 * admin quorum SPA, pending digest source-contract tests.
 *
 * 19 numbered tests from the phase spec, plus a small sentinel
 * group at the tail. Source-contract checks only — no live DB.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel: string) => resolve(REPO, "services/api", rel);
const webPath = (rel: string) => resolve(REPO, "apps/web", rel);
const workerPath = (rel: string) => resolve(REPO, "services/worker", rel);
const sharedPath = (rel: string) => resolve(REPO, "packages/shared", rel);

const VERIFY_PAGE_PATH = webPath("app/auth/mfa-recovery/verify/page.tsx");
const ADMIN_SPA_PATH = webPath(
  "app/(app)/security-center/mfa-recovery/page.tsx",
);
const RECOVERY_SVC_PATH = apiPath(
  "src/services/security/mfa-recovery-request.service.ts",
);
const DIGEST_PATH = workerPath("src/mfa-recovery-digest.ts");
const WORKER_INDEX_PATH = workerPath("src/index.ts");
const SCHEMA_PATH = apiPath("prisma/schema.prisma");
const SHARED_SEC_PATH = sharedPath("src/security.ts");
const EMAIL_SVC_PATH = apiPath("src/services/email.service.ts");
const ADMIN_ROUTES_PATH = apiPath("src/routes/mfa-admin.routes.ts");

const VERIFY_PAGE = readFileSync(VERIFY_PAGE_PATH, "utf8");
const ADMIN_SPA = readFileSync(ADMIN_SPA_PATH, "utf8");
const RECOVERY_SVC = readFileSync(RECOVERY_SVC_PATH, "utf8");
const DIGEST_SRC = readFileSync(DIGEST_PATH, "utf8");
const WORKER_INDEX = readFileSync(WORKER_INDEX_PATH, "utf8");
const SCHEMA = readFileSync(SCHEMA_PATH, "utf8");
const SHARED_SEC = readFileSync(SHARED_SEC_PATH, "utf8");
const EMAIL_SVC = readFileSync(EMAIL_SVC_PATH, "utf8");
const ADMIN_ROUTES = readFileSync(ADMIN_ROUTES_PATH, "utf8");

// =============================================================================
// PART 1 — User-facing verify page
// =============================================================================

describe("R8.1.6 — user-facing recovery verify page", () => {
  // ---------------------------------------------------------------------------
  // 1. Verify page exists.
  // ---------------------------------------------------------------------------
  it("test 1: apps/web/app/auth/mfa-recovery/verify/page.tsx exists", () => {
    expect(existsSync(VERIFY_PAGE_PATH)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 2. Verify page reads id/token but does NOT persist them.
  // ---------------------------------------------------------------------------
  it("test 2: page reads id+token from searchParams and never writes them to localStorage/sessionStorage", () => {
    expect(VERIFY_PAGE).toMatch(/useSearchParams/);
    expect(VERIFY_PAGE).toMatch(/search\.get\(["']id["']\)/);
    expect(VERIFY_PAGE).toMatch(/search\.get\(["']token["']\)/);
    expect(VERIFY_PAGE).not.toMatch(/localStorage\.set/);
    expect(VERIFY_PAGE).not.toMatch(/sessionStorage\.set/);
    // The page strips the token from the URL after posting (no
    // leak via back-button / share).
    expect(VERIFY_PAGE).toMatch(/searchParams\.delete\(["']token["']\)/);
  });

  // ---------------------------------------------------------------------------
  // 3. Verify page posts to canonical endpoint.
  // ---------------------------------------------------------------------------
  it("test 3: page POSTs to /v1/identity/mfa/recovery-requests/:id/verify-email", () => {
    expect(VERIFY_PAGE).toMatch(
      /\/v1\/identity\/mfa\/recovery-requests\/\$\{encodeURIComponent\([^)]+\)\}\/verify-email/,
    );
    // No bespoke or duplicate verify endpoint.
    expect(VERIFY_PAGE).not.toMatch(/\/v1\/auth-recovery/);
    expect(VERIFY_PAGE).not.toMatch(/\/v1\/auth\/recovery/);
  });

  // ---------------------------------------------------------------------------
  // 4. Verify success does not create session.
  // ---------------------------------------------------------------------------
  it("test 4: verify page does NOT call signJwt / setCookie / set proovra_session / setToken", () => {
    // R8.1.8 tightening — the page's R8.1.8 optimization comment
    // mentions `proovra_session` (explains WHY we fall back to
    // localStorage detection — the HttpOnly cookie is unreadable
    // from JS). The comment is operationally informative and
    // should stay; we narrow the assertion to actual code shapes
    // that would mint or write the session.
    expect(VERIFY_PAGE).not.toMatch(/\bsignJwt\s*\(/);
    expect(VERIFY_PAGE).not.toMatch(/\bsetToken\s*\(/);
    expect(VERIFY_PAGE).not.toMatch(/setCookie\s*\(\s*["']proovra_session/);
    expect(VERIFY_PAGE).not.toMatch(/document\.cookie\s*=/);
    // The "verified" UI explicitly says "did NOT log you in".
    expect(VERIFY_PAGE).toMatch(/did NOT log you in/);
  });

  // ---------------------------------------------------------------------------
  // 5. Invalid/expired token handled safely.
  // ---------------------------------------------------------------------------
  it("test 5: page renders bounded error states for expired / invalid / wrong_user / already_handled", () => {
    expect(VERIFY_PAGE).toMatch(/expired/);
    expect(VERIFY_PAGE).toMatch(/invalid/);
    expect(VERIFY_PAGE).toMatch(/wrong_user/);
    expect(VERIFY_PAGE).toMatch(/already_handled/);
    // The error block carries a data-attribute so source-contract
    // tests + e2e can target it without knowing the copy.
    expect(VERIFY_PAGE).toMatch(/data-cc-mfa-recovery-verify-state="error"/);
    expect(VERIFY_PAGE).toMatch(/data-cc-mfa-recovery-verify-reason=/);
  });
});

// =============================================================================
// PART 2 — Per-account throttle
// =============================================================================

describe("R8.1.6 — per-account recovery throttle", () => {
  // ---------------------------------------------------------------------------
  // 6. Per-account throttle blocks excessive requests.
  // ---------------------------------------------------------------------------
  it("test 6: createRecoveryRequest refuses with `rate_limited` when the user is over the per-account limit", () => {
    expect(RECOVERY_SVC).toMatch(/MFA_RECOVERY_PER_ACCOUNT_LIMIT\s*=\s*3/);
    expect(RECOVERY_SVC).toMatch(
      /MFA_RECOVERY_PER_ACCOUNT_WINDOW_SECONDS\s*=\s*24\s*\*\s*60\s*\*\s*60/,
    );
    expect(RECOVERY_SVC).toMatch(
      /recentCount\s*>=\s*MFA_RECOVERY_PER_ACCOUNT_LIMIT/,
    );
    expect(RECOVERY_SVC).toMatch(/reason:\s*["']rate_limited["']/);
  });

  // ---------------------------------------------------------------------------
  // 7. Throttle is DB-backed, not in-memory.
  // ---------------------------------------------------------------------------
  it("test 7: throttle uses prisma.count on mfaRecoveryRequest (no in-process Map / Set / counter)", () => {
    // The count query is keyed by userId + createdAt window.
    expect(RECOVERY_SVC).toMatch(
      /prisma\.mfaRecoveryRequest\.count\(\{\s*where:\s*\{\s*userId:\s*input\.userId,\s*createdAt:\s*\{\s*gte:\s*throttleWindowStart/,
    );
    // The service file does NOT introduce a Map / Set / counter
    // for throttle state (those would defeat multi-instance
    // correctness).
    expect(RECOVERY_SVC).not.toMatch(
      /const\s+\w*[Tt]hrottle\w*\s*=\s*new\s+Map/,
    );
    expect(RECOVERY_SVC).not.toMatch(
      /const\s+\w*[Tt]hrottle\w*\s*=\s*new\s+Set/,
    );
  });

  // ---------------------------------------------------------------------------
  // 8. Throttle emits event.
  // ---------------------------------------------------------------------------
  it("test 8: throttle branch emits mfa_recovery_throttled with bounded counters", () => {
    expect(RECOVERY_SVC).toMatch(
      /eventType:\s*["']mfa_recovery_throttled["']/,
    );
    // The route maps the result to HTTP 429.
    expect(ADMIN_ROUTES).toMatch(
      /result\.reason\s*===\s*["']rate_limited["'][\s\S]{0,200}reply\.code\(429\)/,
    );
  });
});

// =============================================================================
// PART 3 — Admin SPA quorum
// =============================================================================

describe("R8.1.6 — admin SPA quorum progress", () => {
  // ---------------------------------------------------------------------------
  // 9. Admin SPA shows N/M approval progress.
  // ---------------------------------------------------------------------------
  it("test 9: SPA renders approvalCount/requiredApprovals via data-cc-mfa-recovery-quorum-count + waiting badge", () => {
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-recovery-quorum-count/);
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-recovery-quorum-waiting/);
    expect(ADMIN_SPA).toMatch(/Waiting for additional approval/);
    // The approve confirmation modal also surfaces quorum progress.
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-recovery-approve-quorum/);
  });

  // ---------------------------------------------------------------------------
  // 10. Admin SPA blocks approval before email verification.
  // ---------------------------------------------------------------------------
  it("test 10: approve button is disabled until rq.emailVerified is true", () => {
    expect(ADMIN_SPA).toMatch(/disabled=\{!rq\.emailVerified/);
    expect(ADMIN_SPA).toMatch(
      /Cannot approve until the user verifies their email/,
    );
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-email-verified="false"/);
  });

  // ---------------------------------------------------------------------------
  // 11. Approval modal warns no login is granted.
  // ---------------------------------------------------------------------------
  it("test 11: approve confirmation modal explicitly states approval does NOT grant a session", () => {
    expect(ADMIN_SPA).toMatch(/does\s+<strong>NOT<\/strong>\s+grant/);
    // The modal also mentions re-enrollment + trusted-device reset.
    expect(ADMIN_SPA).toMatch(/re-enroll/);
    expect(ADMIN_SPA).toMatch(/trusted devices/);
  });
});

// =============================================================================
// PART 4 — Pending digest
// =============================================================================

describe("R8.1.6 — pending recovery digest job", () => {
  // ---------------------------------------------------------------------------
  // 12. Pending digest job exists.
  // ---------------------------------------------------------------------------
  it("test 12: worker has runMfaRecoveryDigest + wired to a scheduler", () => {
    expect(DIGEST_SRC).toMatch(/export async function runMfaRecoveryDigest/);
    expect(WORKER_INDEX).toMatch(/startMfaRecoveryDigestScheduler\(\);/);
    expect(WORKER_INDEX).toMatch(/stopMfaRecoveryDigestScheduler\(\);/);
  });

  // ---------------------------------------------------------------------------
  // 13. Digest email contains no tokens/secrets.
  // ---------------------------------------------------------------------------
  it("test 13: digest body carries ONLY count + team name + admin SPA URL (no token / OTP / secret / user email enumeration)", () => {
    // The sender body builds the email from per-team summaries +
    // a total pending count + the admin SPA URL. No raw user
    // emails enumerated into the body; no token/code field
    // anywhere. R8.1.7 refactored from per-team to per-admin
    // grouping (totalPending across teams) — both shapes carry
    // ONLY counts + team display names.
    expect(DIGEST_SRC).not.toMatch(/details:\s*\{[^}]*\btoken/);
    expect(DIGEST_SRC).not.toMatch(/details:\s*\{[^}]*\bcode/);
    expect(DIGEST_SRC).not.toMatch(/details:\s*\{[^}]*\brawToken/);
    expect(DIGEST_SRC).not.toMatch(/details:\s*\{[^}]*\botpauth/);
    // Worker body uses an array of team summaries — no enumeration
    // of individual user emails into the body.
    expect(DIGEST_SRC).not.toMatch(
      /body:\s*JSON\.stringify\([^)]*\bemail:\s*recipients/,
    );
    // The HTTP-API body carries counts + adminSpaUrl only. Match
    // the WHOLE send function (R8.1.7 split body construction
    // across a `lines: string[]` array before `const text = ...`,
    // so the narrow text-only span misses the count references).
    const sendFn = DIGEST_SRC.match(
      /async function send(?:DigestEmail|AdminDigest)[\s\S]*?\n\}/,
    );
    expect(sendFn).toBeTruthy();
    expect(sendFn![0]).toMatch(/totalPending|pendingCount/);
    expect(sendFn![0]).toMatch(/adminSpaUrl/);
    // Sanity: body does not carry raw token / OTP / recovery code.
    expect(sendFn![0]).not.toMatch(/\bOTP\b/);
    expect(sendFn![0]).not.toMatch(/\brecovery code\b/i);
  });

  // ---------------------------------------------------------------------------
  // 14. Digest job is bounded/idempotent.
  // ---------------------------------------------------------------------------
  it("test 14: digest is bounded (per-tick fan-out cap) and idempotent (UNIQUE teamId+sentDate)", () => {
    // R8.1.6 used MAX_TEAMS_PER_TICK; R8.1.7 refactored to
    // MAX_ADMINS_PER_TICK now that one email per admin replaces
    // one email per team. Accept either name.
    expect(DIGEST_SRC).toMatch(/MAX_(TEAMS|ADMINS)_PER_TICK\s*=\s*(50|100)/);
    // Per-team idempotency via the legacy log row (still
    // preserved as a per-team SecOps marker).
    expect(DIGEST_SRC).toMatch(/mfaRecoveryDigestLog\.create/);
    // Schema enforces UNIQUE (teamId, sentDate).
    expect(SCHEMA).toMatch(/@@unique\(\[teamId,\s*sentDate\]\)/);
  });
});

// =============================================================================
// PART 5 — Privacy contract
// =============================================================================

describe("R8.1.6 — privacy contract: no raw secrets/tokens/codes", () => {
  // ---------------------------------------------------------------------------
  // 15. No raw token/code/secret logging.
  // ---------------------------------------------------------------------------
  it("test 15: no R8.1.6 surface includes raw email token / OTP / secret in event payload or log line", () => {
    const surfaces = [
      RECOVERY_SVC,
      ADMIN_ROUTES,
      DIGEST_SRC,
      VERIFY_PAGE,
      ADMIN_SPA,
      EMAIL_SVC,
    ];
    for (const src of surfaces) {
      // Never include raw token / OTP / recovery code / signed
      // token / TOTP secret in security-event details or in
      // structured log objects.
      expect(src).not.toMatch(/details:\s*\{[^}]*\brawToken/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bemailToken/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\botpauth/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bsecret(Ciphertext|Iv|AuthTag)/);
      expect(src).not.toMatch(/details:\s*\{[^}]*\bmfaPendingToken/);
      // Worker logger objects must not embed the raw token.
      expect(src).not.toMatch(/logger\.\w+\(\{[^}]*\bemailToken/);
      expect(src).not.toMatch(/logger\.\w+\(\{[^}]*\brawToken/);
    }
    // The schema persists ONLY hash; no raw-token column.
    expect(SCHEMA).not.toMatch(/^\s*emailVerificationToken\s+String[^?]/m);
  });
});

// =============================================================================
// PART 6 — Scope guards
// =============================================================================

describe("R8.1.6 — scope guards: no parallel auth / workflow / tenant leak", () => {
  // ---------------------------------------------------------------------------
  // 16. No duplicate auth system introduced.
  // ---------------------------------------------------------------------------
  it("test 16: auth-bearing route files are auth.routes.ts + sso-auth.routes.ts + saml-auth.routes.ts (R8.2 additive); verify page is /auth/mfa-recovery/verify NOT a separate auth surface", () => {
    const routesDir = readdirSync(apiPath("src/routes"));
    // Filter to .ts sources only — compiled .js artifacts in src/ would
    // otherwise duplicate every match. The pin is on source files.
    const authFiles = routesDir.filter((f) => /auth/i.test(f) && f.endsWith(".ts"));
    // R8.2 added saml-auth.routes.ts alongside the existing OIDC route.
    // mfa.routes.ts is identity sub-domain (R8.1.1), counted separately.
    expect(authFiles.sort()).toEqual([
      "auth.routes.ts",
      "saml-auth.routes.ts",
      "sso-auth.routes.ts",
    ]);
    // Verify page uses the canonical apiFetch + canonical endpoint.
    expect(VERIFY_PAGE).toMatch(/apiFetch\(/);
    expect(VERIFY_PAGE).not.toMatch(/\/v1\/auth-mfa-recovery/);
  });

  // ---------------------------------------------------------------------------
  // 17. No workflow/persona auth logic introduced.
  // ---------------------------------------------------------------------------
  it("test 17: digest worker + recovery service + verify page do not import workflow or persona", () => {
    const surfaces = [RECOVERY_SVC, DIGEST_SRC, VERIFY_PAGE, ADMIN_SPA];
    for (const src of surfaces) {
      expect(src).not.toMatch(/from\s+["'][^"']*workflow/);
      expect(src).not.toMatch(/from\s+["'][^"']*persona/);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. No tenant isolation regression.
  // ---------------------------------------------------------------------------
  it("test 18: digest scopes recipients by team membership; throttle scopes by userId only; digest log is per-team", () => {
    // R8.1.6 scoped per-team (`teamId,`); R8.1.7 refactored to a
    // batched lookup keyed by `teamId: { in: teamIds }` so one
    // query resolves admin sets across many teams. Both shapes
    // satisfy the "scope by team membership" invariant — accept
    // either by matching just the scoping fragment.
    expect(DIGEST_SRC).toMatch(
      /teamMember\.findMany\(\{\s*where:\s*\{[\s\S]{0,200}status:\s*["']ACTIVE["'],\s*role:\s*\{\s*in:\s*\[["']OWNER["'],\s*["']ADMIN["']\]/,
    );
    // Throttle count is keyed by user — never leaks across users.
    expect(RECOVERY_SVC).toMatch(
      /mfaRecoveryRequest\.count\(\{\s*where:\s*\{\s*userId:\s*input\.userId/,
    );
    // Digest log is per-team.
    expect(SCHEMA).toMatch(
      /model MfaRecoveryDigestLog \{[\s\S]*?teamId\s+String/,
    );
  });

  // ---------------------------------------------------------------------------
  // 19. No capture/upload/custody/report/package regression.
  // ---------------------------------------------------------------------------
  it("test 19: R8.1.6 surfaces do not import capture / upload / custody / report-package / TSA / OTS modules", () => {
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
      ADMIN_ROUTES,
      DIGEST_SRC,
      VERIFY_PAGE,
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

describe("R8.1.6 bonus — bounded SECURITY_EVENT_TYPES vocabulary", () => {
  const R8_1_6_EVENTS = [
    "mfa_recovery_throttled",
    "mfa_recovery_digest_sent",
  ];

  it("every R8.1.6 event type appears EXACTLY once in SECURITY_EVENT_TYPES", () => {
    for (const evt of R8_1_6_EVENTS) {
      const matches = SHARED_SEC.match(new RegExp(`"${evt}"`, "g"));
      expect(
        matches?.length ?? 0,
        `${evt} must appear exactly once`,
      ).toBe(1);
    }
  });

  it("R8.1.6 additions are commented with the R8.1.6 phase marker", () => {
    expect(SHARED_SEC).toMatch(/Phase R8\.1\.6/);
  });
});

// =============================================================================
// File-size sentinel
// =============================================================================

describe("R8.1.6 test file size sentinel", () => {
  it("this test file is non-trivial (>=14 KB) — protects against accidental truncation", () => {
    const st = statSync(__filename);
    expect(st.size).toBeGreaterThan(14_000);
  });
});
