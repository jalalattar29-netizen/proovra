/**
 * AUD-0021 — platform authority always needs a second factor at sign-in.
 *
 * The login MFA decision looked only at enrolled factors and workspace policy,
 * so a platform administrator with no factor and no workspace policy signed in
 * with a password alone and reached the platform API. The decision now asks the
 * one platform-admin authority (resolvePlatformAdmin): an administrator with a
 * factor is challenged, one without is sent to guided enrollment, and nobody
 * else's outcome changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  admin: false,
  factors: [] as Array<{ id: string; kind: string; status: string }>,
  memberships: [] as Array<{ teamId: string; role: string }>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    teamMember: { findMany: async () => H.memberships },
    team: { findMany: async () => [] },
    organizationSecurityPolicy: { findMany: async () => [] },
  },
}));
vi.mock("../src/services/security/mfa.service.js", () => ({
  SIGN_IN_SECOND_FACTOR_KINDS: ["TOTP", "PASSKEY"],
  readMfaStatus: async () => ({ hasMfa: H.factors.length > 0, factors: H.factors }),
}));
vi.mock("../src/services/platform-admin.service.js", () => ({
  resolvePlatformAdmin: async () => ({ allowed: H.admin, source: H.admin ? "DATABASE_ROLE" : "NOT_ADMIN", claimedAdmin: false }),
}));
vi.mock("../src/services/security/security-event.service.js", () => ({ safeEmitSecurityEvent: () => {} }));

const { resolveLoginMfaEnforcement } = await import("../src/services/security/login-mfa-enforcement.service.js");

describe("AUD-0021 login MFA decision for platform authority", () => {
  beforeEach(() => {
    H.admin = false;
    H.factors = [];
    H.memberships = [];
  });

  it("a platform administrator with no factor is sent to enrollment (never a password-only session)", async () => {
    H.admin = true;
    const d = await resolveLoginMfaEnforcement({ userId: "u-admin" });
    expect(d).toMatchObject({ outcome: "ENROLLMENT_REQUIRED", basis: "PLATFORM_AUTHORITY", activeFactorCount: 0 });
  });

  it("a platform administrator with an enrolled factor is challenged, even with no workspace policy", async () => {
    H.admin = true;
    H.factors = [{ id: "f1", kind: "TOTP", status: "ACTIVE" }];
    H.memberships = [{ teamId: "t1", role: "MEMBER" }];
    const d = await resolveLoginMfaEnforcement({ userId: "u-admin" });
    expect(d).toMatchObject({ outcome: "MFA_REQUIRED", basis: "PLATFORM_AUTHORITY", activeFactorCount: 1 });
  });

  it("control: an ordinary user with no factor and no workspace keeps the old outcome", async () => {
    const d = await resolveLoginMfaEnforcement({ userId: "u-plain" });
    expect(d.outcome).toBe("NOT_REQUIRED");
    expect(d.basis).toBeUndefined();
  });

  it("control: an ordinary user with a factor is challenged on the existing basis", async () => {
    H.factors = [{ id: "f1", kind: "TOTP", status: "ACTIVE" }];
    const d = await resolveLoginMfaEnforcement({ userId: "u-plain" });
    expect(d.outcome).toBe("MFA_REQUIRED");
    expect(d.basis).toBeUndefined();
  });
});
