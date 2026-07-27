/**
 * PHASE 4 (2026-07-22) — canonical Enterprise contract state (§7.2).
 *
 * Behavioral: `resolveEnterpriseContract`
 *   * CUSTOMER org with a contract row → canonical projection;
 *   * CUSTOMER org without a row → LEGACY fallback (legacyDerived: true)
 *     from the same deterministic signals the backfill uses;
 *   * SYSTEM org → null (never a customer contract);
 *   * missing org → null.
 *
 * Source contracts: every enterprise activation path writes the contract:
 *   existing-owner provisioning → ACTIVE/ACTIVATED;
 *   pending-owner provisioning  → PENDING_ACTIVATION/OWNER_INVITED;
 *   owner-invite acceptance     → ACTIVE/ACTIVATED (+ contract owner);
 *   admin plan grant            → ACTIVE/ACTIVATED.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  org: null as Record<string, unknown> | null,
  contractRow: null as Record<string, unknown> | null,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    organization: {
      findUnique: async () => H.org,
    },
    enterpriseContract: {
      findUnique: async () => H.contractRow,
      upsert: async () => ({}),
    },
  },
}));

import { resolveEnterpriseContract } from "../src/services/organization/enterprise-contract.service.js";

beforeEach(() => {
  H.org = null;
  H.contractRow = null;
});

describe("Phase 4 — resolveEnterpriseContract", () => {
  it("CUSTOMER org with contract row → canonical projection (not legacy)", async () => {
    H.org = {
      id: "o1", kind: "CUSTOMER", status: "ACTIVE",
      createdAt: new Date("2026-01-01"), billingOwnerUserId: "u1",
      pendingEnterpriseSeats: 10,
    };
    H.contractRow = {
      status: "ACTIVE", activationState: "ACTIVATED",
      effectiveAtUtc: new Date("2026-02-01"), endsAtUtc: null,
      seatCount: 50, storageGb: 500, region: "eu-central",
      planVersion: "2026-1", billingCustomerRef: "cus_1",
      billingSubscriptionRef: "sub_1", contractOwnerUserId: "u2",
    };
    const c = await resolveEnterpriseContract("o1");
    expect(c).toMatchObject({
      status: "ACTIVE",
      seatCount: 50, // the ROW wins over pendingEnterpriseSeats
      region: "eu-central",
      contractOwnerUserId: "u2",
      legacyDerived: false,
    });
  });

  it("CUSTOMER org without a row → LEGACY fallback from deterministic signals", async () => {
    H.org = {
      id: "o1", kind: "CUSTOMER", status: "ACTIVE",
      createdAt: new Date("2026-01-01"), billingOwnerUserId: "u1",
      pendingEnterpriseSeats: 25,
    };
    const c = await resolveEnterpriseContract("o1");
    expect(c).toMatchObject({
      status: "ACTIVE",
      seatCount: 25,
      contractOwnerUserId: "u1",
      legacyDerived: true,
    });
  });

  it("SYSTEM org → null (containers have no customer contract)", async () => {
    H.org = {
      id: "o1", kind: "SYSTEM", status: "ACTIVE",
      createdAt: new Date(), billingOwnerUserId: "u1",
      pendingEnterpriseSeats: null,
    };
    expect(await resolveEnterpriseContract("o1")).toBeNull();
  });

  it("missing org → null; SUSPENDED CUSTOMER legacy fallback → SUSPENDED", async () => {
    expect(await resolveEnterpriseContract("nope")).toBeNull();
    H.org = {
      id: "o1", kind: "CUSTOMER", status: "SUSPENDED",
      createdAt: new Date(), billingOwnerUserId: null,
      pendingEnterpriseSeats: null,
    };
    const c = await resolveEnterpriseContract("o1");
    expect(c).toMatchObject({ status: "SUSPENDED", legacyDerived: true });
  });
});

describe("Phase 4 — every enterprise activation path writes the contract", () => {
  const SRC = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "services",
      "enterprise-provisioning.service.ts",
    ),
    "utf8",
  );

  it("four upsertEnterpriseContract sites with the right states", () => {
    const sites = SRC.match(/upsertEnterpriseContract\(tx,/g) ?? [];
    expect(sites.length).toBe(4);
    expect(SRC).toMatch(/status:\s*"PENDING_ACTIVATION",\s*\r?\n\s*activationState:\s*"OWNER_INVITED"/);
    const activeSites = SRC.match(/status:\s*"ACTIVE",\s*\r?\n\s*\s*activationState:\s*"ACTIVATED"/g) ?? [];
    expect(activeSites.length).toBe(3);
  });
});
