/**
 * PHASE 10 §0B correction (2026-07-23) — SCHEMA UNAVAILABILITY FAILS CLOSED.
 *
 * A missing Phase-10 identity table/column (Prisma P2021/P2022) or an absent
 * client field is SCHEMA UNAVAILABILITY, NOT evidence the identity is STANDARD.
 * Every Phase-10 identity/security resolver + every consuming seam FAILS CLOSED
 * with zero mutation. Deployment order is schema-before-code.
 *
 * Machine metrics enforced here:
 *   - P2021→STANDARD branches = 0
 *   - P2022→STANDARD branches = 0
 *   - schema-unavailable→STANDARD / migration-window allow-default branches = 0
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveManagedIdentity,
  isManagedEnterprise,
  isManagedByOrganization,
  personalSpaceAllowed,
  assertPersonalExportAllowed,
  setManagedIdentity,
  releaseManagedIdentity,
} from "../src/services/identity/identity-mode.service.js";

const API = resolve(__dirname, "..");

/** A prisma whose user.findUnique throws the given Prisma error code. */
function schemaMissing(code: string) {
  const writes: string[] = [];
  const prisma = {
    user: {
      findUnique: async () => { const e = new Error("schema") as Error & { code?: string }; e.code = code; throw e; },
      update: async () => { writes.push("user.update"); return {}; },
    },
    // Also schema-unavailable so the SCIM evidence DB-load fails closed (503).
    scimProvisioningToken: {
      findUnique: async () => { const e = new Error("schema") as Error & { code?: string }; e.code = code; throw e; },
    },
  } as never;
  return { prisma, writes };
}

const SCHEMA_ERR = { code: "SECURITY_SCHEMA_UNAVAILABLE", statusCode: 503 };

describe("§0B — every identity resolver seam fails closed on P2021/P2022", () => {
  for (const code of ["P2021", "P2022"]) {
    it(`resolveManagedIdentity → 503 (not STANDARD) [${code}]`, async () => {
      const { prisma } = schemaMissing(code);
      await expect(resolveManagedIdentity("u1", prisma)).rejects.toMatchObject(SCHEMA_ERR);
    });

    it(`isManagedEnterprise / isManagedByOrganization → 503 [${code}]`, async () => {
      const { prisma } = schemaMissing(code);
      await expect(isManagedEnterprise("u1", prisma)).rejects.toMatchObject(SCHEMA_ERR);
      await expect(isManagedByOrganization("u1", "org-A", prisma)).rejects.toMatchObject(SCHEMA_ERR);
    });

    it(`Personal bootstrap gate (personalSpaceAllowed) → 503, no mutation [${code}]`, async () => {
      const { prisma, writes } = schemaMissing(code);
      await expect(personalSpaceAllowed("u1", prisma)).rejects.toMatchObject(SCHEMA_ERR);
      expect(writes).toEqual([]);
    });

    it(`Personal export gate (assertPersonalExportAllowed) → 503, no mutation [${code}]`, async () => {
      const { prisma, writes } = schemaMissing(code);
      await expect(assertPersonalExportAllowed("u1", prisma)).rejects.toMatchObject(SCHEMA_ERR);
      expect(writes).toEqual([]);
    });

    it(`managed provisioning seam (setManagedIdentity) → 503, ZERO identity write [${code}]`, async () => {
      const { prisma, writes } = schemaMissing(code);
      // setManagedIdentity DB-verifies SCIM evidence first; the connection read
      // fails closed on schema unavailability (503) → never reaches the write.
      await expect(
        setManagedIdentity({ userId: "u1", managingOrganizationId: "org-A", evidence: { source: "SCIM", scimTokenId: "tok-A" } }, prisma),
      ).rejects.toMatchObject(SCHEMA_ERR);
      expect(writes).toEqual([]);
    });

    it(`deprovision seam (releaseManagedIdentity) → 503, ZERO write [${code}]`, async () => {
      const { prisma, writes } = schemaMissing(code);
      await expect(
        releaseManagedIdentity({ userId: "u1", managingOrganizationId: "org-A" }, prisma),
      ).rejects.toMatchObject(SCHEMA_ERR);
      expect(writes).toEqual([]);
    });
  }

  it("an absent client field (Unknown field) also fails closed", async () => {
    const prisma = {
      user: { findUnique: async () => { throw new Error("Unknown field `managingOrganizationId` for select statement on model User"); }, update: async () => ({}) },
      ssoConnection: { findUnique: async () => null },
    } as never;
    await expect(resolveManagedIdentity("u1", prisma)).rejects.toMatchObject(SCHEMA_ERR);
  });
});

// ── machine metric: no schema-absence → STANDARD anywhere in identity/security ─
describe("§0B — machine metric: schema-absence NEVER resolves to STANDARD", () => {
  const SRC = readFileSync(resolve(API, "src/services/identity/identity-mode.service.ts"), "utf8");

  it("identity-mode.service.ts has no P2021/P2022 → STANDARD branch (code, not comments)", () => {
    // Strip block + line comments so the metric checks REAL code only.
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // No code path returns "STANDARD" in proximity to a P2021/P2022 test.
    expect(code).not.toMatch(/P202[12][\s\S]{0,160}STANDARD/);
    expect(code).not.toMatch(/STANDARD[\s\S]{0,160}P202[12]/);
    // The dead fail-open `resolveIdentityMode` is gone.
    expect(code).not.toMatch(/export async function resolveIdentityMode/);
    // Schema-absence is turned into the typed 503, and it fails closed.
    expect(code).toMatch(/SECURITY_SCHEMA_UNAVAILABLE/);
    expect(code).toMatch(/securitySchemaUnavailable/);
  });
});

// ── §3 — deployment order is locked (schema before code) ───────────────────
describe("§3 — deployment order: schema before code", () => {
  const SRC = readFileSync(resolve(API, "src/services/identity/identity-mode.service.ts"), "utf8");

  it("the resolver documents schema-before-code + does not weaken security for code-first", () => {
    expect(SRC).toMatch(/schema BEFORE code|schema-before-code/i);
    // The authored (unapplied) Phase-10 identity migrations exist.
    for (const m of [
      "20270925000000_user_identity_mode",
      "20271002000000_managed_identity_ownership",
      "20271003000000_managed_identity_ownership_backfill",
    ]) {
      expect(() =>
        readFileSync(resolve(API, `prisma/migrations/${m}/migration.sql`), "utf8"),
      ).not.toThrow();
    }
  });
});
