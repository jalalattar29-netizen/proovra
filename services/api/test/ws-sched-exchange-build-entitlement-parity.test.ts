/**
 * WS-SCHED / PRO-W1-07 — the Worker's re-read of FEATURE_EVIDENCE_EXCHANGE at
 * build claim (`readEvidenceExchangeEntitlement`, @proovra/shared-runtime) is
 * the API engine's answer (`resolveEntitlement`) for that key, over every
 * combination of Enterprise standing and stored grant. The Worker cannot import
 * the engine; this pin is what keeps its reader from becoming a second opinion.
 * Also pins the capacity lock key the Worker's storage reservation takes
 * (PRO-W1-06) to the one the API's admission and completion take.
 */
import { describe, expect, it } from "vitest";
import {
  readEvidenceExchangeEntitlement,
  workspaceCapacityLockKey,
  type EnterpriseContractStanding,
} from "@proovra/shared-runtime";

import { resolveEntitlement } from "../src/services/packaging/entitlement.service.js";
import { commercialPrincipalOf } from "../src/services/workspace-billing.service.js";

const TEAM = "22222222-2222-4222-8222-222222222222";
const NOW = Date.now();

type Grant = { kind: string; valueBool: boolean | null; valueNumber: bigint | null; expiresAtUtc: Date | null } | null;

const GRANTS: Array<[string, Grant]> = [
  ["no stored grant", null],
  ["granted", { kind: "FEATURE", valueBool: true, valueNumber: null, expiresAtUtc: null }],
  ["granted, expiring later", { kind: "FEATURE", valueBool: true, valueNumber: null, expiresAtUtc: new Date(NOW + 86_400_000) }],
  ["granted, expired", { kind: "FEATURE", valueBool: true, valueNumber: null, expiresAtUtc: new Date(NOW - 1000) }],
  ["stored as false", { kind: "FEATURE", valueBool: false, valueNumber: null, expiresAtUtc: null }],
  ["stored as false, expired", { kind: "FEATURE", valueBool: false, valueNumber: null, expiresAtUtc: new Date(NOW - 1000) }],
  ["stored with no value", { kind: "FEATURE", valueBool: null, valueNumber: null, expiresAtUtc: null }],
  ["stored under a QUOTA kind", { kind: "QUOTA", valueBool: true, valueNumber: 1n, expiresAtUtc: null }],
];
const STANDINGS: EnterpriseContractStanding[] = ["NOT_ENTERPRISE", "CONTRACT_ACTIVE", "CONTRACT_LAPSED"];

// PRO-R3-07 (matrix review NEW-RG-13-2) — the grant's source matters: a
// product-line (PLAN) grant does not outlive a terminally lapsed paid
// subscription; a CUSTOM (operator) grant does.
const SOURCES = ["CUSTOM", "PLAN"] as const;
const PAID_LAPSED = [false, true] as const;

const fakePrisma = (grant: Grant, source: (typeof SOURCES)[number] = "CUSTOM") =>
  ({
    entitlementGrant: {
      findUnique: async () =>
        grant
          ? {
              id: "g1",
              key: "FEATURE_EVIDENCE_EXCHANGE",
              source,
              productLine: null,
              grantedAtUtc: new Date(NOW - 3_600_000),
              ...grant,
            }
          : null,
    },
  }) as never;

describe("PRO-W1-07 — the Worker's exchange entitlement re-read equals the API engine", () => {
  for (const standing of STANDINGS) {
    for (const [name, grant] of GRANTS) {
      for (const source of SOURCES) {
        for (const paidLapsed of PAID_LAPSED) {
          it(`${standing} / ${name} / ${source} grant / paid ${paidLapsed ? "lapsed" : "current"}`, async () => {
            const engine = await resolveEntitlement({
              prisma: fakePrisma(grant, source),
              teamId: TEAM,
              key: "FEATURE_EVIDENCE_EXCHANGE",
              standing,
              paidLapsed,
            });
            const worker = await readEvidenceExchangeEntitlement(fakePrisma(grant, source), {
              teamId: TEAM,
              standing,
              paidLapsed,
            });
            expect(worker).toBe(engine.value === true);
          });
        }
      }
    }
  }

  it("NEW-RG-13-2: a PLAN grant admits no build after a terminal paid lapse (and does again once paid)", async () => {
    const granted: Grant = { kind: "FEATURE", valueBool: true, valueNumber: null, expiresAtUtc: null };
    expect(
      await readEvidenceExchangeEntitlement(fakePrisma(granted, "PLAN"), { teamId: TEAM, standing: "NOT_ENTERPRISE", paidLapsed: true }),
    ).toBe(false);
    expect(
      await readEvidenceExchangeEntitlement(fakePrisma(granted, "PLAN"), { teamId: TEAM, standing: "NOT_ENTERPRISE", paidLapsed: false }),
    ).toBe(true);
    // An operator (CUSTOM) grant is not a product line of the lapsed subscription.
    expect(
      await readEvidenceExchangeEntitlement(fakePrisma(granted, "CUSTOM"), { teamId: TEAM, standing: "NOT_ENTERPRISE", paidLapsed: true }),
    ).toBe(true);
  });

  it("the matrix covers both answers (the pin is not vacuous)", async () => {
    const answers = new Set<boolean>();
    for (const standing of STANDINGS) {
      for (const [, grant] of GRANTS) {
        answers.add(await readEvidenceExchangeEntitlement(fakePrisma(grant), { teamId: TEAM, standing }));
      }
    }
    expect([...answers].sort()).toEqual([false, true]);
  });
});

describe("PRO-W1-06 — the Worker reserves under the API's capacity lock", () => {
  const OWNER = "11111111-1111-4111-8111-111111111111";
  it("one key per payer on both hosts", () => {
    for (const scope of [
      { billingShape: "SINGLE_OCCUPANT" as const, ownerUserId: OWNER, teamId: null },
      { billingShape: "SINGLE_OCCUPANT" as const, ownerUserId: OWNER, teamId: TEAM },
      { billingShape: "SHARED" as const, ownerUserId: OWNER, teamId: TEAM },
    ]) {
      expect(workspaceCapacityLockKey(scope)).toBe(`evidence-capacity:${commercialPrincipalOf(scope)}`);
    }
    expect(() => workspaceCapacityLockKey({ billingShape: "SHARED", ownerUserId: OWNER, teamId: null })).toThrow();
  });
});
