/**
 * AUD-0017 (TXP-023 / TXP-024) — THE COMMIT-TIME RUN ADMISSION READS ON THE
 * COMMIT TRANSACTION'S CONNECTION.
 *
 * The report commit (processor.ts) and the package commit (package-issuance.ts)
 * hold an interactive transaction — one pooled connection, under the record's
 * advisory lock — and re-ask the run admission inside it. The admission used to
 * read the entitlement inputs, the record's workspace, its organization and the
 * legal hold on the worker's GLOBAL client: each commit then waited for a second
 * connection while holding the first, and at a concurrency equal to the pool
 * size every commit waited on every other (P2028 / transaction timeout).
 *
 * Here the global client throws on any touch, and a recording fake stands in
 * for `tx`: every admission read must land on the fake, and both commit sites
 * must hand their `tx` over.
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

describe("AUD-0017 TXP-023/024 — the commit-time admission reads on the client it is given", () => {
  it("a first generation: entitlement, workspace and organization are all read on tx; the global client is never touched", async () => {
    const tx = recordingTx(ADMITTING);
    await expect(
      assertRunAdmittedAtCommit({ teamId: WORKSPACE, artifactType: "REPORT", forceRegenerate: false }, LIVE, tx.client),
    ).resolves.toBeUndefined();
    expect(globalTouches).toEqual([]);
    // The entitlement inputs (funding, earned fact, scope, lifecycle) …
    expect(tx.calls).toEqual(
      expect.arrayContaining([
        "evidenceCreditLedgerEntry.findUnique",
        "evidence.findUnique",
        "entitlement.findFirst",
        "planGrant.findFirst",
        "workspaceStorageAddon.aggregate",
        "subscription.findMany",
        // … the record's workspace and its organization.
        "team.findUnique",
        "organization.findUnique",
      ]),
    );
  });

  it("a regeneration of a Personal record (team_id NULL): the workspace resolution and the legal hold read on tx too", async () => {
    const tx = recordingTx(ADMITTING);
    const admission = await decideRunAdmission(
      {
        evidence: { ...LIVE, teamId: null },
        requestTeamId: WORKSPACE,
        artifactType: "VERIFICATION_PACKAGE",
        forceRegenerate: true,
      },
      tx.client,
    );
    expect(admission).toEqual({ kind: "ADMITTED", workspaceId: WORKSPACE, entitlementResolved: true });
    expect(globalTouches).toEqual([]);
    expect(tx.calls).toEqual(
      expect.arrayContaining(["team.findMany", "organization.findUnique", "evidenceLegalHold.findMany"]),
    );
  });

  it("the decision is unchanged: a suspended organization still blocks, read on tx", async () => {
    const tx = recordingTx({ ...ADMITTING, "organization.findUnique": { status: "SUSPENDED" } });
    await expect(
      assertRunAdmittedAtCommit({ teamId: WORKSPACE, artifactType: "REPORT", forceRegenerate: false }, LIVE, tx.client),
    ).rejects.toMatchObject({ name: "OutputPolicyBlockedError", reasonCode: "organization_not_active" });
    expect(
      await decideRunAdmission(
        { evidence: LIVE, requestTeamId: WORKSPACE, artifactType: "REPORT", forceRegenerate: false },
        tx.client,
      ),
    ).toEqual({ kind: "BLOCKED", reasonCode: "organization_not_active" });
    expect(globalTouches).toEqual([]);
  });

  it("both commit transactions hand their tx to the admission", () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    // TXP-023 — the report commit.
    expect(read("../src/processor.ts")).toMatch(/assertRunAdmittedAtCommit\(\s*command,\s*live!?,\s*tx\s*\)/);
    // TXP-024 — the package commit.
    expect(read("../src/package-issuance.ts")).toMatch(/assertRunAdmittedAtCommit\(\s*asked,\s*live!?,\s*tx\s*\)/);
  });
});
