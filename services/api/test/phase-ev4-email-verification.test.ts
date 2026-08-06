/**
 * PHASE EV — Enterprise email verification source-contract tests.
 *
 * Locks the wiring shape so future edits cannot silently:
 *   - Re-introduce a JWT in the email/register response
 *   - Skip the emailVerifiedAt guard on email/login
 *   - Remove the verify/resend endpoints
 *   - Lose the OAuth (Google/Apple) bypass that auto-verifies
 *   - Lose the EmailVerificationToken Prisma model or its backfill
 *     migration
 *
 * These are SOURCE-CONTRACT tests by design (no DB, no Resend). They
 * mirror the phase-r8-1-2 + phase-r8-1-9 patterns already in this
 * package.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel: string) => resolve(REPO, "services/api", rel);
const webPath = (rel: string) => resolve(REPO, "apps/web", rel);

const AUTH_ROUTES_SRC = readFileSync(apiPath("src/routes/auth.routes.ts"), "utf8");
const EMAIL_AUTH_SRC = readFileSync(
  apiPath("src/services/email-password-auth.service.ts"),
  "utf8",
);
const AUTH_SVC_SRC = readFileSync(apiPath("src/services/auth.service.ts"), "utf8");
const EMAIL_SVC_SRC = readFileSync(apiPath("src/services/email.service.ts"), "utf8");
const PRISMA_SRC = readFileSync(apiPath("prisma/schema.prisma"), "utf8");

const MIGRATION_DIR = apiPath(
  "prisma/migrations/20270828000000_email_verification_tokens",
);

// Slice the source of a specific endpoint handler so we can assert
// inside its body without false positives from other routes that
// happen to mention the same identifiers.
function endpointBody(path: string): string {
  const marker = `app.post("${path}"`;
  const start = AUTH_ROUTES_SRC.indexOf(marker);
  if (start < 0) throw new Error(`Endpoint not found: ${path}`);
  // Find the matching closing brace of the route arrow function.
  // Cheap heuristic: stop at the next `  app.post(` declaration or EOF.
  const nextDecl = AUTH_ROUTES_SRC.indexOf(
    "  app.post(",
    start + marker.length,
  );
  const end = nextDecl < 0 ? AUTH_ROUTES_SRC.length : nextDecl;
  return AUTH_ROUTES_SRC.slice(start, end);
}

// =============================================================================
// PART 1 — Prisma model + backfill migration
// =============================================================================

describe("EV phase 1 — Prisma model + migration", () => {
  it("test 1: EmailVerificationToken model is declared in schema.prisma", () => {
    expect(PRISMA_SRC).toMatch(/model\s+EmailVerificationToken\s*\{/);
    expect(PRISMA_SRC).toMatch(/@@map\("email_verification_tokens"\)/);
  });

  it("test 2: model fields match the PasswordResetToken shape (hashed, single-use, expiring)", () => {
    const model = PRISMA_SRC.match(
      /model\s+EmailVerificationToken\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(model).toBeTruthy();
    expect(model).toMatch(/tokenHash\s+String\s+@map\("token_hash"\)\s+@db\.VarChar\(64\)/);
    expect(model).toMatch(/expiresAt\s+DateTime\s+@map\("expires_at"\)/);
    expect(model).toMatch(/usedAt\s+DateTime\?\s+@map\("used_at"\)/);
    expect(model).toMatch(/onDelete:\s*Cascade/);
  });

  it("test 3: User relation back-reference is declared", () => {
    expect(PRISMA_SRC).toMatch(/emailVerificationTokens\s+EmailVerificationToken\[\]/);
  });

  it("test 4: backfill migration directory and SQL exist", () => {
    expect(existsSync(MIGRATION_DIR)).toBe(true);
    const sql = readFileSync(resolve(MIGRATION_DIR, "migration.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "email_verification_tokens"/);
    // Backfill protects existing users from being locked out.
    expect(sql).toMatch(/UPDATE\s+"users"\s+SET\s+"email_verified_at"\s*=\s*CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/WHERE\s+"email_verified_at"\s+IS\s+NULL/);
  });
});

// =============================================================================
// PART 2 — Service layer
// =============================================================================

describe("EV phase 2 — service layer", () => {
  it("test 5: createEmailVerificationToken hashes the token and invalidates priors", () => {
    expect(EMAIL_AUTH_SRC).toMatch(
      /export\s+async\s+function\s+createEmailVerificationToken/,
    );
    // Slice from the function declaration to the next top-level `export`
    // so we capture exactly this body and nothing past it.
    const start = EMAIL_AUTH_SRC.indexOf(
      "export async function createEmailVerificationToken",
    );
    const next = EMAIL_AUTH_SRC.indexOf("\nexport ", start + 1);
    const fn = EMAIL_AUTH_SRC.slice(start, next < 0 ? undefined : next);
    expect(fn).toMatch(/sha256Hex\(rawToken\)/);
    // Wipe any prior unused token before issuing a new one.
    expect(fn).toMatch(/updateMany/);
    // The fresh token is persisted with the hashed value.
    expect(fn).toMatch(/data:\s*\{[\s\S]*?tokenHash/);
  });

  it("test 6: consumeEmailVerificationToken rejects invalid / expired / already-used", () => {
    const fn = EMAIL_AUTH_SRC.match(
      /consumeEmailVerificationToken\([\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/reason:\s*"invalid"/);
    expect(fn).toMatch(/reason:\s*"expired"/);
    expect(fn).toMatch(/reason:\s*"already_used"/);
    // Stamps emailVerifiedAt on the user when consuming successfully.
    expect(fn).toMatch(/emailVerifiedAt/);
  });

  it("test 7: 24-hour TTL constant is wired", () => {
    expect(EMAIL_AUTH_SRC).toMatch(
      /EMAIL_VERIFICATION_TTL_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    );
  });

  it("test 8: OAuth upsertUserWithEmailLink sets emailVerifiedAt for GOOGLE + APPLE", () => {
    expect(AUTH_SVC_SRC).toMatch(
      /isOAuthProvider\s*=\s*[\s\S]*?AuthProvider\.GOOGLE[\s\S]*?AuthProvider\.APPLE/,
    );
    // Both the create and update branches must apply the stamp.
    const create = AUTH_SVC_SRC.match(
      /prisma\.user\.create\(\{[\s\S]*?\}\)/,
    )?.[0];
    const update = AUTH_SVC_SRC.match(
      /prisma\.user\.update\(\{\s*where:\s*\{\s*id:\s*user\.id\s*\}[\s\S]*?\}\)/,
    )?.[0];
    expect(create).toBeTruthy();
    expect(create).toMatch(/isOAuthProvider/);
    expect(create).toMatch(/emailVerifiedAt/);
    expect(update).toBeTruthy();
    expect(update).toMatch(/isOAuthProvider/);
    expect(update).toMatch(/emailVerifiedAt/);
  });
});

// =============================================================================
// PART 3 — Email service template
// =============================================================================

describe("EV phase 3 — email template", () => {
  it("test 9: sendEmailVerificationEmail is declared on EmailService", () => {
    // Match the function-type signature with relaxed whitespace —
    // Prettier wraps long type signatures onto multiple lines.
    expect(EMAIL_SVC_SRC).toMatch(
      // PHASE 12 POINT 5 — the return type is now the transport's OUTCOME
      // rather than `unknown`. That is the change that makes a provider
      // rejection impossible to mistake for a success at the type level, so
      // the pin follows it instead of being loosened.
      /sendEmailVerificationEmail:\s*\([\s\S]*?email:\s*string,[\s\S]*?verifyUrl:\s*string[\s\S]*?\)\s*=>\s*Promise<EmailDeliveryOutcome>/,
    );
  });

  it("test 10: not-configured fallback throws the canonical missing-key error", () => {
    expect(EMAIL_SVC_SRC).toMatch(
      /async\s+sendEmailVerificationEmail\(\)\s*\{[\s\S]*?Email service not configured/,
    );
  });

  it("test 11: real implementation calls resend.emails.send with the verify subject", () => {
    expect(EMAIL_SVC_SRC).toMatch(/subject:\s*`Verify your \$\{app\} account`/);
  });
});

// =============================================================================
// PART 4 — Register endpoint stops issuing JWT
// =============================================================================

describe("EV phase 4 — register no-JWT", () => {
  const body = endpointBody("/v1/auth/email/register");

  it("test 12: register handler does NOT call signJwt", () => {
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/signJwt\(/);
  });

  it("test 13: register handler does NOT call maybeSetWebCookie / recordSessionFromSignedToken", () => {
    expect(body).not.toMatch(/maybeSetWebCookie\(/);
    expect(body).not.toMatch(/recordSessionFromSignedToken\(/);
  });

  it("test 14: register handler delegates verification dispatch to the service", () => {
    // Token creation + URL build + Resend call moved into
    // email-verification.service.ts (extracted to keep auth.routes.ts
    // within the R8.1.2 size baseline). The route only orchestrates.
    expect(body).toMatch(/dispatchVerificationEmail\(\{[\s\S]*?userId:\s*user\.id/);
  });

  it("test 15: register response shape is { verificationSent, email } (not { token, user })", () => {
    expect(body).toMatch(/verificationSent:/);
    expect(body).toMatch(/code\(201\)\.send\(\{[\s\S]*?verificationSent/);
    // Defensive: the previous `{ token, user }` shape is gone.
    expect(body).not.toMatch(/\.send\(\{\s*token,\s*user\s*\}/);
  });

  it("test 16: verify URL targets /auth/verify-email in the service module", () => {
    // The literal URL lives in email-verification.service.ts now —
    // the route shouldn't hard-code it.
    const svc = readFileSync(
      apiPath("src/services/email-verification.service.ts"),
      "utf8",
    );
    expect(svc).toMatch(/\/auth\/verify-email\?token=/);
  });
});

// =============================================================================
// PART 5 — Login guard
// =============================================================================

describe("EV phase 5 — login guard", () => {
  const body = endpointBody("/v1/auth/email/login");

  it("test 17: login handler refuses unverified accounts with EMAIL_NOT_VERIFIED", () => {
    expect(body).toBeTruthy();
    expect(body).toMatch(/if\s*\(\s*!user\.emailVerifiedAt\s*\)/);
    expect(body).toMatch(/code\(403\)\.send\(\{[\s\S]*?EMAIL_NOT_VERIFIED/);
  });

  it("test 18: guard runs AFTER the credential check, BEFORE the MFA gate", () => {
    // Stable order pins. The unverified branch must appear between the
    // invalid_credentials 401 response and the gateLoginWithMfa call.
    const invalidIdx = body.indexOf('invalid_credentials');
    const verifyIdx = body.indexOf('emailVerifiedAt');
    const mfaIdx = body.indexOf('gateLoginWithMfa');
    expect(invalidIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(invalidIdx);
    expect(mfaIdx).toBeGreaterThan(verifyIdx);
  });
});

// =============================================================================
// PART 6 — Verify + resend endpoints
// =============================================================================

describe("EV phase 6 — verify + resend endpoints", () => {
  it("test 19: POST /v1/auth/email/verify exists, rate-limited, signs a JWT on success", () => {
    const body = endpointBody("/v1/auth/email/verify");
    expect(body).toBeTruthy();
    expect(body).toMatch(/enforceRateLimit\(\{[\s\S]*?auth:email-verify:ip/);
    // Token consumption delegated to the service (extracted to keep
    // auth.routes.ts within the size baseline).
    expect(body).toMatch(/confirmVerificationToken\(/);
    expect(body).toMatch(/signJwt\(/);
    expect(body).toMatch(/maybeSetWebCookie\(/);
    // Non-enumerating failure code.
    expect(body).toMatch(/INVALID_OR_EXPIRED/);
  });

  it("test 20: POST /v1/auth/email/resend-verification exists and returns neutral 200", () => {
    const body = endpointBody("/v1/auth/email/resend-verification");
    expect(body).toBeTruthy();
    expect(body).toMatch(/enforceRateLimit\(\{[\s\S]*?auth:email-resend:ip/);
    // The whole pipeline (lookup, cooldown, send) lives in
    // email-verification.service.ts now — the route delegates.
    expect(body).toMatch(/processResendVerification\(/);
    // Cooldown constant + lookup helper live in the service.
    const svc = readFileSync(
      apiPath("src/services/email-verification.service.ts"),
      "utf8",
    );
    expect(svc).toMatch(/EMAIL_VERIFICATION_RESEND_COOLDOWN_MS/);
    expect(svc).toMatch(/findUnverifiedEmailUserByEmail\(/);
    // Neutral 200 OK regardless of branch.
    expect((body.match(/reply\.code\(200\)\.send\(\{\s*ok:\s*true\s*\}\)/g) || []).length)
      .toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/reply\.code\(404\)/);
  });
});

// =============================================================================
// PART 7 — Frontend wiring
// =============================================================================

describe("EV phase 7 — frontend wiring", () => {
  it("test 21: /auth/verify-email page exists", () => {
    const p = webPath("app/auth/verify-email/page.tsx");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toMatch(/\/v1\/auth\/email\/verify/);
    expect(src).toMatch(/setToken\(/);
  });

  it("test 22: register page flips to a verify-email success card (no auto-redirect to /home)", () => {
    const src = readFileSync(webPath("app/register/page.tsx"), "utf8");
    expect(src).toMatch(/registerSuccess/);
    expect(src).toMatch(/setRegisteredEmail/);
    expect(src).toMatch(/onResendVerification/);
    expect(src).toMatch(/Verify your email address/);
    // The old "Your PROOVRA workspace is ready" auto-redirect copy is gone.
    expect(src).not.toMatch(/Your PROOVRA workspace is ready/);
  });

  it("test 23: login page surfaces the EMAIL_NOT_VERIFIED affordance", () => {
    const src = readFileSync(webPath("app/login/page.tsx"), "utf8");
    expect(src).toMatch(/EMAIL_NOT_VERIFIED/);
    expect(src).toMatch(/setNeedsVerification/);
    expect(src).toMatch(/\/v1\/auth\/email\/resend-verification/);
  });
});
