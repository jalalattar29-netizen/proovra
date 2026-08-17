/**
 * PHASE 12B CLUSTER 8 — Legal-Hold convergence matrix.
 *
 * ONE suite proves the whole domain authority:
 *
 *   1. the ten migration cases the backfill must handle;
 *   2. the union destruction gate, including FAIL-CLOSED behaviour;
 *   3. step-up on every placement and release surface;
 *   4. the release-approval gate;
 *   5. optimistic concurrency;
 *   6. cross-workspace denial;
 *   7. the invariant that matters most — NO EVIDENCE BECOMES DESTRUCTIBLE.
 *
 * WHAT IS MOCKED: the Prisma TRANSPORT (an in-memory row store), the custody
 * sink and the webhook sink. The authority under proof — the effective-hold
 * evaluator and the canonical placement/release commands — is the real code.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/custody-events.service.js", () => ({
  appendCustodyEvent: vi.fn(async () => null),
  appendCustodyEventTx: vi.fn(async () => null),
}));
vi.mock("../src/services/integrations/webhook-dispatcher.js", () => ({
  emitWebhookEvent: vi.fn(async () => null),
}));

import {
  evaluateEffectiveLegalHold,
  isAbsentRelationError,
} from "../src/services/governance/effective-legal-hold.js";
import {
  placeCanonicalLegalHold,
  releaseCanonicalLegalHold,
} from "../src/services/governance/legal-hold.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_API = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(REPO_API, "../..");

function readFile(p: string): string {
  return fs.readFileSync(p, "utf8");
}
function readMigration(folder: string): string {
  return readFile(
    path.join(REPO_API, "prisma/migrations", folder, "migration.sql"),
  );
}

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "99999999-9999-4999-8999-999999999999";
const EVIDENCE = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_B = "2b2b2b2b-2222-4222-8222-222222222222";
const CASE = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// In-memory Prisma TRANSPORT.
//
// Deliberately dumb: it stores rows and answers the exact predicate shapes the
// production code builds. It contains NO hold logic — every decision in these
// tests is made by the real evaluator / real service.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type WorldOptions = {
  /** Throw this from a given model's read. Used to prove fail-closed. */
  failOn?: Partial<
    Record<
      "evidenceLegalHold" | "caseLegalHold" | "legalHold" | "caseEvidenceLink",
      unknown
    >
  >;
};

function matchesWhere(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = cond as Row[];
      if (!clauses.some((c) => matchesWhere(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Row;
      if ("in" in c) {
        if (!(c["in"] as unknown[]).includes(value)) return false;
        continue;
      }
      if ("not" in c) {
        if (c["not"] === null ? value === null : value === c["not"]) return false;
        continue;
      }
      return false;
    }
    if (value !== cond) return false;
  }
  return true;
}

function makeWorld(seed: {
  evidence?: Row[];
  cases?: Row[];
  teams?: Row[];
  policies?: Row[];
  links?: Row[];
  evidenceLegalHolds?: Row[];
  caseLegalHolds?: Row[];
  legalHolds?: Row[];
  options?: WorldOptions;
}) {
  const state = {
    evidence: seed.evidence ?? [{ id: EVIDENCE, teamId: TEAM }],
    cases: seed.cases ?? [{ id: CASE, teamId: TEAM }],
    teams: seed.teams ?? [{ id: TEAM, organizationId: null }],
    policies: seed.policies ?? [],
    links: seed.links ?? [],
    evidenceLegalHolds: seed.evidenceLegalHolds ?? [],
    caseLegalHolds: seed.caseLegalHolds ?? [],
    legalHolds: seed.legalHolds ?? [],
  };
  const fail = seed.options?.failOn ?? {};

  function reader(bucket: Row[], model: keyof typeof fail) {
    return {
      findMany: async (args?: { where?: Row }) => {
        if (fail[model]) throw fail[model];
        return bucket.filter((r) => matchesWhere(r, args?.where ?? {}));
      },
      findFirst: async (args?: { where?: Row }) => {
        if (fail[model]) throw fail[model];
        return bucket.find((r) => matchesWhere(r, args?.where ?? {})) ?? null;
      },
      count: async (args?: { where?: Row }) => {
        if (fail[model]) throw fail[model];
        return bucket.filter((r) => matchesWhere(r, args?.where ?? {})).length;
      },
    };
  }

  const client = {
    __state: state,
    evidence: {
      findUnique: async (args: { where: Row }) =>
        state.evidence.find((r) => matchesWhere(r, args.where)) ?? null,
      findMany: async (args?: { where?: Row }) =>
        state.evidence.filter((r) => matchesWhere(r, args?.where ?? {})),
    },
    case: {
      findUnique: async (args: { where: Row }) =>
        state.cases.find((r) => matchesWhere(r, args.where)) ?? null,
    },
    team: {
      findUnique: async (args: { where: Row }) =>
        state.teams.find((r) => matchesWhere(r, args.where)) ?? null,
    },
    workspaceGovernancePolicy: {
      findUnique: async (args: { where: Row }) =>
        state.policies.find((r) => matchesWhere(r, args.where)) ?? null,
    },
    caseEvidenceLink: reader(state.links, "caseEvidenceLink"),
    caseLegalHold: {
      ...reader(state.caseLegalHolds, "caseLegalHold"),
      update: async (args: { where: Row; data: Row }) => {
        const row = state.caseLegalHolds.find((r) => matchesWhere(r, args.where));
        if (row) Object.assign(row, args.data);
        return row;
      },
    },
    legalHold: {
      ...reader(state.legalHolds, "legalHold"),
      update: async (args: { where: Row; data: Row }) => {
        const row = state.legalHolds.find((r) => matchesWhere(r, args.where));
        if (row) Object.assign(row, args.data);
        return row;
      },
    },
    evidenceLegalHold: {
      ...reader(state.evidenceLegalHolds, "evidenceLegalHold"),
      findUnique: async (args: { where: Row }) =>
        state.evidenceLegalHolds.find((r) => matchesWhere(r, args.where)) ?? null,
      create: async (args: { data: Row }) => {
        const row: Row = {
          id: `hold-${state.evidenceLegalHolds.length + 1}`,
          placedAtUtc: new Date(),
          releasedAtUtc: null,
          releasedByUserId: null,
          releaseNote: null,
          releaseApprovedByUserId: null,
          releaseApprovedAtUtc: null,
          historical: false,
          ...args.data,
        };
        state.evidenceLegalHolds.push(row);
        return row;
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        const rows = state.evidenceLegalHolds.filter((r) =>
          matchesWhere(r, args.where),
        );
        for (const r of rows) Object.assign(r, args.data);
        return { count: rows.length };
      },
    },
  };
  return client as unknown as import("@prisma/client").PrismaClient & {
    __state: typeof state;
  };
}

function activeCanonical(overrides: Row = {}): Row {
  return {
    id: "canon-1",
    teamId: TEAM,
    scope: "EVIDENCE",
    evidenceId: EVIDENCE,
    caseId: null,
    organizationId: null,
    title: "Hold",
    reason: null,
    status: "ACTIVE",
    placedByUserId: USER,
    placedAtUtc: new Date(),
    releasedByUserId: null,
    releasedAtUtc: null,
    releaseNote: null,
    expiresAtUtc: null,
    releaseApprovalRequired: false,
    releaseApprovalState: "NOT_REQUIRED",
    releaseApprovedByUserId: null,
    releaseApprovedAtUtc: null,
    policyVersionAttribution: null,
    version: 1,
    sourceStore: "EVIDENCE_LEGAL_HOLD",
    sourceRowId: null,
    historical: false,
    ...overrides,
  };
}

// ===========================================================================
// 1 — THE UNION GATE
// ===========================================================================

describe("PHASE 12B CLUSTER 8 — union effective-hold gate", () => {
  it("blocks on an evidence-direct hold in the canonical store", async () => {
    const client = makeWorld({ evidenceLegalHolds: [activeCanonical()] });
    const r = await evaluateEffectiveLegalHold(client, {
      teamId: TEAM,
      evidenceId: EVIDENCE,
    });
    expect(r.held).toBe(true);
    expect(r.reasonCode).toBe("EVIDENCE_HOLD");
    expect(r.sources).toContain("EVIDENCE_LEGAL_HOLD");
  });

  it("blocks on a CASE-scoped canonical hold covering a LINKED case", async () => {
    const client = makeWorld({
      links: [{ evidenceId: EVIDENCE, caseId: CASE }],
      evidenceLegalHolds: [
        activeCanonical({ scope: "CASE", evidenceId: null, caseId: CASE }),
      ],
    });
    const r = await evaluateEffectiveLegalHold(client, {
      teamId: TEAM,
      evidenceId: EVIDENCE,
    });
    expect(r.held).toBe(true);
    expect(r.reasonCode).toBe("CASE_HOLD");
  });

  it("blocks on a WORKSPACE-scoped canonical hold with no target", async () => {
    const client = makeWorld({
      evidenceLegalHolds: [
        activeCanonical({ scope: "WORKSPACE", evidenceId: null, caseId: null }),
      ],
    });
    const r = await evaluateEffectiveLegalHold(client, {
      teamId: TEAM,
      evidenceId: EVIDENCE,
    });
    expect(r.held).toBe(true);
    expect(r.reasonCode).toBe("WORKSPACE_HOLD");
  });

  it("blocks on a converted CASE-scoped hold (was store 2)", async () => {
    const client = makeWorld({
      links: [{ evidenceId: EVIDENCE, caseId: CASE }],
      evidenceLegalHolds: [
        activeCanonical({
          id: "clh-1",
          scope: "CASE",
          caseId: CASE,
          evidenceId: null,
          sourceStore: "CASE_LEGAL_HOLD",
        }),
      ],
    });
    const r = await evaluateEffectiveLegalHold(client, {
      teamId: TEAM,
      evidenceId: EVIDENCE,
    });
    expect(r.held).toBe(true);
    // One store now; the meaningful discriminator is the matched SCOPE.
    expect(r.sources).toContain("EVIDENCE_LEGAL_HOLD");
    expect(r.matches.map((m) => m.scope)).toContain("CASE");
  });

  it("blocks on a converted scope-generic hold (was store 3)", async () => {
    const client = makeWorld({
      evidenceLegalHolds: [
        activeCanonical({
          id: "lh-1",
          scope: "EVIDENCE",
          evidenceId: EVIDENCE,
          sourceStore: "LIFECYCLE_LEGAL_HOLD",
        }),
      ],
    });
    const r = await evaluateEffectiveLegalHold(client, {
      teamId: TEAM,
      evidenceId: EVIDENCE,
    });
    expect(r.held).toBe(true);
    expect(r.sources).toContain("EVIDENCE_LEGAL_HOLD");
    expect(r.matches.map((m) => m.scope)).toContain("EVIDENCE");
  });

  it("does NOT block when no store holds the record", async () => {
    const client = makeWorld({});
    const r = await evaluateEffectiveLegalHold(client, {
      teamId: TEAM,
      evidenceId: EVIDENCE,
    });
    expect(r.held).toBe(false);
    expect(r.reasonCode).toBeNull();
  });

  it("a RELEASED hold does not block", async () => {
    const client = makeWorld({
      // All three RELEASED — one per originating store — so the assertion
      // proves a released hold blocks nothing, whichever store it came from.
      evidenceLegalHolds: [
        activeCanonical({ status: "RELEASED" }),
        activeCanonical({
          id: "clh-1",
          scope: "CASE",
          caseId: CASE,
          evidenceId: null,
          status: "RELEASED",
          sourceStore: "CASE_LEGAL_HOLD",
        }),
        activeCanonical({
          id: "lh-1",
          scope: "WORKSPACE",
          evidenceId: null,
          status: "RELEASED",
          sourceStore: "LIFECYCLE_LEGAL_HOLD",
        }),
      ],
      links: [{ evidenceId: EVIDENCE, caseId: CASE }],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(false);
  });

  it("an ACTIVE HISTORICAL hold with an unresolvable target FAILS CLOSED", async () => {
    // An orphaned hold's reach cannot be proven, so it must block rather than
    // fall through to "not held". A frozen workspace is recoverable;
    // destroyed evidence is not.
    for (const scope of ["EVIDENCE", "CASE", "WORKSPACE"] as const) {
      const client = makeWorld({
        evidenceLegalHolds: [
          activeCanonical({
            scope,
            evidenceId: null,
            caseId: null,
            historical: true,
          }),
        ],
      });
      const r = await evaluateEffectiveLegalHold(client, {
        teamId: TEAM,
        evidenceId: EVIDENCE,
      });
      expect(r.held, `orphaned ${scope} hold must block`).toBe(true);
      expect(r.reasonCode).toBe("UNRESOLVED_HOLD");
      expect(r.matches[0]?.unresolved).toBe(true);
    }
  });

  it("a RELEASED historical hold does not block", async () => {
    const client = makeWorld({
      evidenceLegalHolds: [
        activeCanonical({
          scope: "WORKSPACE",
          evidenceId: null,
          caseId: null,
          historical: true,
          status: "RELEASED",
        }),
      ],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(false);
  });

  it("an EXPIRED historical hold does not block", async () => {
    const client = makeWorld({
      evidenceLegalHolds: [
        activeCanonical({
          scope: "WORKSPACE",
          evidenceId: null,
          caseId: null,
          historical: true,
          status: "EXPIRED",
        }),
      ],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(false);
  });

  it("an orphan in ANOTHER tenant never blocks this one", async () => {
    const client = makeWorld({
      evidenceLegalHolds: [
        activeCanonical({
          teamId: OTHER_TEAM,
          scope: "WORKSPACE",
          evidenceId: null,
          caseId: null,
          historical: true,
        }),
      ],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(false);
  });

  it("scope is NEVER inferred from a NULL target — no clause filters evidenceId: null", () => {
    const evaluator = readFile(
      path.join(REPO_API, "src/services/governance/effective-legal-hold.ts"),
    );
    // A `evidenceId: null` predicate would make every workspace hold match on
    // the absence of a target instead of on `scope`, which is exactly the
    // widening that turns one mis-scoped row into a tenant-wide match.
    // Scanned over the executable body only — the header comment discusses it.
    const body = evaluator.slice(
      evaluator.indexOf("export async function evaluateEffectiveLegalHold"),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/evidenceId:\s*null/);
    expect(body).toMatch(/scope: "WORKSPACE"/);
  });

  it("a CASE-scoped hold does NOT block evidence linked to a DIFFERENT case", async () => {
    const OTHER_CASE = "3c3c3c3c-3333-4333-8333-333333333333";
    const client = makeWorld({
      links: [{ evidenceId: EVIDENCE, caseId: OTHER_CASE }],
      evidenceLegalHolds: [
        activeCanonical({ scope: "CASE", evidenceId: null, caseId: CASE }),
      ],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(false);
  });

  it("a CASE-scoped hold does NOT block UNLINKED evidence in the same workspace", async () => {
    const client = makeWorld({
      links: [],
      evidenceLegalHolds: [
        activeCanonical({ scope: "CASE", evidenceId: null, caseId: CASE }),
      ],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(false);
  });

  it("an EVIDENCE-scoped hold does NOT block a DIFFERENT record", async () => {
    const client = makeWorld({
      evidence: [
        { id: EVIDENCE, teamId: TEAM },
        { id: EVIDENCE_B, teamId: TEAM },
      ],
      evidenceLegalHolds: [activeCanonical({ evidenceId: EVIDENCE })],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE_B })).held,
    ).toBe(false);
  });
});

// ===========================================================================
// 2 — FAIL CLOSED
// ===========================================================================

describe("PHASE 12B CLUSTER 8 — fail closed", () => {
  const transient = Object.assign(new Error("connection reset by peer"), {
    code: "P1001",
  });

  it("RETHROWS a transient failure on the evidence-direct clause", async () => {
    const client = makeWorld({ options: { failOn: { evidenceLegalHold: transient } } });
    await expect(
      evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE }),
    ).rejects.toThrow(/connection reset/);
  });

  it("RETHROWS a transient failure on the canonical scope clause", async () => {
    const client = makeWorld({
      links: [{ evidenceId: EVIDENCE, caseId: CASE }],
      options: { failOn: { evidenceLegalHold: transient } },
    });
    await expect(
      evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE }),
    ).rejects.toThrow(/connection reset/);
  });

  it("RETHROWS a transient failure on the canonical evidence clause", async () => {
    const client = makeWorld({ options: { failOn: { evidenceLegalHold: transient } } });
    await expect(
      evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE }),
    ).rejects.toThrow(/connection reset/);
  });

  it("RETHROWS a transient failure resolving linked cases", async () => {
    const client = makeWorld({ options: { failOn: { caseEvidenceLink: transient } } });
    await expect(
      evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE }),
    ).rejects.toThrow(/connection reset/);
  });

  it("degrades ONLY on a genuinely absent relation (P2021 / P2022 / does not exist)", () => {
    expect(isAbsentRelationError(Object.assign(new Error("x"), { code: "P2021" }))).toBe(true);
    expect(isAbsentRelationError(Object.assign(new Error("x"), { code: "P2022" }))).toBe(true);
    expect(isAbsentRelationError(new Error('relation "legal_holds" does not exist'))).toBe(true);
    expect(isAbsentRelationError(transient)).toBe(false);
    expect(isAbsentRelationError(new Error("timeout"))).toBe(false);
  });

  it("an unreadable canonical store is NEVER read as 'not held'", async () => {
    // Pre-cutover an absent OPTIONAL legacy relation was allowed to degrade.
    // With one store there is nothing to degrade to: if the hold table cannot
    // be read, the destructive gate must refuse rather than report a clear
    // record. Anything else makes held evidence destructible.
    const absent = Object.assign(new Error("relation does not exist"), { code: "P2021" });
    const client = makeWorld({
      evidenceLegalHolds: [activeCanonical()],
      options: { failOn: { evidenceLegalHold: absent } },
    });
    await expect(
      evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// 3 — NO EVIDENCE BECOMES DESTRUCTIBLE
// ===========================================================================

describe("PHASE 12B CLUSTER 8 — no evidence becomes destructible", () => {
  it("every hold shape that blocked before the convergence still blocks", async () => {
    const shapes: Array<{ label: string; seed: Parameters<typeof makeWorld>[0] }> = [
      {
        label: "legacy evidence-direct (pre-canonical row shape)",
        seed: {
          evidenceLegalHolds: [
            { id: "legacy-1", teamId: TEAM, evidenceId: EVIDENCE, status: "ACTIVE" },
          ],
        },
      },
      {
        label: "legacy case hold on a linked case",
        seed: {
          links: [{ evidenceId: EVIDENCE, caseId: CASE }],
          evidenceLegalHolds: [
        activeCanonical({
          id: "clh-1",
          scope: "CASE",
          caseId: CASE,
          evidenceId: null,
          sourceStore: "CASE_LEGAL_HOLD",
        }),
      ],
        },
      },
      {
        label: "lifecycle WORKSPACE hold",
        seed: {
          evidenceLegalHolds: [
            activeCanonical({
              id: "lh-1",
              scope: "WORKSPACE",
              evidenceId: null,
              sourceStore: "LIFECYCLE_LEGAL_HOLD",
            }),
          ],
        },
      },
      {
        label: "lifecycle ORGANIZATION hold",
        seed: {
          // The legacy ORGANIZATION kind was folded into WORKSPACE scope.
          evidenceLegalHolds: [
            activeCanonical({
              id: "lh-2",
              scope: "WORKSPACE",
              evidenceId: null,
              sourceStore: "LIFECYCLE_LEGAL_HOLD",
            }),
          ],
        },
      },
      {
        label: "lifecycle CASE hold on a linked case",
        seed: {
          links: [{ evidenceId: EVIDENCE, caseId: CASE }],
          evidenceLegalHolds: [
            activeCanonical({
              id: "lh-3",
              scope: "CASE",
              caseId: CASE,
              evidenceId: null,
              sourceStore: "LIFECYCLE_LEGAL_HOLD",
            }),
          ],
        },
      },
      {
        label: "canonical CASE-scope hold",
        seed: {
          links: [{ evidenceId: EVIDENCE, caseId: CASE }],
          evidenceLegalHolds: [
            activeCanonical({ scope: "CASE", evidenceId: null, caseId: CASE }),
          ],
        },
      },
    ];

    for (const shape of shapes) {
      const client = makeWorld(shape.seed);
      const r = await evaluateEffectiveLegalHold(client, {
        teamId: TEAM,
        evidenceId: EVIDENCE,
      });
      expect(r.held, `${shape.label} must still block`).toBe(true);
    }
  });

  it("a hold on ANY linked case blocks, even when another linked case is free", async () => {
    const OTHER_CASE = "3b3b3b3b-3333-4333-8333-333333333333";
    const client = makeWorld({
      links: [
        { evidenceId: EVIDENCE, caseId: OTHER_CASE },
        { evidenceId: EVIDENCE, caseId: CASE },
      ],
      evidenceLegalHolds: [
        activeCanonical({
          id: "clh-1",
          scope: "CASE",
          caseId: CASE,
          evidenceId: null,
          sourceStore: "CASE_LEGAL_HOLD",
        }),
      ],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(true);
  });

  it("MOST PROTECTIVE WINS — one RELEASED source cannot unblock an ACTIVE one", async () => {
    const client = makeWorld({
      // One RELEASED row and one ACTIVE row on the SAME record. The released
      // one must not unblock the active one.
      evidenceLegalHolds: [
        activeCanonical({ status: "RELEASED" }),
        activeCanonical({
          id: "lh-1",
          scope: "EVIDENCE",
          evidenceId: EVIDENCE,
          sourceStore: "LIFECYCLE_LEGAL_HOLD",
        }),
      ],
    });
    const r = await evaluateEffectiveLegalHold(client, {
      teamId: TEAM,
      evidenceId: EVIDENCE,
    });
    // The RELEASED row must not unblock the ACTIVE one.
    expect(r.held).toBe(true);
    expect(r.sources).toEqual(["EVIDENCE_LEGAL_HOLD"]);
  });

  it("a workspace hold in ANOTHER tenant never reaches this evidence", async () => {
    const client = makeWorld({
      evidenceLegalHolds: [
        activeCanonical({
          teamId: OTHER_TEAM,
          scope: "WORKSPACE",
          evidenceId: null,
        }),
        activeCanonical({
          id: "lh-1",
          teamId: OTHER_TEAM,
          scope: "WORKSPACE",
          evidenceId: null,
          sourceStore: "LIFECYCLE_LEGAL_HOLD",
        }),
      ],
    });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(false);
  });
});

// ===========================================================================
// 4 — PLACEMENT / RELEASE COMMANDS
// ===========================================================================

describe("PHASE 12B CLUSTER 8 — one placement command", () => {
  it("writes an EVIDENCE-scoped canonical row", async () => {
    const client = makeWorld({});
    const hold = await placeCanonicalLegalHold(
      {
        teamId: TEAM,
        scope: "EVIDENCE",
        evidenceId: EVIDENCE,
        actorUserId: USER,
        title: "Litigation",
      },
      client,
    );
    expect(hold.scope).toBe("EVIDENCE");
    expect(hold.evidenceId).toBe(EVIDENCE);
    expect(hold.version).toBe(1);
    // The hold it just wrote must be visible to the gate immediately.
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(true);
  });

  it("writes a CASE-scoped row that protects every linked record", async () => {
    const client = makeWorld({
      links: [
        { evidenceId: EVIDENCE, caseId: CASE },
        { evidenceId: EVIDENCE_B, caseId: CASE },
      ],
      evidence: [
        { id: EVIDENCE, teamId: TEAM },
        { id: EVIDENCE_B, teamId: TEAM },
      ],
    });
    await placeCanonicalLegalHold(
      { teamId: TEAM, scope: "CASE", caseId: CASE, actorUserId: USER, title: "Matter hold" },
      client,
    );
    for (const id of [EVIDENCE, EVIDENCE_B]) {
      expect(
        (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: id })).held,
        `${id} must be protected by the case hold`,
      ).toBe(true);
    }
  });

  it("requires a target for a scoped hold", async () => {
    const client = makeWorld({});
    await expect(
      placeCanonicalLegalHold(
        { teamId: TEAM, scope: "EVIDENCE", actorUserId: USER, title: "x" },
        client,
      ),
    ).rejects.toMatchObject({ code: "scope_target_required" });
    await expect(
      placeCanonicalLegalHold(
        { teamId: TEAM, scope: "CASE", actorUserId: USER, title: "x" },
        client,
      ),
    ).rejects.toMatchObject({ code: "scope_target_required" });
  });

  it("DENIES a cross-workspace target (evidence and case)", async () => {
    const client = makeWorld({
      evidence: [{ id: EVIDENCE, teamId: OTHER_TEAM }],
      cases: [{ id: CASE, teamId: OTHER_TEAM }],
    });
    await expect(
      placeCanonicalLegalHold(
        { teamId: TEAM, scope: "EVIDENCE", evidenceId: EVIDENCE, actorUserId: USER, title: "x" },
        client,
      ),
    ).rejects.toMatchObject({ code: "target_not_in_workspace", statusCode: 404 });
    await expect(
      placeCanonicalLegalHold(
        { teamId: TEAM, scope: "CASE", caseId: CASE, actorUserId: USER, title: "x" },
        client,
      ),
    ).rejects.toMatchObject({ code: "target_not_in_workspace", statusCode: 404 });
  });

  it("binds organizationId to the TARGET workspace's organization, never the caller's input", async () => {
    const ORG = "55555555-5555-4555-8555-555555555555";
    const client = makeWorld({ teams: [{ id: TEAM, organizationId: ORG }] });
    const hold = await placeCanonicalLegalHold(
      { teamId: TEAM, scope: "EVIDENCE", evidenceId: EVIDENCE, actorUserId: USER, title: "x" },
      client,
    );
    expect(hold.organizationId).toBe(ORG);
    // A personal workspace resolves to no organization rather than guessing.
    const personal = makeWorld({ teams: [{ id: TEAM, organizationId: null }] });
    const hold2 = await placeCanonicalLegalHold(
      { teamId: TEAM, scope: "EVIDENCE", evidenceId: EVIDENCE, actorUserId: USER, title: "x" },
      personal,
    );
    expect(hold2.organizationId).toBeNull();
  });

  it("never writes a CASE tag onto an EVIDENCE-scoped hold", async () => {
    const client = makeWorld({});
    const hold = await placeCanonicalLegalHold(
      { teamId: TEAM, scope: "EVIDENCE", evidenceId: EVIDENCE, caseId: CASE, actorUserId: USER, title: "x" },
      client,
    );
    // The canonical model reserves case_id for scope='CASE' so the strict form
    // of the scope/target CHECK can eventually be installed.
    expect(hold.caseId).toBeNull();
  });

  it("captures the release-approval gate ON the hold at placement time", async () => {
    const client = makeWorld({
      policies: [
        {
          teamId: TEAM,
          id: "pol-1",
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          requireLegalHoldReleaseApproval: true,
        },
      ],
    });
    const hold = await placeCanonicalLegalHold(
      { teamId: TEAM, scope: "EVIDENCE", evidenceId: EVIDENCE, actorUserId: USER, title: "x" },
      client,
    );
    expect(hold.releaseApprovalRequired).toBe(true);
    expect(hold.releaseApprovalState).toBe("PENDING");
    expect(hold.policyVersionAttribution).toMatch(/^wgp:pol-1@/);
  });
});

describe("PHASE 12B CLUSTER 8 — one release command", () => {
  let client: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    client = makeWorld({ evidenceLegalHolds: [activeCanonical()] });
  });

  it("requires a release note", async () => {
    await expect(
      releaseCanonicalLegalHold(
        { teamId: TEAM, holdId: "canon-1", actorUserId: USER, releaseNote: "   " },
        client,
      ),
    ).rejects.toMatchObject({ code: "release_note_required", statusCode: 422 });
  });

  it("DENIES releasing a hold in another workspace as NOT FOUND", async () => {
    await expect(
      releaseCanonicalLegalHold(
        { teamId: OTHER_TEAM, holdId: "canon-1", actorUserId: USER, releaseNote: "done" },
        client,
      ),
    ).rejects.toMatchObject({ code: "hold_not_found", statusCode: 404 });
    // ...and the hold is untouched — cross-tenant access cannot unblock.
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(true);
  });

  it("ENFORCES the approval gate for every scope", async () => {
    const gated = makeWorld({
      evidenceLegalHolds: [
        activeCanonical({
          releaseApprovalRequired: true,
          releaseApprovalState: "PENDING",
        }),
      ],
    });
    await expect(
      releaseCanonicalLegalHold(
        { teamId: TEAM, holdId: "canon-1", actorUserId: USER, releaseNote: "done" },
        gated,
      ),
    ).rejects.toMatchObject({ code: "release_approval_required", statusCode: 403 });
    // Still held.
    expect(
      (await evaluateEffectiveLegalHold(gated, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(true);
    // With an explicit acknowledgement the release proceeds and is attributed.
    const released = await releaseCanonicalLegalHold(
      {
        teamId: TEAM,
        holdId: "canon-1",
        actorUserId: USER,
        releaseNote: "approved by counsel",
        approvalAcknowledged: true,
      },
      gated,
    );
    expect(released.status).toBe("RELEASED");
    expect(released.releaseApprovalState).toBe("APPROVED");
    expect(released.releaseApprovedByUserId).toBe(USER);
  });

  it("REFUSES a stale release (optimistic concurrency, 409)", async () => {
    await expect(
      releaseCanonicalLegalHold(
        {
          teamId: TEAM,
          holdId: "canon-1",
          actorUserId: USER,
          releaseNote: "done",
          expectedVersion: 7,
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "stale_version", statusCode: 409 });
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(true);
  });

  it("bumps the version and stops blocking on a valid release", async () => {
    const released = await releaseCanonicalLegalHold(
      {
        teamId: TEAM,
        holdId: "canon-1",
        actorUserId: USER,
        releaseNote: "matter closed",
        expectedVersion: 1,
      },
      client,
    );
    expect(released.version).toBe(2);
    expect(released.releaseNote).toBe("matter closed");
    expect(
      (await evaluateEffectiveLegalHold(client, { teamId: TEAM, evidenceId: EVIDENCE })).held,
    ).toBe(false);
  });

  it("is idempotent on an already-released hold", async () => {
    const already = makeWorld({
      evidenceLegalHolds: [activeCanonical({ status: "RELEASED", version: 4 })],
    });
    const r = await releaseCanonicalLegalHold(
      { teamId: TEAM, holdId: "canon-1", actorUserId: USER, releaseNote: "again" },
      already,
    );
    expect(r.status).toBe("RELEASED");
    expect(r.version).toBe(4);
  });
});

// ===========================================================================
// 5 — STEP-UP ON EVERY SURFACE
// ===========================================================================

describe("PHASE 12B CLUSTER 8 — step-up on every legal-hold surface", () => {
  const governance = readFile(path.join(REPO_API, "src/routes/governance.routes.ts"));
  const lifecycle = readFile(
    path.join(REPO_API, "src/routes/product-and-lifecycle.routes.ts"),
  );

  it("evidence place + release are step-up gated", () => {
    expect(governance).toMatch(/purpose: "LEGAL_HOLD_PLACE"/);
    expect(governance).toMatch(/purpose: "LEGAL_HOLD_RELEASE"/);
  });

  it("case place + release are step-up gated (both were not, before)", () => {
    const placeCount = (governance.match(/purpose: "LEGAL_HOLD_PLACE"/g) ?? []).length;
    const releaseCount = (governance.match(/purpose: "LEGAL_HOLD_RELEASE"/g) ?? []).length;
    expect(placeCount).toBeGreaterThanOrEqual(2);
    expect(releaseCount).toBeGreaterThanOrEqual(2);
  });

  it("lifecycle place + release are step-up gated", () => {
    expect(lifecycle).toMatch(/purpose: "LEGAL_HOLD_PLACE"/);
    expect(lifecycle).toMatch(/purpose: "LEGAL_HOLD_RELEASE"/);
  });

  it("every duplicate route delegates to the canonical authority", () => {
    expect(governance).toMatch(/governance\/legal-hold\.service\.js/);
    expect(lifecycle).toMatch(/governance\/legal-hold\.service\.js/);
  });
});

// ===========================================================================
// 6 — EVALUATOR MIRROR (api ↔ worker)
// ===========================================================================

describe("PHASE 12B CLUSTER 8 — mirrored evaluator", () => {
  it("the api and worker copies are byte-identical", () => {
    const api = readFile(
      path.join(REPO_API, "src/services/governance/effective-legal-hold.ts"),
    );
    const worker = readFile(
      path.join(REPO_ROOT, "services/worker/src/governance/effective-legal-hold.ts"),
    );
    expect(worker).toBe(api);
  });

  it("every destructive worker path uses the union evaluator", () => {
    const paths = [
      "services/worker/src/governance/destruction-orchestrator.worker.ts",
      "services/worker/src/governance/retention-reconciliation.worker.ts",
      "services/worker/src/processor.ts",
    ];
    for (const rel of paths) {
      const src = readFile(path.join(REPO_ROOT, rel));
      expect(src, `${rel} must call the union evaluator`).toMatch(
        /evaluateEffectiveLegalHold\(/,
      );
    }
  });

  it("closure preflight counts holds in the ONE canonical store", () => {
    // Account / workspace closure is irreversible, so its LEGAL_HOLD_ACTIVE
    // blocker must see every hold. Post-cutover that is one query: the
    // backfill converted both legacy stores into the canonical table, so
    // adding legacy counts on top would now DOUBLE-COUNT every converted row.
    const src = readFile(
      path.join(REPO_API, "src/services/identity/account-lifecycle-preflight.service.ts"),
    );
    expect(src).toMatch(/countActiveHoldsAllStores\(/);
    expect(src).toMatch(/prisma\.evidenceLegalHold\.count/);
    // No second store may reappear.
    expect(src).not.toMatch(/prisma\.caseLegalHold\./);
    expect(src).not.toMatch(/prisma\.legalHold\./);
    // All three call sites still go through the one counter.
    expect((src.match(/countActiveHoldsAllStores\(\{/g) ?? []).length).toBe(3);
  });

  it("the retention sweeper gates on the union evaluator", () => {
    const sweeper = readFile(
      path.join(REPO_API, "src/services/governance/retention-sweeper.service.ts"),
    );
    expect(sweeper).toMatch(/isEvidenceUnderAnyLegalHold\(/);
    // PHASE 12 POINT 3 — `isEvidenceUnderAnyLegalHold` moved out of the retired
    // governance/case-legal-hold.service.ts (deleted with the CaseLegalHold
    // model) into the ONE canonical authority. The invariant is unchanged: the
    // predicate must still delegate to the single effective-hold evaluator
    // rather than reading any store itself.
    const canonical = readFile(
      path.join(REPO_API, "src/services/governance/legal-hold.service.ts"),
    );
    expect(canonical).toMatch(
      /isEvidenceUnderAnyLegalHold[\s\S]{0,900}evaluateEffectiveLegalHold\(/,
    );
  });

  it("the api destructive gates use the union evaluator", () => {
    const paths = [
      "src/services/evidence/evidence-delete-eligibility.service.ts",
      "src/services/governance.service.ts",
      "src/services/lifecycle/legal-hold.service.ts",
      // PHASE 12 POINT 3 — governance/case-legal-hold.service.ts was deleted;
      // its surviving gate now lives in the canonical authority below.
      "src/services/governance/legal-hold.service.ts",
    ];
    for (const rel of paths) {
      expect(readFile(path.join(REPO_API, rel)), `${rel}`).toMatch(
        /evaluateEffectiveLegalHold\(/,
      );
    }
  });
});

// ===========================================================================
// 7 — MIGRATION (the ONE migration test; schema changed)
// ===========================================================================

describe("PHASE 12B CLUSTER 8 — migrations", () => {
  const canonical = readMigration("20271106000000_legal_hold_canonical");
  const backfill = readMigration("20271107000000_legal_hold_backfill");
  const removal = readMigration("20271108000000_legal_hold_legacy_removal");
  const schema = readFile(path.join(REPO_API, "prisma/schema.prisma"));

  it("the canonical migration DROPS nothing", () => {
    expect(canonical).not.toMatch(/DROP TABLE/i);
    expect(canonical).not.toMatch(/DROP COLUMN/i);
    expect(canonical).not.toMatch(/\bDELETE FROM\b/i);
  });

  it("adds every canonical column the model declares", () => {
    for (const col of [
      '"scope"',
      '"organization_id"',
      '"expires_at_utc"',
      '"release_approval_required"',
      '"release_approval_state"',
      '"release_approved_by_user_id"',
      '"policy_version_attribution"',
      '"version"',
      '"source_store"',
      '"source_row_id"',
      '"historical"',
    ]) {
      expect(canonical, `missing ADD COLUMN ${col}`).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });

  it("adds foreign keys NOT VALID then validates them", () => {
    expect(canonical).toMatch(/evidence_legal_holds_case_id_fkey[\s\S]*?NOT VALID/);
    expect(canonical).toMatch(/VALIDATE CONSTRAINT "evidence_legal_holds_case_id_fkey"/);
    expect(canonical).toMatch(/REFERENCES "cases"\("id"\)/);
    expect(canonical).toMatch(/REFERENCES "organizations"\("id"\)/);
  });

  it("constrains scope against the target columns", () => {
    expect(canonical).toMatch(/evidence_legal_holds_scope_target_chk/);
    expect(canonical).toMatch(/"scope" = 'EVIDENCE' AND "evidence_id" IS NOT NULL/);
    expect(canonical).toMatch(/"scope" = 'CASE' AND "case_id" IS NOT NULL AND "evidence_id" IS NULL/);
  });

  it("the WORKSPACE branch ASSERTS its authoritative workspace target", () => {
    // A WORKSPACE hold identified only by two NULLs is not acceptable — the
    // constraint must name what the hold targets.
    expect(canonical).toMatch(
      /"scope" = 'WORKSPACE' AND "team_id" IS NOT NULL AND "evidence_id" IS NULL AND "case_id" IS NULL/,
    );
  });

  it("the EXPAND step installs the RELAXED EVIDENCE branch unconditionally", () => {
    // PHASE 12 POINT 6 — this used to MEASURE the tag population and install
    // the STRICT form whenever it happened to find zero tagged rows. That was
    // a latent production outage: this migration runs BEFORE the cutover, and
    // the still-deployed build passes a caller-supplied `caseId` straight into
    // an EVIDENCE-scoped create, so the next case-contextual legal hold would
    // have been rejected by the database. Proven by counterfactual against a
    // clean Release-A PostgreSQL 16 in the Point-6 rehearsal.
    //
    // The expand step must therefore contain NO conditional branch selection.
    expect(canonical).not.toMatch(/IF tagged_evidence_rows = 0 THEN/);
    expect(canonical).not.toMatch(
      /'\("scope" = ''EVIDENCE'' AND "evidence_id" IS NOT NULL AND "case_id" IS NULL\)'/,
    );
    // It still MEASURES the population and reports it, so the tag never
    // becomes invisible.
    expect(canonical).toMatch(
      /SELECT count\(\*\) INTO tagged_evidence_rows[\s\S]*?"scope" = 'EVIDENCE' AND "case_id" IS NOT NULL/,
    );
    // And it never blanks the column to make a constraint pass.
    expect(canonical).not.toMatch(/UPDATE "evidence_legal_holds"\s+SET "case_id" = NULL/);
    const report = readFile(
      path.join(REPO_API, "scripts/legal-hold-convergence-report.mjs"),
    );
    expect(report).toContain("EVIDENCE_WITH_CASE_TAG");
  });

  it("the strict EVIDENCE rule is a POST-CUTOVER contract that refuses rather than blanking", () => {
    const strict = readMigration("20271118000000_legal_hold_strict_scope_target");
    // It installs the strict branch...
    expect(strict).toMatch(
      /"scope" = 'EVIDENCE' AND "evidence_id" IS NOT NULL AND "case_id" IS NULL/,
    );
    // ...only when zero contextual tags remain, and it RAISES otherwise.
    expect(strict).toMatch(/scope" = 'EVIDENCE' AND "case_id" IS NOT NULL/);
    expect(strict).toMatch(/REFUSING to tighten the legal-hold scope\/target CHECK/);
    // It must never blank the tag, and must never drop a table, column or row.
    expect(strict).not.toMatch(/SET "?case_id"? = NULL/);
    expect(strict).not.toMatch(/DROP TABLE/i);
    expect(strict).not.toMatch(/DROP COLUMN/i);
    expect(strict).not.toMatch(/\bDELETE FROM\b/i);
  });

  it("the historical CHECK exemption is discharged by a fail-closed evaluator", () => {
    // The constraint lets a historical row skip every scope/target rule; the
    // evaluator must therefore treat an ACTIVE one as HELD.
    expect(canonical).toMatch(/"historical" = true/);
    const evaluator = readFile(
      path.join(REPO_API, "src/services/governance/effective-legal-hold.ts"),
    );
    expect(evaluator).toMatch(/\{ historical: true \}/);
    expect(evaluator).toMatch(/UNRESOLVED_HOLD/);
  });

  it("the backfill asserts the organization binding matches the workspace", () => {
    expect(backfill).toMatch(/organization_id" IS DISTINCT FROM t\."organization_id"/);
    expect(backfill).toMatch(/RAISE EXCEPTION 'legal-hold backfill produced % row\(s\) whose organization_id/);
  });

  it("declares the deterministic idempotency key", () => {
    expect(canonical).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "evidence_legal_holds_source_store_source_row_id_key"/,
    );
    expect(schema).toMatch(/@@unique\(\[sourceStore, sourceRowId\]/);
  });

  it("EXPIRED is added in the canonical migration and only USED in the backfill", () => {
    expect(canonical).toMatch(/ALTER TYPE "LegalHoldStatus" ADD VALUE IF NOT EXISTS 'EXPIRED'/);
    expect(canonical).not.toMatch(/'EXPIRED'::"LegalHoldStatus"/);
    expect(backfill).toMatch(/'EXPIRED'::"LegalHoldStatus"/);
  });

  it("the backfill is INSERT-only — it never mutates or deletes a legacy row", () => {
    expect(backfill).not.toMatch(/\bDELETE FROM\b/i);
    expect(backfill).not.toMatch(/\bDROP TABLE\b/i);
    expect(backfill).not.toMatch(/UPDATE "case_legal_holds"/i);
    expect(backfill).not.toMatch(/UPDATE "legal_holds"/i);
  });

  it("the backfill is idempotent on the deterministic key", () => {
    const guards = backfill.match(/NOT EXISTS \(\s*SELECT 1 FROM "evidence_legal_holds" x/g) ?? [];
    expect(guards.length).toBe(2);
    expect(backfill).toMatch(/x\."source_store" = 'CASE_LEGAL_HOLD'/);
    expect(backfill).toMatch(/x\."source_store" = 'LIFECYCLE_LEGAL_HOLD'/);
  });

  it("the backfill REFUSES cross-workspace merges", () => {
    expect(backfill).toMatch(/c\."team_id" IS NOT DISTINCT FROM h\."team_id"/);
    expect(backfill).toMatch(/e\."team_id" IS NOT DISTINCT FROM h\."team_id"/);
  });

  it("the backfill preserves orphans as HISTORICAL rather than dropping them", () => {
    expect(backfill).toMatch(/\(c\."id" IS NULL\)/);
    expect(backfill).toMatch(/h\."kind" = 'EVIDENCE' AND e\."id" IS NULL/);
  });

  it("an unrecognised legacy state converges to ACTIVE, never RELEASED", () => {
    expect(backfill).toMatch(/ELSE 'ACTIVE'::"LegalHoldStatus"/);
  });

  it("the backfill captures the release-approval gate on converted ACTIVE holds", () => {
    expect(backfill).toMatch(/require_legal_hold_release_approval/);
    expect(backfill).toMatch(/'PENDING'::"LegalHoldReleaseApprovalState"/);
  });

  it("the legacy-removal migration is gated and refuses on any residual", () => {
    expect(removal).toMatch(/DO NOT APPLY THIS MIGRATION YET/);
    expect(removal).toMatch(/RAISE EXCEPTION/);
    expect(removal).toMatch(/REFUSING to drop legacy legal-hold stores/);
    // The guard must run BEFORE any DROP.
    expect(removal.indexOf("RAISE EXCEPTION")).toBeLessThan(
      removal.indexOf("DROP TABLE"),
    );
  });

  it("the readiness report is READ-ONLY", () => {
    const report = readFile(
      path.join(REPO_API, "scripts/legal-hold-convergence-report.mjs"),
    );
    expect(report).not.toMatch(/\$executeRaw/);
    expect(report).not.toMatch(/\bINSERT INTO\b/);
    expect(report).not.toMatch(/\bUPDATE \b/);
    expect(report).not.toMatch(/\bDELETE FROM\b/);
    // It must measure PROTECTION, not bookkeeping.
    expect(report).toMatch(/protectedEvidenceCount/);
    // …and cover every conflict class the backfill handles.
    for (const cls of [
      "CASE_PROTECTS_LINKED",
      "ORPHAN_TARGET",
      "CROSS_WORKSPACE",
      "DUAL_STORE",
      "DUPLICATE_SEMANTIC",
      "RELEASE_NEEDS_APPROVAL",
      "DANGLING_CASE_REF",
      "EVIDENCE_WITH_CASE_TAG",
      "ORG_BINDING_MISMATCH",
      "UNRESOLVED_ACTIVE_HOLD",
    ]) {
      expect(report, `conflict class ${cls} missing`).toContain(cls);
    }
  });

  it("the readiness report exits non-zero on a blocking conflict", () => {
    const report = readFile(
      path.join(REPO_API, "scripts/legal-hold-convergence-report.mjs"),
    );
    expect(report).toMatch(/process\.exitCode = blocking > 0 \? 2 : 0/);
    expect(report).toMatch(/process\.exitCode = 1/);
    // PHASE 12 POINT 3 — the blocking set is now the explicit `closure` object
    // rather than a hand-summed list of `?.length` expressions, and it is the
    // SAME set the contract migration re-checks in the database. Pinning the
    // old expression shape would forbid that hardening; what matters is that
    // every cutover-blocking category is summed into `blocking`.
    for (const category of [
      "crossWorkspace",
      "orgBindingMismatch",
      "unconvertedSourceRows",
      "duplicateSourceMapping",
      "unresolvedActiveHolds",
      "releaseStateMismatch",
      "invalidTarget",
    ]) {
      expect(report, `closure category ${category} missing`).toMatch(
        new RegExp(`${category}:`),
      );
    }
    // A cross-tenant organization binding must still block the backfill.
    expect(report).toMatch(/ORG_BINDING_MISMATCH/);
    expect(report).toMatch(
      /const blocking = Object\.values\(report\.closure\)\.reduce/,
    );
  });
});

// ===========================================================================
// 9 — STEP-UP BEHAVIORAL ACCEPTANCE (PHASE 12B)
//
// The prior step-up coverage in this file (section 5) proves WIRING: that the
// legal-hold surfaces name a step-up purpose. It never drove the gate. This
// section drives the REAL `requireStepUpForSensitiveAction` over an in-memory
// challenge store and pins the end-to-end contract the Evidence Operations
// consoles depend on:
//
//   * the denial body is the STRUCTURED shape `useStepUpAction` recognises,
//     so the challenge modal actually opens (a body without `message` was
//     re-coded as plain UNAUTHORIZED and the modal never appeared);
//   * the client starts the challenge from the PARSED apiFetch body (apiFetch
//     has no `.json()` — calling one aborted the flow before it began);
//   * verification retries the ORIGINAL action with the challenge header;
//   * CORS permits that header, or the retry never leaves the browser;
//   * a valid challenge mutates EXACTLY ONCE;
//   * replay / expiry / wrong-purpose / wrong-user / wrong-target are all
//     denied, each with ZERO mutation.
//
// WHAT IS MOCKED: the Prisma transport for `stepUpChallenge` / `riskSignal` /
// `securityEvent`. The authority under proof — the middleware and the real
// `consumeApprovedChallenge` single-use consume — is production code.
// ===========================================================================

const STEP_UP_HEADER_NAME = "x-proovra-step-up-challenge-id";
const SU_CHALLENGE = "55555555-5555-4555-8555-555555555555";
const SU_TARGET = "66666666-6666-4666-8666-666666666666";
const SU_PURPOSE = "DEPARTMENT_MEMBERSHIP_GRANT";
const SU_RESOURCE_KIND = "DEPARTMENT";
/**
 * PHASE 13 (NEW-058) — the factor the approval is bound to.
 *
 * The consume path refuses a challenge whose `factorId`/`factorGeneration` is
 * null, and refuses again if no ACTIVE, verified, unrevoked factor at that
 * generation still exists. A fixture without both therefore fails closed, and
 * every acceptance below would measure the refusal instead of the behaviour.
 */
const SU_FACTOR = "99999999-9999-4999-8999-999999999991";
const SU_FACTOR_GENERATION = 1;

type ChallengeRow = {
  id: string;
  teamId: string;
  initiatedByUserId: string;
  status: string;
  purpose: string;
  resourceKind: string | null;
  resourceId: string | null;
  expiresAtUtc: Date;
  factorId: string | null;
  factorGeneration: number | null;
};

/** Reply double capturing exactly what the middleware sent. */
function makeStepUpReply() {
  const captured: { statusCode: number | null; body: unknown } = {
    statusCode: null,
    body: null,
  };
  const reply = {
    code(status: number) {
      captured.statusCode = status;
      return reply;
    },
    send(body: unknown) {
      captured.body = body;
      return reply;
    },
    captured,
  };
  return reply;
}

/**
 * In-memory step-up world. `mutations` counts writes performed by the guarded
 * action, so "exactly once" / "zero on denial" are measured, not assumed.
 */
function makeStepUpWorld(seed: Partial<ChallengeRow> = {}) {
  const row: ChallengeRow = {
    id: SU_CHALLENGE,
    teamId: TEAM,
    initiatedByUserId: USER,
    status: "APPROVED",
    purpose: SU_PURPOSE,
    resourceKind: SU_RESOURCE_KIND,
    resourceId: SU_TARGET,
    expiresAtUtc: new Date(Date.now() + 10 * 60_000),
    factorId: SU_FACTOR,
    factorGeneration: SU_FACTOR_GENERATION,
    ...seed,
  };
  const rows: ChallengeRow[] = [row];
  const mutations: Array<Record<string, unknown>> = [];
  /**
   * The factor the challenge above is bound to. Held as a row and matched with
   * the same predicate helper as everything else, so a revoked factor or a
   * bumped generation genuinely stops matching rather than being waved through
   * by a delegate that always answers.
   */
  const factors: Row[] = [
    {
      id: SU_FACTOR,
      userId: USER,
      status: "ACTIVE",
      revokedAt: null,
      verifiedAtUtc: new Date(Date.now() - 86_400_000),
      generation: SU_FACTOR_GENERATION,
    },
  ];

  const client = {
    stepUpChallenge: {
      findFirst: async (args: { where: Row }) =>
        rows.find((r) => matchesWhere(r as unknown as Row, args.where)) ?? null,
      findUniqueOrThrow: async (args: { where: Row }) => {
        const found = rows.find((r) =>
          matchesWhere(r as unknown as Row, args.where),
        );
        if (!found) throw new Error("challenge row missing");
        return found;
      },
      update: async (args: { where: Row; data: Row }) => {
        const found = rows.find((r) =>
          matchesWhere(r as unknown as Row, args.where),
        );
        if (found) Object.assign(found, args.data);
        return found;
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        const matched = rows.filter((r) =>
          matchesWhere(r as unknown as Row, args.where),
        );
        for (const m of matched) Object.assign(m, args.data);
        return { count: matched.length };
      },
    },
    mfaFactor: {
      findFirst: async (args: { where: Row }) =>
        factors.find((f) => matchesWhere(f, args.where)) ?? null,
    },
    // No risk signals => LOW risk => the gate never blocks for risk here.
    riskSignal: { findMany: async () => [] },
    securityEvent: { create: async () => ({ id: "security-event" }) },
  };
  return { client, rows, mutations, factors };
}

/**
 * The canonical route shape: authorize (assumed done), THEN step-up, THEN
 * mutate. The write is recorded ONLY past the gate, so the mutation log is a
 * direct measurement of "zero partial mutation".
 */
async function runGuardedMutation(
  world: ReturnType<typeof makeStepUpWorld>,
  opts: {
    header?: string;
    purpose?: string;
    userId?: string;
    resourceKind?: string | null;
    resourceId?: string | null;
  } = {},
) {
  const { requireStepUpForSensitiveAction } = await import(
    "../src/services/identity-security/step-up-middleware.js"
  );
  const reply = makeStepUpReply();
  const req = {
    headers: opts.header ? { [STEP_UP_HEADER_NAME]: opts.header } : {},
  };
  const outcome = await requireStepUpForSensitiveAction(
    {
      req: req as unknown as Parameters<
        typeof requireStepUpForSensitiveAction
      >[0]["req"],
      reply: reply as unknown as Parameters<
        typeof requireStepUpForSensitiveAction
      >[0]["reply"],
      teamId: TEAM,
      userId: opts.userId ?? USER,
      purpose: (opts.purpose ?? SU_PURPOSE) as Parameters<
        typeof requireStepUpForSensitiveAction
      >[0]["purpose"],
      resourceKind:
        opts.resourceKind === undefined ? SU_RESOURCE_KIND : opts.resourceKind,
      resourceId: opts.resourceId === undefined ? SU_TARGET : opts.resourceId,
    },
    world.client as unknown as Parameters<
      typeof requireStepUpForSensitiveAction
    >[1],
  );
  if (!outcome.sent) {
    world.mutations.push({ state: "ACTIVE", at: "granted" });
  }
  return { outcome, reply: reply.captured, mutations: world.mutations };
}

const OTHER_USER = "4b4b4b4b-4444-4444-8444-444444444444";
const OTHER_TARGET = "6b6b6b6b-6666-4666-8666-666666666666";

describe("PHASE 12B — step-up behavioral acceptance", () => {
  it("a missing challenge returns the STRUCTURED 401 the modal opens on", async () => {
    const world = makeStepUpWorld();
    const { outcome, reply, mutations } = await runGuardedMutation(world);

    expect(outcome.sent).toBe(true);
    expect(reply.statusCode).toBe(401);
    const body = reply.body as {
      error: {
        code: string;
        message?: string;
        details?: {
          purpose?: string;
          resourceKind?: string | null;
          resourceId?: string | null;
        };
      };
    };
    // `useStepUpAction` keys off code + 401; the client normalizer only treats
    // the body as structured when `message` is present.
    expect(body.error.code).toBe("STEP_UP_REQUIRED");
    expect(typeof body.error.message).toBe("string");
    expect((body.error.message ?? "").length).toBeGreaterThan(0);
    // The modal needs the purpose + resource to start a MATCHING challenge.
    expect(body.error.details?.purpose).toBe(SU_PURPOSE);
    expect(body.error.details?.resourceKind).toBe(SU_RESOURCE_KIND);
    expect(body.error.details?.resourceId).toBe(SU_TARGET);
    // ZERO MUTATION on denial.
    expect(mutations).toHaveLength(0);
  });

  it("the client detects that exact shape and opens the modal", () => {
    const modal = readFile(
      path.join(
        REPO_ROOT,
        "apps/web/components/identity-security/StepUpModal.tsx",
      ),
    );
    // Detection is code + status, never a message-text match.
    expect(modal).toMatch(/e\.code === "STEP_UP_REQUIRED"/);
    expect(modal).toMatch(/e\.statusCode === 401/);
    // Detection drives the modal state machine.
    expect(modal).toMatch(/kind: "starting"/);
  });

  it("the challenge starts from the PARSED apiFetch body (never .json())", () => {
    const modal = readFile(
      path.join(
        REPO_ROOT,
        "apps/web/components/identity-security/StepUpModal.tsx",
      ),
    );
    expect(modal).toMatch(/\/v1\/identity-security\/step-up\/start/);
    expect(modal).toMatch(/\/v1\/identity-security\/step-up\/check/);
    // apiFetch resolves the PARSED body and throws on non-2xx — it has no
    // `.json()`. Calling one threw a TypeError the catch mislabelled as
    // "could not start challenge", so the flow could never begin.
    // Anchored on a RECEIVER (`)` or an identifier char) so the prose that
    // documents this rule — which writes it as `` `.json()` `` — is not
    // mistaken for a call site.
    expect(modal).not.toMatch(/[\w)]\.json\(\)/);
    expect(modal).toMatch(/json\.challenge\.id/);
  });

  it("verification retries the ORIGINAL action with the challenge header", () => {
    const modal = readFile(
      path.join(
        REPO_ROOT,
        "apps/web/components/identity-security/StepUpModal.tsx",
      ),
    );
    // The retry invokes the SAME captured action, with the header injected.
    expect(modal).toMatch(/pendingActionRef\.current/);
    expect(modal).toMatch(/"x-proovra-step-up-challenge-id": state\.challengeId/);
    // Exactly once — no retry loop.
    expect((modal.match(/await action\(\{/g) ?? []).length).toBe(1);
  });

  it("CORS permits the step-up challenge header", () => {
    const server = readFile(path.join(REPO_API, "src/server.ts"));
    const allowed = server.slice(server.indexOf("allowedHeaders"));
    expect(allowed).toContain(STEP_UP_HEADER_NAME);
  });

  it("a valid challenge mutates EXACTLY ONCE and consumes the challenge", async () => {
    const world = makeStepUpWorld();
    const { outcome, mutations } = await runGuardedMutation(world, {
      header: SU_CHALLENGE,
    });

    expect(outcome.sent).toBe(false);
    if (!outcome.sent) {
      // The route records the SERVER-VERIFIED id, never the raw header.
      expect(outcome.verifiedChallengeId).toBe(SU_CHALLENGE);
    }
    expect(mutations).toHaveLength(1);
    // Single-use: the row is no longer APPROVED.
    expect(world.rows[0]?.status).not.toBe("APPROVED");
  });

  it("REPLAY of a consumed challenge is denied with zero further mutation", async () => {
    const world = makeStepUpWorld();
    const first = await runGuardedMutation(world, { header: SU_CHALLENGE });
    expect(first.outcome.sent).toBe(false);
    expect(world.mutations).toHaveLength(1);

    const replay = await runGuardedMutation(world, { header: SU_CHALLENGE });
    expect(replay.outcome.sent).toBe(true);
    expect(replay.reply.statusCode).toBe(401);
    // Still exactly one mutation in total — the replay changed nothing.
    expect(world.mutations).toHaveLength(1);
  });

  it("an EXPIRED challenge is denied with zero mutation and is marked EXPIRED", async () => {
    const world = makeStepUpWorld({
      expiresAtUtc: new Date(Date.now() - 1_000),
    });
    const { outcome, reply, mutations } = await runGuardedMutation(world, {
      header: SU_CHALLENGE,
    });

    expect(outcome.sent).toBe(true);
    expect(reply.statusCode).toBe(401);
    expect(mutations).toHaveLength(0);
    expect(world.rows[0]?.status).toBe("EXPIRED");
  });

  it("a WRONG-PURPOSE challenge is denied with zero mutation", async () => {
    const world = makeStepUpWorld({ purpose: "LEGAL_HOLD_PLACE" });
    const { outcome, reply, mutations } = await runGuardedMutation(world, {
      header: SU_CHALLENGE,
    });

    expect(outcome.sent).toBe(true);
    expect(reply.statusCode).toBe(401);
    expect(mutations).toHaveLength(0);
    // An approval for a DIFFERENT action must stay unconsumed, not be burned.
    expect(world.rows[0]?.status).toBe("APPROVED");
  });

  it("a WRONG-USER challenge is denied with zero mutation", async () => {
    const world = makeStepUpWorld();
    const { outcome, reply, mutations } = await runGuardedMutation(world, {
      header: SU_CHALLENGE,
      userId: OTHER_USER,
    });

    expect(outcome.sent).toBe(true);
    expect(reply.statusCode).toBe(401);
    expect(mutations).toHaveLength(0);
    expect(world.rows[0]?.status).toBe("APPROVED");
  });

  it("a WRONG-TARGET challenge is denied with zero mutation", async () => {
    const world = makeStepUpWorld();
    const { outcome, reply, mutations } = await runGuardedMutation(world, {
      header: SU_CHALLENGE,
      resourceId: OTHER_TARGET,
    });

    expect(outcome.sent).toBe(true);
    expect(reply.statusCode).toBe(401);
    expect(mutations).toHaveLength(0);
    expect(world.rows[0]?.status).toBe("APPROVED");
  });

  it("a challenge from ANOTHER workspace is denied with zero mutation", async () => {
    const world = makeStepUpWorld({ teamId: OTHER_TEAM });
    const { outcome, reply, mutations } = await runGuardedMutation(world, {
      header: SU_CHALLENGE,
    });

    expect(outcome.sent).toBe(true);
    expect(reply.statusCode).toBe(401);
    expect(mutations).toHaveLength(0);
    expect(world.rows[0]?.status).toBe("APPROVED");
  });

  it("the Evidence-Operations department mutations are step-up gated", () => {
    const routes = readFile(
      path.join(REPO_API, "src/routes/trust-and-governance.routes.ts"),
    );
    expect(routes).toMatch(/purpose: "DEPARTMENT_MEMBERSHIP_GRANT"/);
    expect(routes).toMatch(/purpose: "DEPARTMENT_MEMBERSHIP_REVOKE"/);
    // Step-up must sit AFTER authorization and BEFORE the service write.
    const grantIdx = routes.indexOf('purpose: "DEPARTMENT_MEMBERSHIP_GRANT"');
    const grantWriteIdx = routes.indexOf("grantDepartmentMembership({");
    expect(grantIdx).toBeGreaterThan(-1);
    expect(grantWriteIdx).toBeGreaterThan(grantIdx);
    const revokeIdx = routes.indexOf('purpose: "DEPARTMENT_MEMBERSHIP_REVOKE"');
    const revokeWriteIdx = routes.indexOf("revokeDepartmentMembership({");
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(revokeWriteIdx).toBeGreaterThan(revokeIdx);
  });

  it("the departments console hosts the modal and sends the observed state", () => {
    const page = readFile(
      path.join(
        REPO_ROOT,
        "apps/web/app/(app)/governance-platform/departments/page.tsx",
      ),
    );
    expect(page).toMatch(/useStepUpAction\(\{ teamId \}\)/);
    expect(page).toMatch(/<StepUpModal control=\{stepUp\} \/>/);
    // Both mutations route THROUGH the step-up runner, spreading its headers.
    expect((page.match(/stepUp\.runStepUpAction\(/g) ?? []).length).toBe(2);
    expect((page.match(/\.\.\.\(headers \?\? \{\}\)/g) ?? []).length).toBe(2);
    // The stale-state guard travels with every mutation.
    expect((page.match(/expectedState/g) ?? []).length).toBeGreaterThanOrEqual(
      2,
    );
    // Revoke confirms before it sends.
    expect(page).toMatch(/await confirm\(\{/);
  });
});
