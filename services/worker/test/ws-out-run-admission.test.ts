/**
 * WS-OUT / RG-03 — the worker's ONE run admission: closed workspaces (PRO-W1-03),
 * owed system re-issue (PRO-O1Z-01, DEC-03) and customer new versions after a
 * paid lapse (PRO-O1C-02). Same recording-client harness as
 * report-admission-commit-client.test.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const globalTouches = vi.hoisted(() => [] as string[]);

vi.mock("../src/db.js", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol" || key === "then") return undefined;
        globalTouches.push(String(key));
        throw new Error(`global prisma client touched inside a commit transaction: ${String(key)}`);
      },
    },
  ),
}));

const { assertRunAdmittedAtCommit, decideRunAdmission } = await import("../src/report-generation-authority.js");

type Responses = Record<string, unknown>;

/** A stand-in for `tx`: answers `model.method(args)` from a table and records every call. */
function recordingTx(responses: Responses) {
  const calls: string[] = [];
  const client = new Proxy(
    {},
    {
      get(_t, model) {
        if (typeof model === "symbol" || model === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_m, method) {
              if (typeof method === "symbol" || method === "then") return undefined;
              return async () => {
                const key = `${String(model)}.${String(method)}`;
                calls.push(key);
                return key in responses ? responses[key] : null;
              };
            },
          },
        );
      },
    },
  );
  return { client: client as never, calls };
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";

/** A paid (TEAM) OWNED workspace in an ACTIVE organization, no hold, no grant. */
const ADMITTING: Responses = {
  "evidenceCreditLedgerEntry.findUnique": null,
  "evidence.findUnique": { outputEarnedPlan: null, outputEarnedBasis: null },
  "team.findUnique": {
    id: WORKSPACE,
    ownerUserId: OWNER,
    organizationId: ORG,
    billingPlan: "TEAM",
    billingStatus: "ACTIVE",
    includedSeats: 1,
    storageBytesOverride: null,
    workspaceKind: "OWNED",
    isPersonal: false,
  },
  "team.findMany": [{ id: WORKSPACE, ownerUserId: OWNER }],
  "entitlement.findFirst": { plan: "PRO", credits: 0, teamSeats: 0 },
  "planGrant.findFirst": null,
  "workspaceStorageAddon.aggregate": { _sum: { extraStorageBytes: null } },
  "enterpriseContract.findUnique": null,
  "subscription.findMany": [{ status: "ACTIVE" }],
  "organization.findUnique": { status: "ACTIVE" },
  "caseEvidenceLink.findMany": [],
  "evidenceLegalHold.findMany": [],
};

const LIVE = {
  id: "44444444-4444-4444-8444-444444444444",
  teamId: WORKSPACE,
  ownerUserId: OWNER,
  status: "SIGNED",
  lifecycleState: "ACTIVE",
  deletedAt: null,
};

beforeEach(() => {
  globalTouches.length = 0;
});

const admit = (tx: { client: never }, extra: Record<string, unknown> = {}, evidence: Record<string, unknown> = {}) =>
  decideRunAdmission(
    {
      evidence: { ...LIVE, ...evidence } as never,
      requestTeamId: WORKSPACE,
      artifactType: "REPORT",
      forceRegenerate: false,
      ...extra,
    } as never,
    tx.client,
  );

describe("RG-03 — the run admission (WS-OUT)", () => {
  it("PRO-W1-03: a CLOSED workspace issues nothing (recoverable workspace_closed)", async () => {
    const team = ADMITTING["team.findUnique"] as Record<string, unknown>;
    const open = recordingTx(ADMITTING);
    expect((await admit(open)).kind).toBe("ADMITTED");
    const closed = recordingTx({ ...ADMITTING, "team.findUnique": { ...team, closedAtUtc: new Date("2026-11-01T00:00:00Z") } });
    expect(await admit(closed)).toEqual({ kind: "BLOCKED", reasonCode: "workspace_closed" });
  });

  it("PRO-O1Z-01 / DEC-03: a key-compromise replacement is admitted for a lapsed subject and under a legal hold; a customer regeneration is not", async () => {
    const lapsed = { ...ADMITTING, "subscription.findMany": [{ status: "ACTIVE" }, { status: "ACTIVE" }] /* two live rows: the reader fails closed to CANCELLED */ };
    const replacement = recordingTx({ ...lapsed, "evidenceLegalHold.findMany": [{ id: "h1", scope: "EVIDENCE", evidenceId: LIVE.id, status: "ACTIVE" }] });
    expect(
      await admit(replacement, { forceRegenerate: true, purpose: "signing_key_compromise_replacement" }),
    ).toMatchObject({ kind: "ADMITTED", entitlementResolved: true });
    const customer = recordingTx(lapsed);
    const decision = await admit(customer, { forceRegenerate: true, purpose: "updated_report" });
    expect(decision.kind).not.toBe("ADMITTED");
  });

  it("PRO-O1C-02: a PAID earned fact keeps owed issuance after a lapse, but not a customer new version", async () => {
    const earnedLapsed = {
      ...ADMITTING,
      "evidence.findUnique": { outputEarnedPlan: "TEAM", outputEarnedBasis: "PAID_SUBSCRIPTION" },
      "subscription.findMany": [{ status: "ACTIVE" }, { status: "ACTIVE" }] /* two live rows: the reader fails closed to CANCELLED */,
    };
    expect((await admit(recordingTx(earnedLapsed), { purpose: "missing_output_recovery" })).kind).toBe("ADMITTED");
    expect(await admit(recordingTx(earnedLapsed), { forceRegenerate: true, purpose: "updated_report" })).toEqual({
      kind: "REFUSED",
      refusal: "NOT_APPLICABLE_NOT_ENTITLED",
    });
  });
});
