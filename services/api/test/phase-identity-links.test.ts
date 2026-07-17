/**
 * Connected accounts / login methods contracts (lifecycle Phase 3, 2026-07-17).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const ROUTES = read("../src/routes/identity-links.routes.ts");
const AUTH = read("../src/services/auth.service.ts");
const SCHEMA = read("../prisma/schema.prisma");
const MIGRATION = read(
  "../prisma/migrations/20270918000000_user_identity_links/migration.sql",
);

describe("identity-link model + migration", () => {
  it("one provider identity belongs to exactly one account (DB unique)", () => {
    expect(SCHEMA).toMatch(/@@unique\(\[provider, providerSubjectId\]/);
  });
  it("backfill is deterministic from the verified legacy pair — never email inference", () => {
    expect(MIGRATION).toMatch(/u\."provider_user_id"/);
    expect(MIGRATION).toMatch(/ON CONFLICT \("provider", "provider_subject_id"\) DO NOTHING/);
    expect(MIGRATION).toMatch(/IN \('GOOGLE', 'APPLE'\)/);
    expect(MIGRATION).not.toMatch(/JOIN[\s\S]{0,80}email/i);
  });
  it("migration is additive-only (no destructive statements)", () => {
    expect(MIGRATION).not.toMatch(/DROP |TRUNCATE|DELETE FROM|ALTER TABLE .* RENAME/i);
  });
});

describe("linking security model", () => {
  it("provider tokens are verified server-side with the login verifiers", () => {
    expect(ROUTES).toMatch(/verifyGoogleIdToken/);
    expect(ROUTES).toMatch(/verifyAppleIdToken/);
  });
  it("conflicts return 409 identity_already_linked — accounts are never merged", () => {
    expect(ROUTES).toMatch(/identityBelongsElsewhere/);
    expect(ROUTES).toMatch(/identity_already_linked/);
    // No merge CODE PATH exists (prose in comments explains the rule).
    expect(ROUTES).not.toMatch(/merge(User|Account|Identit)/i);
  });
  it("every mutation is step-up gated before executing", () => {
    for (const action of ["login_method_link", "login_method_unlink", "password_add"]) {
      expect(ROUTES).toContain(`"${action}"`);
    }
    expect(ROUTES).toMatch(/verifyAccountStepUp/);
  });
  it("unlink enforces last-usable-method protection with a stable code", () => {
    expect(ROUTES).toMatch(/last_login_method_protected/);
    expect(ROUTES).toMatch(/usableAfter < 1/);
  });
  it("unlink revokes rather than erases, scoped to the caller's own link", () => {
    expect(ROUTES).toMatch(/where: \{ id: params\.id, userId, status: "ACTIVE" \}/);
    expect(ROUTES).toMatch(/status: "REVOKED"/);
    expect(ROUTES).not.toMatch(/userIdentityLink\.delete\(/);
  });
  it("add-password is policy-checked and never a recovery path", () => {
    expect(ROUTES).toMatch(/isPasswordPolicyCompliant/);
    expect(ROUTES).toMatch(/password_already_set/);
  });
  it("all mutations emit identity.* audit events", () => {
    expect(ROUTES).toMatch(/identity\.login_method_linked/);
    expect(ROUTES).toMatch(/identity\.login_method_unlinked/);
    expect(ROUTES).toMatch(/identity\.password_added/);
  });
});

describe("sign-in resolution", () => {
  it("resolves via ACTIVE identity link when the legacy pair misses (subject, never email)", () => {
    expect(AUTH).toMatch(/userIdentityLink\.findFirst[\s\S]{0,300}status: "ACTIVE"/);
    expect(AUTH).toMatch(/providerSubjectId: profile\.providerUserId/);
  });
  it("every OAuth sign-in freshens the link inventory without blocking auth", () => {
    expect(AUTH).toMatch(/userIdentityLink[\s\S]{0,80}\.upsert/);
    expect(AUTH).toMatch(/lastUsedAtUtc: now/);
    expect(AUTH).toMatch(/\.catch\(\(\) => null\)/);
  });
});
