/**
 * TWO THINGS THAT MUST NEVER CROSS THE API BOUNDARY.
 *
 * A password hash, and the deployment's own configuration.
 *
 * Both shipped. `POST /v1/auth/email/login` returned the user's scrypt
 * `passwordHash` inside its 200 body, because the route sent the Prisma row it
 * had just used to verify the password. And `NoopAiProvider` answered users
 * with "Configure OPENAI_AI_ENABLED=true and provide OPENAI_API_KEY" in a
 * user-facing `summary` field that the assistant panel and the evidence
 * categorisation route both render.
 *
 * These tests fail if either returns.
 */

import { describe, expect, it } from "vitest";

import {
  AUTH_USER_PROJECTION_KEYS,
  toAuthUserProjection,
} from "../src/http/auth-user-projection.js";
import { NoopAiProvider } from "../src/services/ai/noop-ai-provider.js";
import { AiTask } from "../src/services/ai/ai-types.js";
import {
  assertNoCredentialMaterial,
  FORBIDDEN_CREDENTIAL_KEYS,
} from "./_helpers/no-credential-material.js";

// ===========================================================================
// THE PASSWORD HASH
// ===========================================================================

/** A row shaped like what `prisma.user.findFirst` returns — hash included. */
const PERSISTED_USER = {
  id: "0adf0000-0000-4000-8000-000000000006",
  email: "pro-personal@fixture.local",
  displayName: "Pro Personal",
  firstName: null,
  lastName: null,
  avatarUrl: null,
  bio: null,
  country: null,
  locale: null,
  timezone: null,
  provider: "EMAIL",
  providerUserId: "pro-personal@fixture.local",
  platformRole: null,
  identityMode: "SELF_SERVE",
  managingOrganizationId: null,
  managedIdentitySource: null,
  managedBySsoConnectionId: null,
  organizationVerificationState: null,
  currentWorkspaceId: "4d799dbf-e022-4a19-a96b-8fa567a9e336",
  emailVerifiedAt: "2026-09-02T13:06:57.978Z",
  createdAt: "2026-09-02T13:06:57.978Z",
  updatedAt: "2026-09-03T15:30:52.240Z",
  /*
   * The field that leaked.
   *
   * The FORMAT is real — `scrypt$N$r$p$salt$hash`, what `hashPassword` emits —
   * so the helper's value-pattern check is genuinely exercised and not just its
   * key check. The DIGITS are not: they are a repeating filler, because a test
   * fixture is a permanent, greppable, world-readable file and the one thing
   * this whole test exists to prevent is a password hash ending up somewhere it
   * does not belong. Pasting a real one here — even a local fixture account's —
   * would be the same mistake in a different file.
   */
  passwordHash: `scrypt$16384$8$1$${"0".repeat(32)}$${"0".repeat(64)}`,
};

describe("auth user projection", () => {
  it("drops the password hash", () => {
    const projected = toAuthUserProjection(PERSISTED_USER) as Record<string, unknown>;
    expect(projected).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(projected)).not.toContain("scrypt$");
  });

  it("carries no credential material at any depth", () => {
    assertNoCredentialMaterial(
      { token: "a.jwt.value", user: toAuthUserProjection(PERSISTED_USER) },
      "POST /v1/auth/email/login",
    );
  });

  it("the helper actually catches the defect it was written for", () => {
    // Guards the guard. A check that cannot fail proves nothing, and this one
    // is the only thing standing between a new secret column and the wire.
    expect(() =>
      assertNoCredentialMaterial({ token: "t", user: PERSISTED_USER }, "pre-fix login"),
    ).toThrow(/passwordHash/);
  });

  it("catches a hash hidden under an innocent key", () => {
    expect(() =>
      assertNoCredentialMaterial({ detail: `stored as ${PERSISTED_USER.passwordHash}` }, "x"),
    ).toThrow(/credential is leaking/);
  });

  it("catches a secret nested deep in a payload", () => {
    expect(() =>
      assertNoCredentialMaterial(
        { data: { members: [{ user: { id: "u", mfaSecret: "JBSWY3DP" } }] } },
        "nested",
      ),
    ).toThrow(/mfaSecret/);
  });

  it("does not fail on legitimate facts ABOUT a credential", () => {
    // These say whether a password exists, not what it is. Refusing them would
    // make the guard something people switch off.
    expect(() =>
      assertNoCredentialMaterial(
        { hasPassword: true, passwordUpdatedAt: "2026-01-01", requiresPasswordReset: false },
        "ok",
      ),
    ).not.toThrow();
  });

  it("preserves the client contract the login response already carried", () => {
    // The leak is fixed by removing ONE field. Removing others would break
    // sign-in for a reason unrelated to security.
    for (const field of [
      "id",
      "email",
      "displayName",
      "provider",
      "platformRole",
      "firstName",
      "lastName",
      "avatarUrl",
      "locale",
      "timezone",
      "country",
      "bio",
      "createdAt",
      "updatedAt",
    ]) {
      expect(AUTH_USER_PROJECTION_KEYS, `web AuthUser needs ${field}`).toContain(field);
    }
    // Exactly the persisted shape minus the hash.
    expect(AUTH_USER_PROJECTION_KEYS).toHaveLength(Object.keys(PERSISTED_USER).length - 1);
  });

  it("is an allow-list, so a new secret column cannot ride along", () => {
    // The actual security property: a column added to the User model tomorrow
    // is invisible here until someone names it.
    const withFutureSecret = {
      ...PERSISTED_USER,
      totpSecret: "JBSWY3DPEHPK3PXP",
      recoveryCodes: ["aaaa-bbbb"],
      refreshTokenHash: "deadbeef",
    };
    const projected = toAuthUserProjection(withFutureSecret) as Record<string, unknown>;
    for (const leaked of ["totpSecret", "recoveryCodes", "refreshTokenHash"]) {
      expect(projected).not.toHaveProperty(leaked);
    }
    assertNoCredentialMaterial(projected, "projection with future secret columns");
  });

  it("names the credential keys it refuses", () => {
    for (const key of ["passwordhash", "mfasecret", "recoverycodes", "refreshtokenhash"]) {
      expect(FORBIDDEN_CREDENTIAL_KEYS).toContain(key);
    }
  });
});

// ===========================================================================
// THE DEPLOYMENT CONFIGURATION
// ===========================================================================
describe("provider-not-configured response", () => {
  it("names no environment variable, key or setup instruction", () => {
    const result = new NoopAiProvider("PROVIDER_NOT_CONFIGURED");
    return result.run(AiTask.SUPPORT_CHAT, {}).then((r) => {
      const userFacing = [r.summary, ...r.warnings, ...r.suggestions].join(" ");
      for (const forbidden of [
        "OPENAI_AI_ENABLED",
        "OPENAI_API_KEY",
        "OPENAI",
        "Configure",
        "backend configuration",
        "environment variable",
        "API key",
      ]) {
        expect(userFacing, `leaked: ${forbidden}`).not.toContain(forbidden);
      }
    });
  });

  it("is truthful and tells the user what still works", async () => {
    const r = await new NoopAiProvider().run(AiTask.SUPPORT_CHAT, {});
    expect(r.summary).toMatch(/unavailable/i);
    expect(r.summary).toMatch(/capture|reports|verification/i);
  });

  it("does not masquerade as a successful inference", async () => {
    // `status` is what the cost ledger, the audit record and the assistant
    // panel all branch on. "ok" here would record a model call that never
    // happened and a provider that is healthy when it is absent.
    const r = await new NoopAiProvider().run(AiTask.SUPPORT_CHAT, {});
    expect(r.status).toBe("disabled");
    expect(r.status).not.toBe("ok");
  });

  it("carries no credential material", async () => {
    const r = await new NoopAiProvider("PROVIDER_PRIVACY_REFUSED").run(AiTask.SUPPORT_CHAT, {});
    assertNoCredentialMaterial(r, "NoopAiProvider result");
  });

  it("keeps the two operator causes distinguishable, server-side", () => {
    // The detail is not deleted, it is moved. An operator still has to be able
    // to tell "no key" from "privacy posture refused" — different fixes.
    expect(new NoopAiProvider("PROVIDER_NOT_CONFIGURED").getReason()).toBe(
      "PROVIDER_NOT_CONFIGURED",
    );
    expect(new NoopAiProvider("PROVIDER_PRIVACY_REFUSED").getReason()).toBe(
      "PROVIDER_PRIVACY_REFUSED",
    );
  });

  it("says the same safe thing for every task", async () => {
    // Evidence categorisation forwards `summary` to its own response, so a
    // per-task variation would be a second place for this to regress.
    const provider = new NoopAiProvider();
    const chat = await provider.run(AiTask.SUPPORT_CHAT, {});
    const categorization = await provider.run(
      AiTask.EVIDENCE_METADATA_CATEGORIZATION,
      {},
    );
    expect(categorization.summary).toBe(chat.summary);
    expect(categorization.summary).not.toContain("OPENAI");
  });
});
