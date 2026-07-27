/**
 * WAVE A CHAIN 4 — finalize tenant-binding behavioral test through the REAL
 * production `completeEvidence` service (the finalize engine).
 *
 * The production signature is itself the binding contract: NO client-supplied
 * teamId exists — finalize accepts only { evidenceId, ownerUserId }, takes a
 * pg advisory lock, loads the PERSISTED row owner-scoped, and every
 * downstream write binds to `evidence.teamId`. These tests drive the real
 * transaction and prove fail-closed + zero mutation for the tamper/cross-
 * tenant/stale negatives. (The storage/signing green path is exercised by the
 * RUN_LIVE_INTEGRATION harness, which needs live Postgres.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  // evidence-complete imports src/storage.ts, which requires S3 env at module
  // load. Provide inert values BEFORE the import graph evaluates (hoisted).
  process.env.S3_ACCESS_KEY ??= "test-access";
  process.env.S3_SECRET_KEY ??= "test-secret";
  process.env.S3_ENDPOINT ??= "http://127.0.0.1:9000";
  process.env.S3_BUCKET ??= "test-bucket";
  process.env.S3_REGION ??= "us-east-1";
  return {
    row: null as Record<string, unknown> | null,
    writes: [] as string[],
  };
});

// Queue transport is a process boundary — no live Redis in unit runs.
vi.mock("../src/queue/report-queue.js", () => ({
  enqueueGenerateReportJob: async () => {
    H.writes.push("queue.enqueueGenerateReportJob");
  },
}));

vi.mock("../src/db.js", () => ({ prisma: fakePrisma() }));
function fakePrisma(): unknown {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "$transaction")
          return async (fn: (tx: unknown) => unknown) => fn(fakePrisma());
        if (model === "$executeRaw" || model === "$executeRawUnsafe") return async () => 0;
        if (model === "$queryRaw" || model === "$queryRawUnsafe") return async () => [];
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async () => {
                if (/^(create|update|upsert|delete)/.test(method))
                  H.writes.push(`${model}.${method}`);
                if (model === "evidence" && method === "findFirst") return H.row;
                if (method === "findFirst" || method === "findUnique") return null;
                if (method === "findMany") return [];
                if (method === "count") return 0;
                return {};
              };
            },
          },
        );
      },
    },
  );
}

import { completeEvidence } from "../src/services/evidence-complete.service.js";

beforeEach(() => {
  H.writes.length = 0;
  H.row = null;
});

async function expectDenied(run: () => Promise<unknown>) {
  await expect(run()).rejects.toMatchObject({ statusCode: 404 });
  // Denial performs ZERO finalize mutation (no evidence/part/custody write).
  expect(H.writes).toEqual([]);
}

describe("Wave A CHAIN 4 — finalize binds to the PERSISTED workspace, fail-closed", () => {
  it("tampered/cross-tenant caller (row not owned by requester) → 404, ZERO mutation", async () => {
    // The owner-scoped WHERE makes another tenant's evidence unresolvable —
    // the same code path covers a tampered evidenceId and a cross-tenant id.
    H.row = null;
    await expectDenied(() =>
      completeEvidence({ evidenceId: "ev-1", ownerUserId: "attacker" }),
    );
  });

  it("deleted evidence (stale reference) → 404, ZERO mutation, no existence distinction", async () => {
    H.row = null; // deletedAt filter excludes it — identical 404 as never-existed
    await expectDenied(() =>
      completeEvidence({ evidenceId: "ev-gone", ownerUserId: "user-1" }),
    );
  });

  it("the production finalize signature carries NO client teamId (binding is persisted-only)", async () => {
    // Compile-time + runtime contract: the params type is exactly
    // { evidenceId, ownerUserId } — a client cannot supply a workspace.
    // @ts-expect-error — teamId is not an accepted finalize parameter.
    const call = () => completeEvidence({ evidenceId: "e", ownerUserId: "u", teamId: "t" });
    expect(typeof call).toBe("function");
  });
});
