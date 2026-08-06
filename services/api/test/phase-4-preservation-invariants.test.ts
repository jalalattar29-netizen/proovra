/**
 * PHASE 4 (2026-07-22) — Evidence / Legal-Hold preservation invariants
 * (work-queue item 5).
 *
 * 1. NO closure path hard-deletes: workspace closure and organization
 *    closure REVOKE memberships (never erase), ARCHIVE orgs (never
 *    delete), and never touch the evidence/report/verification-package/
 *    legal-hold delegates at all.
 *
 * 2. LEGAL HOLD PREVAILS: all three lifecycle preflights carry the
 *    LEGAL_HOLD_ACTIVE blocker, and the closure workers re-run preflight
 *    AT EXECUTION TIME — a hold acquired during cooling-off moves the
 *    request to BLOCKED, never to PROCESSING (proven behaviorally for
 *    the workspace worker; the same worker pattern is source-pinned for
 *    account + organization).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  calls: [] as { model: string; method: string; args: unknown[] }[],
  dueClosures: [] as Record<string, unknown>[],
  preflightBlockers: [] as { code: string; message?: string }[],
}));

function makeTx(prefix = "") {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (...args: unknown[]) => {
                H.calls.push({ model: `${prefix}${model}`, method, args });
                if (model === "team" && method === "findMany")
                  return [{ id: "t1" }];
                if (model === "teamMember" && method === "findMany")
                  return [{ id: "m1" }, { id: "m2" }];
                if (model === "workspaceClosureRequest" && method === "findMany")
                  return H.dueClosures;
                if (method === "findFirst" || method === "findUnique")
                  return null;
                if (method === "findMany") return [];
                if (method === "updateMany") return { count: 1 };
                if (method === "create") return { id: "created-1" };
                if (method === "update") return { id: "updated-1" };
                return {};
              };
            },
          },
        );
      },
    },
  );
}

vi.mock("../src/db.js", () => {
  const base = makeTx();
  return {
    prisma: new Proxy(base as object, {
      get(t, prop: string) {
        if (prop === "$transaction") {
          return async (cb: (tx: unknown) => Promise<unknown>) =>
            cb(makeTx("tx."));
        }
        return (t as Record<string, unknown>)[prop];
      },
    }),
  };
});

vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async () => ({}),
}));

vi.mock(
  "../src/services/identity/account-lifecycle-preflight.service.js",
  () => ({
    evaluateWorkspaceClosurePreflight: async () => ({
      blockers: H.preflightBlockers,
    }),
    evaluateOrganizationClosurePreflight: async () => ({
      blockers: H.preflightBlockers,
    }),
    evaluateAccountClosurePreflight: async () => ({
      blockers: H.preflightBlockers,
    }),
  }),
);

import {
  executeWorkspaceClosure,
  processWorkspaceClosures,
} from "../src/services/workspace/workspace-closure.service.js";
import { executeOrganizationClosure } from "../src/services/organization/org-closure.service.js";

beforeEach(() => {
  H.calls = [];
  H.dueClosures = [];
  H.preflightBlockers = [];
});

const PROTECTED_DELEGATES = [
  "evidence",
  "report",
  "verificationPackage",
  "evidenceLegalHold",
];

function assertNeverDeletesNeverTouchesEvidence() {
  for (const delegate of PROTECTED_DELEGATES) {
    expect(
      H.calls.some((c) => c.model.endsWith(delegate)),
      `closure must never touch ${delegate}`,
    ).toBe(false);
  }
  expect(
    H.calls.some((c) => c.method === "delete" || c.method === "deleteMany"),
    "closure must never hard-delete anything",
  ).toBe(false);
}

describe("Phase 4 — closures preserve evidence structurally", () => {
  it("workspace closure: memberships REVOKED (never erased), evidence untouched, team row intact", async () => {
    await executeWorkspaceClosure({
      teamId: "t1",
      requestedByUserId: "owner-1",
    });
    assertNeverDeletesNeverTouchesEvidence();

    const memberMass = H.calls.find(
      (c) => c.model === "tx.teamMember" && c.method === "updateMany",
    );
    expect(
      (memberMass!.args[0] as { data: { status: string } }).data.status,
    ).toBe("REVOKED");

    // The Team row itself is never mutated by closure (no update at all).
    expect(
      H.calls.filter(
        (c) => c.model === "tx.team" && c.method !== "findMany",
      ),
    ).toEqual([]);
  });

  it("organization closure: org ARCHIVED (never deleted), memberships REVOKED, evidence untouched", async () => {
    await executeOrganizationClosure({
      organizationId: "o1",
      requestedByUserId: "owner-1",
    });
    assertNeverDeletesNeverTouchesEvidence();

    const orgUpdate = H.calls.find(
      (c) => c.model === "tx.organization" && c.method === "update",
    );
    expect(
      (orgUpdate!.args[0] as { data: { status: string } }).data.status,
    ).toBe("ARCHIVED");

    const memberMass = H.calls.find(
      (c) => c.model === "tx.teamMember" && c.method === "updateMany",
    );
    expect(
      (memberMass!.args[0] as { data: { status: string } }).data.status,
    ).toBe("REVOKED");
  });
});

describe("Phase 4 — Legal Hold prevails at execution time", () => {
  it("a hold acquired during cooling-off BLOCKS the due request (never PROCESSING)", async () => {
    H.dueClosures = [
      {
        id: "req-1",
        teamId: "t1",
        requestedByUserId: "owner-1",
        status: "COOLING_OFF",
      },
    ];
    H.preflightBlockers = [{ code: "LEGAL_HOLD_ACTIVE" }];

    await processWorkspaceClosures(new Date());

    const requestWrites = H.calls.filter(
      (c) =>
        c.model === "workspaceClosureRequest" && c.method === "updateMany",
    );
    expect(requestWrites.length).toBe(1);
    expect(
      (requestWrites[0].args[0] as { data: { status: string } }).data.status,
    ).toBe("BLOCKED");

    // The closure body never ran: no membership writes, no credential
    // revocation, nothing.
    expect(
      H.calls.some(
        (c) => c.model.endsWith("teamMember") && c.method === "updateMany",
      ),
    ).toBe(false);
    assertNeverDeletesNeverTouchesEvidence();
  });

  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

  it("all three preflights carry LEGAL_HOLD_ACTIVE; all three workers re-run preflight", () => {
    const preflight = readFileSync(
      join(
        ROOT,
        "services",
        "identity",
        "account-lifecycle-preflight.service.ts",
      ),
      "utf8",
    );
    expect(
      (preflight.match(/code: "LEGAL_HOLD_ACTIVE"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);

    for (const [file, evaluate] of [
      [
        join(ROOT, "services", "identity", "account-closure.service.ts"),
        "evaluateAccountClosurePreflight",
      ],
      [
        join(ROOT, "services", "organization", "org-closure.service.ts"),
        "evaluateOrganizationClosurePreflight",
      ],
      [
        join(ROOT, "services", "workspace", "workspace-closure.service.ts"),
        "evaluateWorkspaceClosurePreflight",
      ],
    ] as const) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain(evaluate);
      expect(src, file).toContain('status: "BLOCKED"');
    }
  });

  it("closure services never import evidence deletion surfaces (source contract)", () => {
    for (const file of [
      join(ROOT, "services", "identity", "account-closure.service.ts"),
      join(ROOT, "services", "organization", "org-closure.service.ts"),
      join(ROOT, "services", "workspace", "workspace-closure.service.ts"),
      join(ROOT, "services", "workspace", "workspace-lifecycle.service.ts"),
      join(ROOT, "services", "organization", "org-lifecycle.service.ts"),
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(
        /\.(evidence|report|verificationPackage|evidenceLegalHold)\.(delete|deleteMany|update|updateMany|create)/,
      );
    }
  });
});
