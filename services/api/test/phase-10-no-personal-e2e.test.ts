/**
 * PHASE 10 §13.2 STEP 6 — NO-PERSONAL END-TO-END ENFORCEMENT.
 *
 * The canonical no-personal decision lives in ONE place
 * (`identity-mode.service.ts`): `personalSpaceAllowed` is true ONLY for a
 * STANDARD identity; `assertPersonalSpaceAllowed` throws
 * MANAGED_IDENTITY_NO_PERSONAL_SPACE (403) for a MANAGED identity AND fails
 * closed for a MANAGED_UNRESOLVED identity. STEP 6 wires that single gate into
 * every remaining PERSONAL-scope server surface (personal capture draft,
 * personal Evidence create, personal Evidence finalize, personal checkout,
 * personal-context switch) IN ADDITION to the personal bootstrap and personal
 * export that were already enforced.
 *
 * This suite proves, BEHAVIOURALLY (real service + prisma stub) where the seam
 * is injectable, that a MANAGED identity is denied with ZERO mutation and a
 * MANAGED_UNRESOLVED identity fails closed; and, via SOURCE-CONTRACT + a
 * source-scan zero-metric, that EVERY personal server surface routes through the
 * canonical guard (no surface bypasses it).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertPersonalSpaceAllowed,
  personalSpaceAllowed,
} from "../src/services/identity/identity-mode.service.js";
import { ensurePersonalWorkspace } from "../src/services/platform-context/workspace-bootstrap.service.js";

const NO_PERSONAL = { code: "MANAGED_IDENTITY_NO_PERSONAL_SPACE", statusCode: 403 };

// -----------------------------------------------------------------------------
// Identity rows for each of the three canonical resolution states.
// -----------------------------------------------------------------------------

/** STANDARD — an ordinary self-service identity WITH a personal space. */
const STANDARD_ROW = {
  identityMode: "STANDARD",
  managingOrganizationId: null,
  managedIdentitySource: null,
  managedBySsoConnectionId: null,
};

/** MANAGED — org-owned via a SCIM/DOMAIN source (valid without a connection). */
const MANAGED_ROW = {
  identityMode: "MANAGED_ENTERPRISE",
  managingOrganizationId: "org-A",
  managedIdentitySource: "SCIM",
  managedBySsoConnectionId: null,
};

/** MANAGED_UNRESOLVED — a MANAGED flag with NO owning org (inconsistent). */
const MANAGED_UNRESOLVED_ROW = {
  identityMode: "MANAGED_ENTERPRISE",
  managingOrganizationId: null,
  managedIdentitySource: null,
  managedBySsoConnectionId: null,
};

/**
 * Minimal prisma stub that answers `user.findUnique` with a fixed identity row
 * and records every write. `team.create` / `organization.create` / `user.update`
 * MUST NEVER fire on a denial (the zero-mutation custody invariant).
 */
function identityStub(
  row: Record<string, unknown>,
  // PHASE 12 POINT 7 — the second, INDEPENDENT denial rule: an Organization
  // this user belongs to sets `noPersonalSpace`. Defaults to "no Organization
  // forbids it" so every pre-existing identity-mode assertion below is
  // unchanged, and is supplied explicitly by the org-policy cases.
  denyingPolicies: ReadonlyArray<{ organizationId: string; noPersonalSpace: boolean }> = [],
) {
  const writes: string[] = [];
  const prisma = {
    organizationSecurityPolicy: { findMany: async () => denyingPolicies },
    user: {
      findUnique: async () => row,
      update: async () => {
        writes.push("user.update");
        return {};
      },
    },
    team: {
      findFirst: async () => null,
      create: async () => {
        writes.push("team.create");
        return { id: "t1", name: "n" };
      },
      findUnique: async () => null,
    },
    organization: {
      create: async () => {
        writes.push("organization.create");
        return { id: "o1" };
      },
    },
    ssoConnection: { findUnique: async () => null },
    evidence: {
      findUnique: async () => null,
      delete: async () => {
        writes.push("evidence.delete");
        return {};
      },
      update: async () => {
        writes.push("evidence.update");
        return {};
      },
    },
  } as never;
  return { prisma, writes };
}

// =============================================================================
// 1. The canonical decision — behavioural, per resolution state.
// =============================================================================

describe("canonical no-personal decision (personalSpaceAllowed)", () => {
  it("STANDARD → personal space ALLOWED", async () => {
    const { prisma } = identityStub(STANDARD_ROW);
    expect(await personalSpaceAllowed("u1", prisma)).toBe(true);
    await expect(assertPersonalSpaceAllowed("u1", prisma)).resolves.toBeUndefined();
  });

  it("MANAGED → personal space DENIED (403 MANAGED_IDENTITY_NO_PERSONAL_SPACE)", async () => {
    const { prisma, writes } = identityStub(MANAGED_ROW);
    expect(await personalSpaceAllowed("u1", prisma)).toBe(false);
    await expect(assertPersonalSpaceAllowed("u1", prisma)).rejects.toMatchObject(NO_PERSONAL);
    // custody invariant: reading the decision NEVER mutates.
    expect(writes).toEqual([]);
  });

  it("MANAGED_UNRESOLVED → personal space DENIED (fail closed, never STANDARD)", async () => {
    const { prisma, writes } = identityStub(MANAGED_UNRESOLVED_ROW);
    expect(await personalSpaceAllowed("u1", prisma)).toBe(false);
    await expect(assertPersonalSpaceAllowed("u1", prisma)).rejects.toMatchObject(NO_PERSONAL);
    expect(writes).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // PHASE 12 — POINT 7. The SECOND denial rule. Before this, `noPersonalSpace`
  // was a persisted, admin-settable, HIGH_SECURITY-activated column that
  // nothing read: `evaluatePersonalSpaceAllowed` had zero production callers,
  // so an Organization that switched the control on still handed every
  // STANDARD member a Personal Space and the server still fell back into one.
  // ---------------------------------------------------------------------------
  const ORG_POLICY_DENIAL = {
    statusCode: 403,
    code: "ORG_POLICY_NO_PERSONAL_SPACE",
  };

  it("STANDARD identity + org policy noPersonalSpace → personal space DENIED", async () => {
    const { prisma, writes } = identityStub(STANDARD_ROW, [
      { organizationId: "org-A", noPersonalSpace: true },
    ]);
    expect(await personalSpaceAllowed("u1", prisma)).toBe(false);
    await expect(assertPersonalSpaceAllowed("u1", prisma)).rejects.toMatchObject(
      ORG_POLICY_DENIAL,
    );
    expect(writes).toEqual([]);
  });

  it("the two denials are distinguishable: managed identity keeps its own code", async () => {
    const { prisma } = identityStub(MANAGED_ROW, [
      { organizationId: "org-A", noPersonalSpace: true },
    ]);
    // Both rules deny. The identity rule is evaluated first and owns the
    // answer, because an org-controlled identity is a different remediation
    // from an org-wide policy switch.
    await expect(assertPersonalSpaceAllowed("u1", prisma)).rejects.toMatchObject(
      NO_PERSONAL,
    );
  });

  it("org policy denies the BOOTSTRAP with zero workspace/org/membership mutation", async () => {
    const { prisma, writes } = identityStub(STANDARD_ROW, [
      { organizationId: "org-A", noPersonalSpace: true },
    ]);
    await expect(
      ensurePersonalWorkspace({ userId: "u1" }, prisma),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(writes).toEqual([]);
  });
});

// =============================================================================
// 2. Personal bootstrap surface — behavioural (injectable client).
// =============================================================================

describe("personal bootstrap surface (ensurePersonalWorkspace)", () => {
  it("MANAGED → denied, ZERO workspace/org/membership mutation", async () => {
    const { prisma, writes } = identityStub(MANAGED_ROW);
    await expect(
      ensurePersonalWorkspace({ userId: "u1" }, prisma),
    ).rejects.toMatchObject(NO_PERSONAL);
    // NO personal Team, NO SYSTEM org, NO membership write on denial.
    expect(writes).toEqual([]);
  });

  it("MANAGED_UNRESOLVED → denied (fail closed), ZERO mutation", async () => {
    const { prisma, writes } = identityStub(MANAGED_UNRESOLVED_ROW);
    await expect(
      ensurePersonalWorkspace({ userId: "u1" }, prisma),
    ).rejects.toMatchObject(NO_PERSONAL);
    expect(writes).toEqual([]);
  });

  it("STANDARD → passes the no-personal gate (decision authorizes bootstrap)", async () => {
    // The decision that guards the bootstrap create-path returns true for a
    // STANDARD identity; the heavy $transaction create path is exercised by
    // the existing bootstrap integration tests.
    const { prisma } = identityStub(STANDARD_ROW);
    expect(await personalSpaceAllowed("u1", prisma)).toBe(true);
  });
});

// =============================================================================
// 3. Source-contract — EVERY personal server surface routes through the gate.
// =============================================================================

const API_SRC = resolve(__dirname, "../src");
const read = (rel: string) => readFileSync(resolve(API_SRC, rel), "utf8");

/**
 * Each personal surface: the file that must enforce the gate, and the canonical
 * symbol it must reference. Bootstrap/export predate STEP 6 (personalSpaceAllowed
 * / assertPersonalExportAllowed); the STEP-6 surfaces use assertPersonalSpaceAllowed.
 */
const PERSONAL_SURFACES: ReadonlyArray<{
  surface: string;
  file: string;
  mustReference: RegExp;
}> = [
  {
    surface: "personal bootstrap",
    file: "services/platform-context/workspace-bootstrap.service.ts",
    mustReference: /personalSpaceAllowed|MANAGED_IDENTITY_NO_PERSONAL_SPACE/,
  },
  {
    surface: "personal Evidence create (funnel service)",
    file: "services/evidence.service.ts",
    mustReference: /assertPersonalSpaceAllowed/,
  },
  {
    surface: "personal capture draft",
    file: "routes/capture.routes.ts",
    mustReference: /assertPersonalSpaceAllowed/,
  },
  {
    surface: "personal Evidence finalize (/complete)",
    file: "routes/evidence.routes.ts",
    mustReference: /assertPersonalSpaceAllowed/,
  },
  {
    surface: "personal checkout / billing",
    file: "routes/billing.routes.ts",
    mustReference: /assertPersonalSpaceAllowed/,
  },
  {
    surface: "personal context establishment / switch",
    file: "routes/platform-context.routes.ts",
    mustReference: /assertPersonalSpaceAllowed/,
  },
  {
    surface: "personal data export",
    file: "routes/account-data-export.routes.ts",
    mustReference: /assertPersonalExportAllowed/,
  },
];

describe("source-contract: each personal surface references the canonical guard", () => {
  for (const s of PERSONAL_SURFACES) {
    it(`${s.surface} enforces the no-personal gate`, () => {
      const src = read(s.file);
      expect(src).toMatch(s.mustReference);
    });
  }
});

// =============================================================================
// 4. Zero-metric — no personal server surface BYPASSES the managed check.
// =============================================================================

describe("machine metric: server personal-surface no-personal bypasses = 0", () => {
  it("every enumerated personal surface routes through the canonical guard", () => {
    const bypasses = PERSONAL_SURFACES.filter((s) => !s.mustReference.test(read(s.file)));
    expect(bypasses.map((b) => b.surface)).toEqual([]);
    expect(bypasses.length).toBe(0);
  });

  it("the canonical guard is a THIN wrapper over the ONE decision (not a new resolver)", () => {
    const src = read("services/identity/identity-mode.service.ts");
    // POINT 7 — the one decision gained a second input (the Organization's
    // `noPersonalSpace` policy) and a discriminated result, so it is now
    // `resolvePersonalSpaceEligibility`; `personalSpaceAllowed` is its boolean
    // projection. The property being pinned is unchanged: the assert
    // DELEGATES and throws a bounded 403 — it does not re-implement
    // resolution.
    expect(src).toMatch(/export async function assertPersonalSpaceAllowed/);
    expect(src).toMatch(/resolvePersonalSpaceEligibility\(userId, client\)/);
    expect(src).toMatch(/MANAGED_IDENTITY_NO_PERSONAL_SPACE/);
    expect(src).toMatch(/ORG_POLICY_NO_PERSONAL_SPACE/);
    // The boolean projection is exactly that — one line delegating to the
    // decision, never a parallel resolution.
    expect(src).toMatch(
      /export async function personalSpaceAllowed[\s\S]{0,400}?return \(await resolvePersonalSpaceEligibility\(userId, client\)\)\.allowed;/,
    );
  });

  it("the finalize surface denies BEFORE completeEvidence (no personal mutation on denial)", () => {
    const src = read("routes/evidence.routes.ts");
    const guardAt = src.indexOf("NO-PERSONAL enforcement on FINALIZE");
    const completeAt = src.indexOf("await completeEvidence(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(completeAt).toBeGreaterThan(-1);
    // The guard is positioned ahead of the mutating completion call.
    expect(guardAt).toBeLessThan(completeAt);
  });
});
